// 地図のアダプタ。MapLibre GL JS、pmtiles のプロトコル、deck.gl の MapboxOverlay を包む
// （docs/design/map-and-hosting.md の「全体の構成」「描画の流れ」「行政区域の描画」）。
// 背景地図のスタイルは public/basemap/ の JSON に分け、行政区域とメッシュはここで差し込む。

import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  AttributionControl,
  addProtocol,
  type ErrorEvent,
  type LayerSpecification,
  Map as MapLibreMap,
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
import type { AdminFillSpec } from "../core/render/admin";
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

/** 地図の最小と最大のズーム。地理院の最適化ベクトルタイルは z4〜16 で、z4 未満では背景地図が描かれない */
const MIN_ZOOM = 4;
const MAX_ZOOM = 16;

/** 地理院タイル一覧のページ。出典の表示でリンクする（docs/user/attribution.md の「国土地理院」） */
const GSI_TILE_LIST_URL = "https://maps.gsi.go.jp/development/ichiran.html";

export type MapHandle = {
  readonly map: MapLibreMap;
  readonly overlay: MapboxOverlay;
  readonly insertBefore: InsertBefore;
};

export type MapError =
  /** WebGL2 が使えないなど、MapLibre の地図を作れなかった */
  | { readonly kind: "create-failed"; readonly message: string }
  /** 背景地図のスタイルを読めなかった */
  | { readonly kind: "style-failed"; readonly message: string }
  /** 背景地図のスタイルの metadata に、差し込む位置がないか、そのレイヤーがない */
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

/** 出典の表示（docs/user/attribution.md の「画面での表示」）。順序を保つため、1つの文字列にする */
const attributionHtml = (detailsUrl: string): string =>
  [
    `<a href="${GSI_TILE_LIST_URL}" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル</a>`,
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
  let map: MapLibreMap;
  try {
    map = new MapLibreMap({
      container: options.container,
      style: options.styleUrl,
      bounds: [west, south, east, north],
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // 塗り分けを読む地図なので、回転と傾きは使わない
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      attributionControl: false,
    });
  } catch (e) {
    return err({ kind: "create-failed", message: messageOf(e) });
  }
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

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
  try {
    addAdminLayers(map, options.adminTilesUrl, insert.value);
    exposeTransformForDeck(map);
    // interleaved にすると、deck.gl のレイヤーが MapLibre のレイヤーの間に入る。
    // メッシュを道路、境界線、地名の下に描くためである
    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay);
    map.addControl(
      new AttributionControl({ customAttribution: attributionHtml(options.attributionDetailsUrl) }),
      "bottom-right",
    );
    return ok({ map, overlay, insertBefore: insert.value });
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
    handle.overlay.setProps({
      layers: [...overlayDeckLayers(layers, handle.insertBefore.choropleth)],
    });
    return ok(undefined);
  } catch (e) {
    return err({ kind: "update-failed", message: messageOf(e) });
  }
};

/** 範囲が収まるように地図を動かす（docs/design/ui.md の「場所への移動」、D21） */
export const fitBBox = (handle: MapHandle, bbox: BBox, padding = 32): void => {
  const [west, south, east, north] = bbox;
  handle.map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding },
  );
};
