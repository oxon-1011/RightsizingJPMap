// 地図のアダプタ。MapLibre GL JS、pmtiles のプロトコル、deck.gl の MapboxOverlay を包む
// （docs/design/map-and-hosting.md の「全体の構成」「描画の流れ」「行政区域の描画」）。
// 背景地図のスタイルは public/basemap/ の JSON に分け、行政区域とメッシュはここで差し込む。

import type { PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  AttributionControl,
  addProtocol,
  type ErrorEvent,
  GeolocateControl,
  type LayerSpecification,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre は既定で、本体のモジュールの隣にある Worker のファイルを読む。Vite が本体を事前バンドルや
// ビルドで別の場所に移すと見つからなくなるので、Worker のファイルの URL を Vite に出させて渡す。
// Worker のファイルは他のファイルを import しないので、そのまま配ればよい
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { Protocol } from "pmtiles";
import type { Rgba } from "../core/classify/color";
import { ADMIN_TILE_CODE_PROPERTY, ADMIN_TILE_LAYERS, type BBox } from "../core/data/schema";
import type { HoverHit } from "../core/hover/hover";
import { formatPositionHash, parsePositionHash, type ZoomRange } from "../core/position/hash";
import type { AdminFillSpec } from "../core/render/admin";
import {
  type BasemapCredit,
  type BasemapSelection,
  type BasemapStyleLayers,
  basemapCredits,
  basemapLayerVisibility,
  DEFAULT_BASEMAP,
  parseBasemapLayerIds,
  parseBasemapSurfaceIds,
} from "../core/render/basemap";
import { DEFAULT_FILL_OPACITY } from "../core/render/fill-opacity";
import { err, ok, type Result } from "../core/result";
import { type OverlayLayers, overlayDeckLayers } from "./deck-layers";

/** 背景地図のスタイルの、アプリの base からの相対パス（public/ の下） */
export const BASEMAP_STYLE_FILE = "basemap/gsi-optimal-bvmap.json";

/** admin.pmtiles のソースの ID */
export const ADMIN_SOURCE_ID = "rjm-admin";

/** 行政区域のレイヤーの ID。塗りは feature-state の fill の色で決まる */
export const ADMIN_LAYER_IDS = {
  prefectureFill: "rjm-admin-pref-fill",
  municipalityFill: "rjm-admin-muni-fill",
  municipalityLine: "rjm-admin-muni-line",
  prefectureLine: "rjm-admin-pref-line",
} as const;

/**
 * 背景地図のスタイルの metadata に書く、行政区域とメッシュを差し込む位置。
 * choropleth は塗り（行政区域の塗りと deck.gl のメッシュ）を、boundary は行政区域の境界線を、
 * それぞれ指定した ID のレイヤーの直前に差し込む。道路と地名を塗りの上に描くためである。
 */
export type InsertBefore = { readonly choropleth: string; readonly boundary: string };

const INSERT_BEFORE_KEY = "rjm:insertBefore";

/**
 * 背景地図のスタイルの metadata に書く、表示を切り替える単位（鉄道、道路、川、地名）ごとのレイヤーの ID。
 * 単位は core の BASEMAP_LAYER_GROUPS で決まり、ID はスタイルが決める
 */
const LAYER_GROUPS_KEY = "rjm:layerGroups";

/**
 * 背景地図のスタイルの metadata に書く、背景地図の候補ごとの、選んだときにだけ表示するレイヤーの ID。
 * 候補は core の BASEMAP_IDS で決まり、ID はスタイルが決める
 */
const BASEMAPS_KEY = "rjm:basemaps";

/** 地図の最小と最大のズーム。地理院の最適化ベクトルタイルは z4〜16 で、z4 未満では背景地図が描かれない */
const MIN_ZOOM = 4;
const MAX_ZOOM = 16;
const ZOOM_RANGE: ZoomRange = { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };

/**
 * コントロールのボタンの説明（title と aria-label）。MapLibre の既定は英語なので置き換える。
 * 縮尺の単位（m、km）と、使っていないコントロールの文言は、既定のままにする
 */
const LOCALE = {
  "AttributionControl.ToggleAttribution": "出典の表示を切り替える",
  "GeolocateControl.FindMyLocation": "現在地へ移動",
  "GeolocateControl.LocationNotAvailable": "現在地を取得できません",
  "Map.Title": "地図",
  "NavigationControl.ResetBearing": "北を上に戻す",
  "NavigationControl.ZoomIn": "拡大",
  "NavigationControl.ZoomOut": "縮小",
} as const;

/** 縮尺の棒の幅の上限（ピクセル）。棒は、切りのよい距離になるようにこれより短くなる */
const SCALE_MAX_WIDTH = 120;

export type MapHandle = {
  readonly map: MapLibreMap;
  readonly overlay: MapboxOverlay;
  readonly insertBefore: InsertBefore;
  /** 背景地図の候補ごと、表示を切り替える単位ごとの、背景地図のスタイルのレイヤーの ID */
  readonly basemapLayers: BasemapStyleLayers;
  /** 出典の表示。背景地図を替えたときに、提供元の並びを差し替える */
  readonly attribution: AttributionControl;
  /** 出典の表示の「出典の詳細」のリンク先 */
  readonly attributionDetailsUrl: string;
  /**
   * 塗りの不透明度と、最後に渡された deck.gl のレイヤー。この中身だけは書き換える。
   * deck.gl はレイヤーを渡し直さないと不透明度を変えられないので、不透明度を変えたときに渡し直すために持つ
   */
  readonly fill: { opacity: number; layers: OverlayLayers | null };
};

export type MapError =
  /** WebGL2 が使えないなど、MapLibre の地図を作れなかった */
  | { readonly kind: "create-failed"; readonly message: string }
  /** 背景地図のスタイルを読めなかった */
  | { readonly kind: "style-failed"; readonly message: string }
  /** 背景地図のスタイルの metadata に、差し込む位置、切り替える単位、背景地図の候補のレイヤーがないか、そのレイヤーがスタイルにない */
  | { readonly kind: "style-contract"; readonly message: string }
  /** 行政区域のレイヤーや deck.gl を足す、または更新するときに MapLibre か deck.gl が例外を投げた */
  | { readonly kind: "update-failed"; readonly message: string };

export type StartMapOptions = {
  /** 地図を描く要素。大きさは呼び出し側の CSS で決める */
  readonly container: HTMLElement;
  /** 背景地図のスタイルの URL。BASEMAP_STYLE_FILE をアプリの base で解決したもの */
  readonly styleUrl: string;
  /** admin.pmtiles の URL（app の baseDataUrl で作る） */
  readonly adminTilesUrl: string;
  /** 最初に映す範囲 */
  readonly bounds: BBox;
  /** 出典の表示の「出典の詳細」のリンク先 */
  readonly attributionDetailsUrl: string;
  /**
   * 地図の位置（ズーム、中心、向き）を URL の # 以降に載せるときの名前（core の position/hash.ts）。
   * 開いたときに URL に位置があれば、bounds の代わりにその位置を映す。null なら載せず、読みもしない
   */
  readonly positionHashName: string | null;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let maplibreConfigured = false;

/**
 * MapLibre の Worker の場所を教え、pmtiles:// の URL を読めるようにする。
 * どちらも MapLibre の全体の設定なので、何度呼んでも1回だけにする
 */
const configureMaplibre = (): void => {
  if (maplibreConfigured) {
    return;
  }
  setWorkerUrl(maplibreWorkerUrl);
  addProtocol("pmtiles", new Protocol().tile);
  maplibreConfigured = true;
};

/** Rgba を、feature-state に入れる CSS の色にする。MapLibre の色の式がそのまま読める */
const cssColor = ([r, g, b, a]: Rgba): string => `rgba(${r},${g},${b},${a / 255})`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** スタイルの metadata から、差し込む位置を読む。位置のレイヤーがスタイルにあることも確かめる */
const readInsertBefore = (map: MapLibreMap): Result<InsertBefore, MapError> => {
  const style = map.getStyle();
  const metadata: unknown = style.metadata;
  const insert = isRecord(metadata) ? metadata[INSERT_BEFORE_KEY] : undefined;
  if (!isRecord(insert)) {
    return err({ kind: "style-contract", message: `metadata に ${INSERT_BEFORE_KEY} がない` });
  }
  const { choropleth, boundary } = insert;
  if (typeof choropleth !== "string" || typeof boundary !== "string") {
    return err({
      kind: "style-contract",
      message: `${INSERT_BEFORE_KEY} の choropleth と boundary は文字列にする`,
    });
  }
  const missing = [choropleth, boundary].filter((id) => map.getLayer(id) === undefined);
  if (missing.length > 0) {
    return err({
      kind: "style-contract",
      message: `スタイルにないレイヤー: ${missing.join(", ")}`,
    });
  }
  return ok({ choropleth, boundary });
};

/**
 * スタイルの metadata から、切り替える単位ごとと、背景地図の候補ごとのレイヤーの ID を読む。
 * レイヤーがスタイルにあることも確かめる
 */
const readBasemapLayers = (map: MapLibreMap): Result<BasemapStyleLayers, MapError> => {
  const metadata: unknown = map.getStyle().metadata;
  const groups = parseBasemapLayerIds(isRecord(metadata) ? metadata[LAYER_GROUPS_KEY] : undefined);
  if (!groups.ok) {
    return err({ kind: "style-contract", message: `${LAYER_GROUPS_KEY}: ${groups.error}` });
  }
  const surfaces = parseBasemapSurfaceIds(isRecord(metadata) ? metadata[BASEMAPS_KEY] : undefined);
  if (!surfaces.ok) {
    return err({ kind: "style-contract", message: `${BASEMAPS_KEY}: ${surfaces.error}` });
  }
  const missing = [...Object.values(groups.value), ...Object.values(surfaces.value)]
    .flat()
    .filter((id) => map.getLayer(id) === undefined);
  if (missing.length > 0) {
    return err({
      kind: "style-contract",
      message: `スタイルにないレイヤー: ${missing.join(", ")}`,
    });
  }
  return ok({ groups: groups.value, surfaces: surfaces.value });
};

/**
 * 行政区域の塗り。feature-state の fill がない地域（まだ色を渡していない地域）は透明にする。
 * 塗る単位は AdminFillSpec の sourceLayer で決まり、もう一方のレイヤーは setAdminFill が隠す。
 */
const adminFillLayer = (id: string, sourceLayer: string): LayerSpecification => ({
  id,
  type: "fill",
  source: ADMIN_SOURCE_ID,
  "source-layer": sourceLayer,
  layout: { visibility: "none" },
  paint: { "fill-color": ["coalesce", ["feature-state", "fill"], "rgba(0,0,0,0)"] },
});

/**
 * 行政区域の境界線。メッシュを塗っているときも位置を見失わないよう、常に描く。
 * 隣り合う区域の境界は2つのポリゴンの辺として2回描かれるので、不透明の色にして濃さをそろえる。
 * 色は DADS の White にし、灰色の道路と見分けられるようにする（2026-11-10）。
 * 市区町村は Figma の画面と同じ 0.5px、都道府県は縮尺に応じて 1px から 2.5px にする。
 */
const ADMIN_LINE_LAYERS: readonly LayerSpecification[] = [
  {
    id: ADMIN_LAYER_IDS.municipalityLine,
    type: "line",
    source: ADMIN_SOURCE_ID,
    "source-layer": ADMIN_TILE_LAYERS.municipality,
    minzoom: 6,
    paint: {
      "line-color": "#ffffff",
      "line-width": 0.5,
    },
  },
  {
    id: ADMIN_LAYER_IDS.prefectureLine,
    type: "line",
    source: ADMIN_SOURCE_ID,
    "source-layer": ADMIN_TILE_LAYERS.prefecture,
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 12, 2.5],
    },
  },
];

const ADMIN_FILL_LAYERS = [
  { id: ADMIN_LAYER_IDS.prefectureFill, sourceLayer: ADMIN_TILE_LAYERS.prefecture },
  { id: ADMIN_LAYER_IDS.municipalityFill, sourceLayer: ADMIN_TILE_LAYERS.municipality },
] as const;

const addAdminLayers = (map: MapLibreMap, adminTilesUrl: string, insert: InsertBefore): void => {
  map.addSource(ADMIN_SOURCE_ID, {
    type: "vector",
    url: `pmtiles://${adminTilesUrl}`,
    promoteId: ADMIN_TILE_CODE_PROPERTY,
    // 右下の出典の表示の文字列に含まれるので、AttributionControl が重複として省く
    attribution: "国土数値情報（国土交通省）",
  });
  for (const { id, sourceLayer } of ADMIN_FILL_LAYERS) {
    map.addLayer(adminFillLayer(id, sourceLayer), insert.choropleth);
  }
  for (const layer of ADMIN_LINE_LAYERS) {
    map.addLayer(layer, insert.boundary);
  }
};

/**
 * 出典の表示（docs/user/attribution.md の「画面での表示」）。背景地図の提供元、データの提供元、出典の詳細の順に並べる。
 * MapLibre は出典を文字数の順に並べ替えるので、順序を保つために1つの文字列にする。
 * 背景地図のスタイルのソースの attribution は、この文字列に含まれるので、MapLibre が重複として省く
 */
const attributionHtml = (credits: readonly BasemapCredit[], detailsUrl: string): string =>
  [
    ...credits.map(
      ({ label, url }) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`,
    ),
    "国土数値情報（国土交通省）",
    "国立社会保障・人口問題研究所",
    `<a href="${detailsUrl.replaceAll('"', "&quot;")}">出典の詳細</a>`,
  ].join(" | ");

/**
 * deck.gl 9.4.1 の @deck.gl/mapbox は、interleaved で描くたびに map.transform を読む
 * （deck-utils.js の getViewport。高さ、近い面と遠い面の距離を取る）。
 * MapLibre 6 は transform を map._camera.transform に移したので、そのままでは描くたびに例外になる。
 * deck.gl が MapLibre 6 に合わせるまで、同じものを map.transform として見せる。
 * MapLibre が transform を持っていれば、何もしない。
 */
const exposeTransformForDeck = (map: MapLibreMap): void => {
  if ("transform" in map) {
    return;
  }
  Object.defineProperty(map, "transform", {
    get: () => map._camera.transform,
    configurable: true,
  });
};

/**
 * 地図の位置を URL の # 以降に載せる。地図が動き終えるたびに書き、URL の # 以降が変わったら（アドレスバーに
 * 別の位置の URL を貼ったときなど）その位置へ移す。読めない位置の URL では、地図を動かさない。
 * 履歴は増やさない（replaceState）。地図を片付けると、URL を聞くのをやめる。
 *
 * MapLibre の hash のオプションは使わない。作った直後の位置（ズーム 4、緯度 0、経度 0）を URL に書いてから
 * bounds に合わせるので、その 300ms のあいだに地図を作り直す（React の StrictMode）と、
 * 作り直した地図が緯度 0、経度 0 を映したからである（2026-11-24）
 */
const syncPositionHash = (map: MapLibreMap, name: string): void => {
  const write = (): void => {
    const { lng, lat } = map.getCenter();
    const current = window.location.hash;
    const next = formatPositionHash(current, name, {
      zoom: map.getZoom(),
      lat,
      lon: lng,
      bearing: map.getBearing(),
    });
    if (next !== current) {
      window.history.replaceState(window.history.state, "", next);
    }
  };
  const read = (): void => {
    const position = parsePositionHash(window.location.hash, name, ZOOM_RANGE);
    if (position !== null) {
      map.jumpTo({
        center: [position.lon, position.lat],
        zoom: position.zoom,
        bearing: position.bearing,
      });
    }
  };
  map.on("moveend", write);
  window.addEventListener("hashchange", read);
  map.once("remove", () => window.removeEventListener("hashchange", read));
};

/**
 * スタイルを読み終えるのを待つ。読み終える前の error は、スタイルを読めなかったものとして扱う。
 * 読み終えたあとの error（タイルの取得の失敗など）は、MapLibre に任せる（コンソールに出る）。
 */
const waitForStyle = (map: MapLibreMap): Promise<Result<void, MapError>> =>
  new Promise((resolve) => {
    const onLoad = (): void => {
      map.off("error", onError);
      resolve(ok(undefined));
    };
    const onError = (event: ErrorEvent): void => {
      map.off("style.load", onLoad);
      map.off("error", onError);
      resolve(err({ kind: "style-failed", message: messageOf(event.error) }));
    };
    map.once("style.load", onLoad);
    map.on("error", onError);
  });

/**
 * 地図を作り、背景地図のスタイルを読み、行政区域のレイヤー、deck.gl、出典の表示を足す。
 * タイルを読み終えるのは待たない。返したあとすぐに setAdminFill と setOverlayLayers を呼んでよい。
 * 失敗したときは、作りかけの地図を片付けてから返す。
 */
export const startMap = async (options: StartMapOptions): Promise<Result<MapHandle, MapError>> => {
  configureMaplibre();
  const [west, south, east, north] = options.bounds;
  const { positionHashName } = options;
  const position =
    positionHashName === null
      ? null
      : parsePositionHash(window.location.hash, positionHashName, ZOOM_RANGE);
  let map: MapLibreMap;
  try {
    map = new MapLibreMap({
      container: options.container,
      style: options.styleUrl,
      ...(position === null
        ? { bounds: [west, south, east, north] }
        : {
            center: [position.lon, position.lat],
            zoom: position.zoom,
            bearing: position.bearing,
          }),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // 回転はできるが、傾きは使わない。2D の塗り分けは、傾けても読み取れることが増えない。
      // maxPitch を 0 にして、キーボード（Shift + 上下）でも傾かないようにする
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      attributionControl: false,
      locale: LOCALE,
    });
  } catch (e) {
    return err({ kind: "create-failed", message: messageOf(e) });
  }
  if (positionHashName !== null) {
    syncPositionHash(map, positionHashName);
  }

  const loaded = await waitForStyle(map);
  if (!loaded.ok) {
    map.remove();
    return loaded;
  }
  const insert = readInsertBefore(map);
  if (!insert.ok) {
    map.remove();
    return insert;
  }
  const basemapLayers = readBasemapLayers(map);
  if (!basemapLayers.ok) {
    map.remove();
    return basemapLayers;
  }
  try {
    addAdminLayers(map, options.adminTilesUrl, insert.value);
    exposeTransformForDeck(map);
    // interleaved にすると、deck.gl のレイヤーが MapLibre のレイヤーの間に入る。
    // メッシュを道路、境界線、地名の下に描くためである
    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay);
    // 下の隅のコントロールは、あとに足したものほど上に並ぶ。右下は上から、ズームと方位磁石、現在地、出典の順にする
    // スタイルの既定は、core の DEFAULT_BASEMAP と同じ（ベクトルタイルの背景地図、線と地名をすべて表示）。
    // compact を false にして、幅の狭い地図でも出典を畳まない。OpenStreetMap のタイルの利用の方針が、
    // 帰属の表示を切り替えのボタンの奥に隠さないよう求めているからである（2026-11-24 に読んだ）
    const attribution = new AttributionControl({
      compact: false,
      customAttribution: attributionHtml(
        basemapCredits(DEFAULT_BASEMAP),
        options.attributionDetailsUrl,
      ),
    });
    map.addControl(attribution, "bottom-right");
    // 現在地は、ボタンを押したときに1回だけ求めて移動する。位置はブラウザの中で使うだけで、どこにも送らない
    map.addControl(new GeolocateControl({ trackUserLocation: false }), "bottom-right");
    // 方位磁石は、押すと北が上に戻り、ドラッグすると回転する。傾きは使わないので、傾きの表示は出さない
    map.addControl(new NavigationControl({ visualizePitch: false }), "bottom-right");
    map.addControl(new ScaleControl({ unit: "metric", maxWidth: SCALE_MAX_WIDTH }), "bottom-left");
    return ok({
      map,
      overlay,
      insertBefore: insert.value,
      basemapLayers: basemapLayers.value,
      attribution,
      attributionDetailsUrl: options.attributionDetailsUrl,
      fill: { opacity: DEFAULT_FILL_OPACITY, layers: null },
    });
  } catch (e) {
    map.remove();
    return err({ kind: "update-failed", message: messageOf(e) });
  }
};

/** 地図を片付ける。deck.gl の資源も放す（MapboxOverlay の finalize が地図から外し、Deck を片付ける） */
export const stopMap = (handle: MapHandle): void => {
  handle.overlay.finalize();
  handle.map.remove();
};

/**
 * 行政区域の塗りを更新する。spec の地域のすべてに、feature-state で色を渡す（約 1,900 件）。
 * spec の sourceLayer のレイヤーだけを、visible に従って表示し、もう一方のレイヤーは隠す。
 */
export const setAdminFill = (handle: MapHandle, spec: AdminFillSpec): Result<void, MapError> => {
  const { map } = handle;
  try {
    for (const { id, sourceLayer } of ADMIN_FILL_LAYERS) {
      const visible = spec.visible && sourceLayer === spec.sourceLayer;
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
    for (const [code, color] of spec.colors) {
      map.setFeatureState(
        { source: ADMIN_SOURCE_ID, sourceLayer: spec.sourceLayer, id: code },
        { fill: cssColor(color) },
      );
    }
    return ok(undefined);
  } catch (e) {
    return err({ kind: "update-failed", message: messageOf(e) });
  }
};

/**
 * deck.gl のレイヤー（メッシュと自前データ）を差し替える。
 * 指標や年だけを変えたときは、前と同じ geometry で色だけを変えた MeshLayerSpec を渡す。
 * deck.gl は形を作り直さず、色の配列だけを転送する（updateTriggers の colorKey で知らせる）。
 */
export const setOverlayLayers = (
  handle: MapHandle,
  layers: OverlayLayers,
): Result<void, MapError> => {
  try {
    handle.fill.layers = layers;
    handle.overlay.setProps({
      layers: [...overlayDeckLayers(layers, handle.insertBefore.choropleth, handle.fill.opacity)],
    });
    return ok(undefined);
  } catch (e) {
    return err({ kind: "update-failed", message: messageOf(e) });
  }
};

/**
 * 塗り分け（メッシュと行政区域の塗り）の不透明度を変える。0 が透明、1 が不透明。
 * 行政区域は fill-opacity を変え、メッシュは同じレイヤーを不透明度だけ変えて渡し直す。
 * どちらも色は送り直さない。自前データのレイヤーには効かない。
 */
export const setFillOpacity = (handle: MapHandle, opacity: number): Result<void, MapError> => {
  try {
    handle.fill.opacity = opacity;
    for (const { id } of ADMIN_FILL_LAYERS) {
      handle.map.setPaintProperty(id, "fill-opacity", opacity);
    }
    return handle.fill.layers === null
      ? ok(undefined)
      : setOverlayLayers(handle, handle.fill.layers);
  } catch (e) {
    return err({ kind: "update-failed", message: messageOf(e) });
  }
};

/**
 * 背景地図を替え、鉄道、道路、川、地名の表示を切り替える。layout の visibility を変えるだけで、
 * スタイルは読み直さない。MapLibre は、表示していないレイヤーのタイルを読まない。
 * 川（river）と地名（label-place）は、塗りと境界線を差し込む位置でもあるが、隠しても位置は変わらない。
 *
 * 出典の表示は、描いているものの提供元に差し替える。AttributionControl は、レイヤーの表示が変わった
 * あとの描画で、options の customAttribution を読み直す。表示が1つも変わらないときは、提供元も変わらない。
 */
export const setBasemap = (
  handle: MapHandle,
  selection: BasemapSelection,
): Result<void, MapError> => {
  try {
    handle.attribution.options.customAttribution = attributionHtml(
      basemapCredits(selection),
      handle.attributionDetailsUrl,
    );
    for (const { id, visible } of basemapLayerVisibility(handle.basemapLayers, selection)) {
      handle.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
    return ok(undefined);
  } catch (e) {
    return err({ kind: "update-failed", message: messageOf(e) });
  }
};

/**
 * 範囲が収まるように地図を動かす（docs/design/ui.md の「場所への移動」、D21）。
 * 地図の向きは変えない。fitBounds の既定は北を上に戻すので、いまの向きを渡す
 */
export const fitBBox = (handle: MapHandle, bbox: BBox, padding = 32): void => {
  const [west, south, east, north] = bbox;
  handle.map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding, bearing: handle.map.getBearing() },
  );
};

/**
 * 自前データの地物を拾う半径（ピクセル）。幅 2px の線も、ポインタを少し外しても拾えるようにする。
 * deck.gl は半径の中で最も近い地物を返す
 */
export const PICKING_RADIUS = 3;

/**
 * 地図の上のポインタの知らせ。
 * - hover：ポインタの下のもの。x と y は地図の要素の左上からの位置、width と height は地図の要素の大きさ
 * - leave：ポインタが地図の外に出たか、地図が動き始めた（ドラッグ、ズーム、場所への移動）
 */
export type MapPointerEvent =
  | {
      readonly kind: "hover";
      readonly hit: HoverHit;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "leave" };

/** deck.gl の picking の結果の地物の properties。GeoJSON の地物でなければ undefined */
const pickedProperties = (object: unknown): unknown => {
  if (!isRecord(object)) {
    return undefined;
  }
  const { properties } = object;
  return properties;
};

/**
 * ポインタの下のものを知らせる。返した関数で知らせるのをやめる。
 *
 * - **自前データ**：deck.gl が pointermove のあとのフレームで行う picking（onHover）の結果を使う。
 *   interleaved の deck.gl は、地図のキャンバスの pointermove を自分で聞き（MapboxOverlay は MapLibre の
 *   mousemove を渡さない）、フレームごとに1回にまとめるので、知らせもフレームごとに1回になる。
 *   picking の対象は、自前データの点、線、面のレイヤーだけである（deck-layers.ts）。
 * - **市区町村**：市区町村の塗りのレイヤーを queryRenderedFeatures で引き、団体コードを返す。
 * - **経緯度**：ポインタの位置を unproject する。メッシュコードは app が core で計算する。
 *
 * 地図が動いているあいだ（movestart から moveend まで）は知らせず、動き始めに leave を知らせる。
 * 動き終えたあとは、次にポインタが動いたときに知らせる（引き直しのために picking を呼ばない）。
 * ドラッグのあいだは、MapLibre は mousemove を出さず、deck.gl はボタンを押したままの pointermove で picking をしない。
 */
export const watchPointer = (
  handle: MapHandle,
  listener: (event: MapPointerEvent) => void,
): (() => void) => {
  const { map, overlay } = handle;
  /** ポインタが地図の上にあるか */
  let inside = false;
  let moving = false;

  const notify = (info: PickingInfo): void => {
    const { x, y } = info;
    const { lng, lat } = map.unproject([x, y]);
    const [municipality] = map.queryRenderedFeatures([x, y], {
      layers: [ADMIN_LAYER_IDS.municipalityFill],
    });
    const code: unknown = municipality?.properties[ADMIN_TILE_CODE_PROPERTY];
    const feature =
      info.picked && info.layer !== null && info.layer !== undefined
        ? {
            layerId: info.layer.id,
            index: info.index,
            properties: pickedProperties(info.object),
          }
        : null;
    const container = map.getContainer();
    listener({
      kind: "hover",
      hit: { lon: lng, lat, municipalityCode: typeof code === "string" ? code : null, feature },
      x,
      y,
      width: container.clientWidth,
      height: container.clientHeight,
    });
  };

  // deck.gl の onHover は、地図の外に出たあと（x が -1）にも呼ばれる
  const onHover = (info: PickingInfo): void => {
    if (moving || !inside || info.x < 0) {
      return;
    }
    notify(info);
  };
  const onMouseMove = (): void => {
    inside = true;
  };
  const onMouseOut = (): void => {
    inside = false;
    listener({ kind: "leave" });
  };
  const onMoveStart = (): void => {
    moving = true;
    listener({ kind: "leave" });
  };
  // 動き終えても引き直さず、次にポインタが動いたときの deck.gl の onHover を待つ。
  // 動き終えた直後に pickObject を呼ぶと、100 万点を重ねた地図では、カメラが変わったあとの最初の picking（50〜90ms）に
  // GPU が最後のフレームを描き終えるのを待つ時間が加わり、1 フレームが 330〜450ms に延びた（2026-11-10）
  const onMoveEnd = (): void => {
    moving = false;
  };

  overlay.setProps({ onHover, pickingRadius: PICKING_RADIUS });
  map.on("mousemove", onMouseMove);
  map.on("mouseout", onMouseOut);
  map.on("movestart", onMoveStart);
  map.on("moveend", onMoveEnd);
  return () => {
    overlay.setProps({ onHover: null });
    map.off("mousemove", onMouseMove);
    map.off("mouseout", onMouseOut);
    map.off("movestart", onMoveStart);
    map.off("moveend", onMoveEnd);
  };
};
