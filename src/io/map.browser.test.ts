import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSPARENT } from "../core/classify/color";
import { classificationOf, DADS_ORANGE_6 } from "../core/classify/scales";
import type { BBox } from "../core/data/schema";
import { buildMeshGeometry } from "../core/mesh/geometry";
import { meshCodeToBounds } from "../core/mesh/mesh-code";
import { adminFillSpec } from "../core/render/admin";
import { meshLayerSpec } from "../core/render/mesh";
import { pointLayerSpec } from "../core/render/overlay";
import type { Result } from "../core/result";
import {
  ADMIN_LAYER_IDS,
  ADMIN_SOURCE_ID,
  fitBBox,
  type MapHandle,
  type MapPointerEvent,
  setAdminFill,
  setBasemap,
  setFillOpacity,
  setOverlayLayers,
  startMap,
  stopMap,
  watchPointer,
} from "./map";

// ネットワークに頼らないよう、背景地図は背景色だけのスタイルにする。
// choropleth と boundary の位置と、表示を切り替えるレイヤー（川、道路、鉄道、地名）は、描かない背景のレイヤーで示す。
// 背景地図の候補も、タイルを読まないレイヤーで示す。pale だけは色を塗り、選んだときに描かれることを確かめる。
// admin.pmtiles は置いていないので、タイルの取得は失敗する（MapLibre がコンソールに出す）。
// feature-state はタイルがなくても読み書きできるので、塗りの検査には差し支えない。

const SEA: readonly [number, number, number, number] = [230, 230, 230, 255];
const PALE: readonly [number, number, number, number] = [40, 80, 120, 255];

/** 描かない背景のレイヤー。railColor を渡すと、rail をその色で塗る */
const baseStyle = (metadata: unknown, railColor?: string) => {
  const hidden = (id: string) => ({
    id,
    type: "background",
    paint: { "background-opacity": 0 },
  });
  /** 選ぶまで表示しない、背景地図の候補のレイヤー */
  const surface = (id: string, color?: string) => ({
    id,
    type: "background",
    layout: { visibility: "none" },
    paint: color === undefined ? { "background-opacity": 0 } : { "background-color": color },
  });
  return {
    version: 8,
    metadata,
    sources: {
      // 地物のないソース。出典の表示が、使っているソースの attribution を重ねて出さないことを確かめる
      photo: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        attribution: "地理院タイル",
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "rgb(230,230,230)" } },
      hidden("land"),
      { id: "photo", type: "fill", source: "photo", layout: { visibility: "none" } },
      surface("pale", "rgb(40,80,120)"),
      surface("std"),
      surface("relief"),
      surface("osm"),
      hidden("river"),
      hidden("road"),
      railColor === undefined
        ? hidden("rail")
        : { id: "rail", type: "background", paint: { "background-color": railColor } },
      hidden("rail-dash"),
      hidden("label"),
    ],
  };
};

const LAYER_GROUPS = {
  rail: ["rail", "rail-dash"],
  road: ["road"],
  river: ["river"],
  label: ["label"],
};

const BASEMAPS = {
  vector: ["land"],
  photo: ["photo"],
  pale: ["pale"],
  std: ["std"],
  relief: ["relief"],
  osm: ["osm"],
};

const VALID_METADATA = {
  "rjm:insertBefore": { choropleth: "river", boundary: "label" },
  "rjm:layerGroups": LAYER_GROUPS,
  "rjm:basemaps": BASEMAPS,
};

const ALL_VISIBLE = { rail: true, road: true, river: true, label: true };

const urls: string[] = [];

const styleUrl = (style: unknown): string => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(style)], { type: "application/json" }));
  urls.push(url);
  return url;
};

const MESH = 53394611;
const meshBounds = meshCodeToBounds(MESH);
const meshCenter: [number, number] = [
  (meshBounds.west + meshBounds.east) / 2,
  (meshBounds.south + meshBounds.north) / 2,
];
/** メッシュが地図の真ん中に大きく映る範囲 */
const AROUND_MESH: BBox = [
  meshBounds.west - 0.02,
  meshBounds.south - 0.02,
  meshBounds.east + 0.02,
  meshBounds.north + 0.02,
];

let container: HTMLDivElement;
let handle: MapHandle | null = null;

const start = (style: unknown, url = styleUrl(style), positionHashName: string | null = null) =>
  startMap({
    container,
    styleUrl: url,
    adminTilesUrl: new URL("/no-such-admin.pmtiles", window.location.href).href,
    bounds: AROUND_MESH,
    attributionDetailsUrl: "#sources",
    positionHashName,
  });

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

/** 次に描いたフレームの、経度緯度の位置の画素の色 */
const pixelAt = (map: MapHandle["map"], lngLat: [number, number]): Promise<number[]> =>
  new Promise((resolve, reject) => {
    map.once("render", () => {
      const canvas = map.getCanvas();
      const gl = canvas.getContext("webgl2");
      if (gl === null) {
        reject(new Error("WebGL2 のコンテキストがない"));
        return;
      }
      const point = map.project(lngLat);
      const ratio = canvas.width / canvas.clientWidth;
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.round(point.x * ratio),
        Math.round(canvas.height - point.y * ratio),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      resolve([...pixel]);
    });
    map.triggerRepaint();
  });

/** 画素が期待した色になるまで、フレームを描かせて待つ。deck.gl の準備に数フレームかかることがある */
const waitForPixel = async (
  map: MapHandle["map"],
  lngLat: [number, number],
  expected: readonly number[],
): Promise<number[]> => {
  let pixel: number[] = [];
  for (let i = 0; i < 60; i++) {
    pixel = await pixelAt(map, lngLat);
    if (pixel.every((c, k) => c === expected[k])) break;
  }
  return pixel;
};

/** 画素が、期待した色から各成分 1 以内になるまで待つ。半透明の塗りは、合成の丸めで 1 ずれることがある */
const waitForPixelNear = async (
  map: MapHandle["map"],
  lngLat: [number, number],
  expected: readonly number[],
): Promise<number[]> => {
  let pixel: number[] = [];
  for (let i = 0; i < 60; i++) {
    pixel = await pixelAt(map, lngLat);
    if (pixel.every((c, k) => Math.abs(c - (expected[k] ?? 0)) <= 1)) break;
  }
  return pixel;
};

/** 不透明の色を、不透明度 opacity で海の色の上に重ねたときの色 */
const overSea = (color: readonly number[], opacity: number): number[] =>
  SEA.map((sea, k) => Math.round((color[k] ?? 0) * opacity + sea * (1 - opacity)));

/** 右下の出典の表示の文字 */
const attributionText = (): string | null | undefined =>
  container.querySelector(".maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib-inner")
    ?.textContent;

/** 出典の表示が期待した文字になるまで、フレームを描かせて待つ */
const waitForAttribution = async (
  map: MapHandle["map"],
  expected: string,
): Promise<string | null | undefined> => {
  for (let i = 0; i < 60 && attributionText() !== expected; i++) {
    await new Promise((resolve) => {
      map.once("render", resolve);
      map.triggerRepaint();
    });
  }
  return attributionText();
};

beforeEach(() => {
  container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px";
  document.body.append(container);
});

afterEach(() => {
  if (handle !== null) {
    stopMap(handle);
    handle = null;
  }
  container.remove();
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
});

describe("startMap", () => {
  it("スタイルの metadata が示す位置に、行政区域の塗りと境界線を差し込む", async () => {
    handle = unwrap(await start(baseStyle(VALID_METADATA)));
    expect(handle.map.getStyle().layers.map((l) => l.id)).toEqual([
      "background",
      "land",
      "photo",
      "pale",
      "std",
      "relief",
      "osm",
      ADMIN_LAYER_IDS.prefectureFill,
      ADMIN_LAYER_IDS.municipalityFill,
      "river",
      "road",
      "rail",
      "rail-dash",
      ADMIN_LAYER_IDS.municipalityLine,
      ADMIN_LAYER_IDS.prefectureLine,
      "label",
    ]);
    expect(handle.map.getStyle().sources[ADMIN_SOURCE_ID]).toMatchObject({
      type: "vector",
      url: expect.stringMatching(/^pmtiles:\/\/.*\/no-such-admin\.pmtiles$/),
      promoteId: "code",
    });
  });

  it("右下に、3つの提供元と出典の詳細へのリンクを、この順に出す", async () => {
    handle = unwrap(await start(baseStyle(VALID_METADATA)));
    const attribution = container.querySelector(
      ".maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib-inner",
    );
    expect(attribution?.textContent).toBe(
      "国土地理院最適化ベクトルタイル | 国土数値情報（国土交通省） | 国立社会保障・人口問題研究所 | 出典の詳細",
    );
    const links = [...(attribution?.querySelectorAll("a") ?? [])].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual(["https://maps.gsi.go.jp/development/ichiran.html", "#sources"]);
  });

  it("幅の狭い地図でも、出典を畳まない", async () => {
    // テストの地図の幅は 400px で、MapLibre の既定では畳む幅（640px 以下）である
    handle = unwrap(await start(baseStyle(VALID_METADATA)));
    const control = container.querySelector(
      ".maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib",
    );
    expect(control?.classList.contains("maplibregl-compact")).toBe(false);
    const inner = control?.querySelector(".maplibregl-ctrl-attrib-inner");
    expect(inner?.getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it("metadata に差し込む位置がなければ style-contract を返し、地図を片付ける", async () => {
    const result = await start(baseStyle({}));
    expect(result.ok ? null : result.error.kind).toBe("style-contract");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("差し込む位置のレイヤーがスタイルになければ style-contract を返す", async () => {
    const result = await start(
      baseStyle({
        ...VALID_METADATA,
        "rjm:insertBefore": { choropleth: "road", boundary: "no-such-layer" },
      }),
    );
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "style-contract",
      message: expect.stringContaining("no-such-layer"),
    });
  });

  it("metadata に表示を切り替える単位がなければ style-contract を返し、地図を片付ける", async () => {
    const result = await start(
      baseStyle({
        "rjm:insertBefore": VALID_METADATA["rjm:insertBefore"],
        "rjm:basemaps": BASEMAPS,
      }),
    );
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "style-contract",
      message: expect.stringContaining("rjm:layerGroups"),
    });
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("表示を切り替える単位のレイヤーがスタイルになければ style-contract を返す", async () => {
    const result = await start(
      baseStyle({
        ...VALID_METADATA,
        "rjm:layerGroups": { ...LAYER_GROUPS, rail: ["rail", "no-such-rail"] },
      }),
    );
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "style-contract",
      message: expect.stringContaining("no-such-rail"),
    });
  });

  it("metadata に背景地図の候補がなければ style-contract を返し、地図を片付ける", async () => {
    const { "rjm:basemaps": _, ...withoutBasemaps } = VALID_METADATA;
    const result = await start(baseStyle(withoutBasemaps));
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "style-contract",
      message: expect.stringContaining("rjm:basemaps"),
    });
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("背景地図の候補のレイヤーがスタイルになければ style-contract を返す", async () => {
    const result = await start(
      baseStyle({ ...VALID_METADATA, "rjm:basemaps": { ...BASEMAPS, osm: ["no-such-osm"] } }),
    );
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "style-contract",
      message: expect.stringContaining("no-such-osm"),
    });
  });

  it("スタイルを読めなければ style-failed を返す", async () => {
    const result = await start(null, new URL("/no-such-style.json", window.location.href).href);
    expect(result.ok ? null : result.error.kind).toBe("style-failed");
    expect(container.querySelector("canvas")).toBeNull();
  });
});

describe("startMap のコントロール", () => {
  it("右下に上からズームと方位磁石、現在地、出典を、左下に縮尺を置く。ボタンの説明は日本語にする", async () => {
    handle = unwrap(await start(baseStyle(VALID_METADATA)));
    const right = [
      ...container.querySelectorAll(".maplibregl-ctrl-bottom-right > .maplibregl-ctrl"),
    ];
    expect(right).toHaveLength(3);
    expect([...(right[0]?.querySelectorAll("button") ?? [])].map((b) => b.title)).toEqual([
      "拡大",
      "縮小",
      "北を上に戻す",
    ]);
    expect(right[1]?.querySelector("button.maplibregl-ctrl-geolocate")).not.toBeNull();
    expect(right[2]?.classList.contains("maplibregl-ctrl-attrib")).toBe(true);
    // 上から並ぶ
    const tops = right.map((el) => el.getBoundingClientRect().top);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));

    const scale = container.querySelector(".maplibregl-ctrl-bottom-left .maplibregl-ctrl-scale");
    // 数と単位のあいだは、改行しない空白である
    expect(scale?.textContent).toMatch(/^\d+\s(m|km)$/);
  });

  it("方位磁石を押すと、北が上に戻る", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    h.map.jumpTo({ bearing: 40 });
    const reset = new Promise((resolve) => h.map.once("rotateend", resolve));
    container.querySelector<HTMLButtonElement>("button.maplibregl-ctrl-compass")?.click();
    await reset;
    expect(h.map.getBearing()).toBe(0);
  });

  it("回転はできるが、傾きは 0 のまま変わらない", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    h.map.jumpTo({ bearing: 40, pitch: 30 });
    expect(h.map.getBearing()).toBe(40);
    expect(h.map.getPitch()).toBe(0);
  });
});

describe("URL の位置", () => {
  const NAME = "rjmtest";
  let savedUrl = "";

  const setHash = (hash: string): void =>
    window.history.replaceState(window.history.state, "", hash);

  beforeEach(() => {
    savedUrl = window.location.href;
  });

  afterEach(() => {
    window.history.replaceState(window.history.state, "", savedUrl);
  });

  it("URL に位置があれば、bounds の代わりにその位置を映す", async () => {
    setHash(`#keep=1&${NAME}=9.5/36.5/138.25/-30`);
    const h = unwrap(await start(baseStyle(VALID_METADATA), undefined, NAME));
    handle = h;
    expect(h.map.getZoom()).toBe(9.5);
    expect(h.map.getCenter().lat).toBeCloseTo(36.5, 6);
    expect(h.map.getCenter().lng).toBeCloseTo(138.25, 6);
    expect(h.map.getBearing()).toBe(-30);
  });

  it("読めない位置の URL では、bounds を映す", async () => {
    // ズームが範囲（4〜16）の外
    setHash(`#${NAME}=3/36.5/138.25`);
    const h = unwrap(await start(baseStyle(VALID_METADATA), undefined, NAME));
    handle = h;
    expect(h.map.getCenter().lat).toBeCloseTo(meshCenter[1], 3);
    expect(h.map.getCenter().lng).toBeCloseTo(meshCenter[0], 3);
  });

  it("地図が動き終えると、URL の位置だけを書き換える。開いただけでは書かず、履歴も増やさない", async () => {
    setHash("#keep=1");
    const entries = window.history.length;
    const h = unwrap(await start(baseStyle(VALID_METADATA), undefined, NAME));
    handle = h;
    expect(window.location.hash).toBe("#keep=1");

    h.map.jumpTo({ center: [138.25, 36.5], zoom: 9.5, bearing: -30 });
    expect(window.location.hash).toBe(`#keep=1&${NAME}=9.5/36.5/138.25/-30`);
    h.map.jumpTo({ bearing: 0 });
    expect(window.location.hash).toBe(`#keep=1&${NAME}=9.5/36.5/138.25`);
    expect(window.history.length).toBe(entries);
  });

  it("名前を渡さなければ、URL を読まず、書かない", async () => {
    setHash(`#${NAME}=9.5/36.5/138.25`);
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    expect(h.map.getCenter().lat).toBeCloseTo(meshCenter[1], 3);
    h.map.jumpTo({ zoom: 12 });
    expect(window.location.hash).toBe(`#${NAME}=9.5/36.5/138.25`);
  });

  it("URL の # 以降が変わると、その位置へ移す。地図を片付けたあとは、URL を聞かない", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA), undefined, NAME));
    const hashChanged = (): Promise<unknown> =>
      new Promise((resolve) => window.addEventListener("hashchange", resolve, { once: true }));

    let changed = hashChanged();
    window.location.hash = `${NAME}=9.5/36.5/138.25/20`;
    await changed;
    expect(h.map.getZoom()).toBe(9.5);
    expect(h.map.getCenter().lat).toBeCloseTo(36.5, 6);
    expect(h.map.getBearing()).toBe(20);

    // 読めない位置では動かさない
    changed = hashChanged();
    window.location.hash = `${NAME}=9.5/95/138.25`;
    await changed;
    expect(h.map.getCenter().lat).toBeCloseTo(36.5, 6);

    const jumps: unknown[] = [];
    h.map.on("movestart", (e) => jumps.push(e));
    stopMap(h);
    changed = hashChanged();
    window.location.hash = `${NAME}=10/36/138`;
    await changed;
    expect(jumps).toEqual([]);
  });
});

describe("setAdminFill", () => {
  it("団体コードごとの色を feature-state に入れ、塗る単位のレイヤーだけを表示する", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    const values = new Map([
      ["01100", 0.45],
      ["01202", Number.NaN],
    ]);
    const classification = classificationOf("aging_rate", "municipality");
    unwrap(setAdminFill(h, adminFillSpec(values, classification, true)));

    const stateOf = (id: string) =>
      h.map.getFeatureState({ source: ADMIN_SOURCE_ID, sourceLayer: "muni", id });
    // 0.45 は 0.4 以上 0.5 未満なので、3つめの階級
    const [r, g, b] = classification.colors[2] ?? TRANSPARENT;
    expect(stateOf("01100")).toEqual({ fill: `rgba(${r},${g},${b},1)` });
    expect(stateOf("01202")).toEqual({ fill: "rgba(0,0,0,0)" });

    const visibility = (id: string) => h.map.getLayoutProperty(id, "visibility");
    expect(visibility(ADMIN_LAYER_IDS.municipalityFill)).toBe("visible");
    expect(visibility(ADMIN_LAYER_IDS.prefectureFill)).toBe("none");

    unwrap(setAdminFill(h, adminFillSpec(values, classification, false)));
    expect(visibility(ADMIN_LAYER_IDS.municipalityFill)).toBe("none");
    // 境界線は塗りを隠しても描く
    expect(visibility(ADMIN_LAYER_IDS.municipalityLine)).not.toBe("none");
  });
});

describe("setOverlayLayers", () => {
  it("メッシュを塗り、色だけを差し替えると描かれる色が変わる", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    const geometry = buildMeshGeometry([MESH]);
    const classification = classificationOf("aging_rate", "mesh");
    const show = (value: number, colorKey: string, visible = true) =>
      unwrap(
        setOverlayLayers(h, {
          mesh: meshLayerSpec({
            id: "mesh",
            geometry,
            values: [value],
            classification,
            colorKey,
            visible,
          }),
          points: [],
          geoJsons: [],
        }),
      );

    show(0.25, "low");
    expect(await waitForPixel(h.map, meshCenter, DADS_ORANGE_6[0] ?? [])).toEqual(DADS_ORANGE_6[0]);
    // deck.gl のレイヤーは、choropleth の位置（river の直前）に入る
    expect(h.map.getLayer("deck-layer-group-before:river")).toBeDefined();

    show(0.8, "high");
    expect(await waitForPixel(h.map, meshCenter, DADS_ORANGE_6[5] ?? [])).toEqual(DADS_ORANGE_6[5]);

    show(Number.NaN, "none");
    expect(await waitForPixel(h.map, meshCenter, SEA)).toEqual(SEA);
  });
});

describe("回転した地図", () => {
  it("メッシュは、回転しても経緯度の位置に描かれる", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    const color = DADS_ORANGE_6[0] ?? [];
    unwrap(
      setOverlayLayers(h, {
        mesh: meshLayerSpec({
          id: "mesh",
          geometry: buildMeshGeometry([MESH]),
          values: [0.25],
          classification: classificationOf("aging_rate", "mesh"),
          colorKey: "low",
          visible: true,
        }),
        points: [],
        geoJsons: [],
      }),
    );
    expect(await waitForPixel(h.map, meshCenter, color)).toEqual(color);

    h.map.jumpTo({ bearing: 40 });
    const width = meshBounds.east - meshBounds.west;
    const height = meshBounds.north - meshBounds.south;
    /** メッシュの北東の角から、メッシュの幅と高さの ratio 倍だけ内側（負なら外側）の点 */
    const nearNorthEast = (ratio: number): [number, number] => [
      meshBounds.east - width * ratio,
      meshBounds.north - height * ratio,
    ];
    expect(await waitForPixel(h.map, nearNorthEast(0.1), color)).toEqual(color);
    expect(await waitForPixel(h.map, nearNorthEast(-0.1), SEA)).toEqual(SEA);
  });

  it("fitBBox は、地図の向きを変えずに範囲へ移す", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    h.map.jumpTo({ bearing: 40, zoom: 8 });
    const moved = new Promise((resolve) => h.map.once("moveend", resolve));
    fitBBox(h, AROUND_MESH);
    await moved;
    expect(h.map.getBearing()).toBeCloseTo(40, 6);
    expect(h.map.getCenter().lng).toBeCloseTo(meshCenter[0], 3);
    expect(h.map.getZoom()).toBeGreaterThan(8);
  });
});

describe("setBasemap", () => {
  const meshOverlay = () => ({
    mesh: meshLayerSpec({
      id: "mesh",
      geometry: buildMeshGeometry([MESH]),
      values: [0.25],
      classification: classificationOf("aging_rate", "mesh"),
      colorKey: "low",
      visible: true,
    }),
    points: [],
    geoJsons: [],
  });

  it("単位ごとに、そのレイヤーの layout の visibility を切り替える。鉄道はまとめて切り替える", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    const visibility = (id: string) => h.map.getLayoutProperty(id, "visibility");
    const groups = ["rail", "rail-dash", "road", "river", "label"];
    unwrap(
      setBasemap(h, { id: "vector", visibility: { ...ALL_VISIBLE, rail: false, river: false } }),
    );
    expect(groups.map(visibility)).toEqual(["none", "none", "visible", "none", "visible"]);
    unwrap(
      setBasemap(h, { id: "vector", visibility: { ...ALL_VISIBLE, road: false, label: false } }),
    );
    expect(groups.map(visibility)).toEqual(["visible", "visible", "none", "visible", "none"]);
    // 背景地図のレイヤーは、既定のまま
    expect(visibility("land")).toBe("visible");
    expect(["photo", "pale", "std", "relief", "osm"].map(visibility)).toEqual(
      Array(5).fill("none"),
    );
  });

  it("背景地図を替えると、選んだ候補のレイヤーだけを表示し、その背景地図が隠す単位を隠す", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    const shown = () =>
      ["land", "photo", "pale", "std", "relief", "osm", "rail", "road", "river", "label"].filter(
        (id) => h.map.getLayoutProperty(id, "visibility") !== "none",
      );
    unwrap(setBasemap(h, { id: "photo", visibility: ALL_VISIBLE }));
    expect(shown()).toEqual(["photo", "rail", "road", "label"]);
    unwrap(setBasemap(h, { id: "osm", visibility: ALL_VISIBLE }));
    expect(shown()).toEqual(["osm"]);
    unwrap(setBasemap(h, { id: "relief", visibility: { ...ALL_VISIBLE, road: false } }));
    expect(shown()).toEqual(["relief", "rail", "river", "label"]);
    unwrap(setBasemap(h, { id: "vector", visibility: ALL_VISIBLE }));
    expect(shown()).toEqual(["land", "rail", "road", "river", "label"]);
  });

  it("選んだ背景地図は塗りの下に描かれ、メッシュはその上に描かれる", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    expect(await waitForPixel(h.map, meshCenter, SEA)).toEqual(SEA);
    unwrap(setBasemap(h, { id: "pale", visibility: ALL_VISIBLE }));
    expect(await waitForPixel(h.map, meshCenter, PALE)).toEqual(PALE);
    unwrap(setOverlayLayers(h, meshOverlay()));
    expect(await waitForPixel(h.map, meshCenter, DADS_ORANGE_6[0] ?? [])).toEqual(DADS_ORANGE_6[0]);
    expect(h.map.getLayer("deck-layer-group-before:river")).toBeDefined();
  });

  it("隠したレイヤーは描かれず、塗りを差し込む位置の川を隠しても、メッシュは同じ位置に描かれる", async () => {
    const RAIL = [10, 20, 30, 255];
    const h = unwrap(await start(baseStyle(VALID_METADATA, "rgb(10,20,30)")));
    handle = h;
    unwrap(setOverlayLayers(h, meshOverlay()));
    // 鉄道（不透明の背景）がメッシュを覆う
    expect(await waitForPixel(h.map, meshCenter, RAIL)).toEqual(RAIL);
    unwrap(
      setBasemap(h, { id: "vector", visibility: { ...ALL_VISIBLE, rail: false, river: false } }),
    );
    expect(await waitForPixel(h.map, meshCenter, DADS_ORANGE_6[0] ?? [])).toEqual(DADS_ORANGE_6[0]);
    expect(h.map.getLayer("deck-layer-group-before:river")).toBeDefined();
  });

  it("出典の表示を、描いているものの提供元に差し替える。ソースの attribution は重ねて出さない", async () => {
    const DATA = "国土数値情報（国土交通省） | 国立社会保障・人口問題研究所 | 出典の詳細";
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;

    unwrap(setBasemap(h, { id: "photo", visibility: ALL_VISIBLE }));
    const photo = `地理院タイル | 国土地理院最適化ベクトルタイル | ${DATA}`;
    expect(await waitForAttribution(h.map, photo)).toBe(photo);

    // 線と地名を描かなければ、最適化ベクトルタイルを出さない
    unwrap(setBasemap(h, { id: "pale", visibility: ALL_VISIBLE }));
    expect(await waitForAttribution(h.map, `地理院タイル | ${DATA}`)).toBe(
      `地理院タイル | ${DATA}`,
    );

    unwrap(setBasemap(h, { id: "osm", visibility: ALL_VISIBLE }));
    const osm = `© OpenStreetMap contributors | ${DATA}`;
    expect(await waitForAttribution(h.map, osm)).toBe(osm);
    const links = [
      ...container.querySelectorAll(
        ".maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib-inner a",
      ),
    ].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://www.openstreetmap.org/copyright", "#sources"]);

    unwrap(setBasemap(h, { id: "vector", visibility: ALL_VISIBLE }));
    const vector = `国土地理院最適化ベクトルタイル | ${DATA}`;
    expect(await waitForAttribution(h.map, vector)).toBe(vector);
  });
});

describe("setFillOpacity", () => {
  const ORANGE = DADS_ORANGE_6[0] ?? [];
  const overlay = (points: readonly ReturnType<typeof pointLayerSpec>[] = []) => ({
    mesh: meshLayerSpec({
      id: "mesh",
      geometry: buildMeshGeometry([MESH]),
      values: [0.25],
      classification: classificationOf("aging_rate", "mesh"),
      colorKey: "low",
      visible: true,
    }),
    points,
    geoJsons: [],
  });

  it("描いているメッシュの塗りを、色を送り直さずに半透明にし、不透明に戻す", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    unwrap(setOverlayLayers(h, overlay()));
    expect(await waitForPixel(h.map, meshCenter, ORANGE)).toEqual(ORANGE);

    unwrap(setFillOpacity(h, 0.4));
    const blended = overSea(ORANGE, 0.4);
    const pixel = await waitForPixelNear(h.map, meshCenter, blended);
    expect(pixel.map((c, k) => Math.abs(c - (blended[k] ?? 0)) <= 1)).toEqual(Array(4).fill(true));

    unwrap(setFillOpacity(h, 1));
    expect(await waitForPixel(h.map, meshCenter, ORANGE)).toEqual(ORANGE);
  });

  it("先に決めた不透明度は、あとから渡したメッシュに効き、自前データの点には効かない", async () => {
    const POINT_COLOR = [29, 78, 216, 255];
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    unwrap(setFillOpacity(h, 0.7));
    const corner: [number, number] = [
      meshBounds.west + (meshBounds.east - meshBounds.west) * 0.1,
      meshBounds.south + (meshBounds.north - meshBounds.south) * 0.1,
    ];
    const point = pointLayerSpec("rjm-dataset-p", [meshCenter[1]], [meshCenter[0]], {
      color: "#1d4ed8",
      size: 8,
      visible: true,
    });
    unwrap(setOverlayLayers(h, overlay([point])));
    const blended = overSea(ORANGE, 0.7);
    const pixel = await waitForPixelNear(h.map, corner, blended);
    expect(pixel.map((c, k) => Math.abs(c - (blended[k] ?? 0)) <= 1)).toEqual(Array(4).fill(true));
    expect(await waitForPixel(h.map, meshCenter, POINT_COLOR)).toEqual(POINT_COLOR);
  });

  it("行政区域の塗りの2つのレイヤーの fill-opacity を変える。境界線は変えない", async () => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    unwrap(setFillOpacity(h, 0.7));
    expect(h.map.getPaintProperty(ADMIN_LAYER_IDS.municipalityFill, "fill-opacity")).toBe(0.7);
    expect(h.map.getPaintProperty(ADMIN_LAYER_IDS.prefectureFill, "fill-opacity")).toBe(0.7);
    expect(
      h.map.getPaintProperty(ADMIN_LAYER_IDS.municipalityLine, "line-opacity"),
    ).toBeUndefined();
  });
});

describe("watchPointer", () => {
  const POINT_COLOR = [29, 78, 216, 255];
  const POINT_LAYER = "rjm-dataset-p";

  /** メッシュの中央に点を1つ置いた地図 */
  const startWithPoint = async (): Promise<MapHandle> => {
    const h = unwrap(await start(baseStyle(VALID_METADATA)));
    handle = h;
    const point = pointLayerSpec(POINT_LAYER, [meshCenter[1]], [meshCenter[0]], {
      color: "#1d4ed8",
      size: 6,
      visible: true,
    });
    unwrap(setOverlayLayers(h, { mesh: null, points: [point], geoJsons: [] }));
    expect(await waitForPixel(h.map, meshCenter, POINT_COLOR)).toEqual(POINT_COLOR);
    return h;
  };

  /** 地図の要素の中の位置に、マウスの事象を送る */
  const mouse = (
    h: MapHandle,
    type: string,
    x: number,
    y: number,
    options: MouseEventInit = {},
    target: EventTarget = h.map.getCanvasContainer(),
  ): void => {
    const rect = h.map.getCanvasContainer().getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + x,
        clientY: rect.top + y,
        ...options,
      }),
    );
  };

  /**
   * ポインタを動かす。ブラウザと同じく、pointermove（deck.gl が地図のキャンバスで聞く）と
   * mousemove（MapLibre が地図の要素で聞く）の両方を送る
   */
  const move = (h: MapHandle, x: number, y: number): void => {
    const canvas = h.map.getCanvas();
    mouse(h, "pointermove", x, y, {}, canvas);
    mouse(h, "mousemove", x, y, {}, canvas);
  };

  const leave = (h: MapHandle, x: number, y: number): void => {
    const canvas = h.map.getCanvas();
    mouse(h, "pointerleave", x, y, { relatedTarget: document.body }, canvas);
    mouse(h, "mouseout", x, y, { relatedTarget: document.body }, canvas);
  };

  /** events に条件に合う知らせが届くまで、フレームを描かせて待つ */
  const waitFor = async (
    h: MapHandle,
    events: readonly MapPointerEvent[],
    from: number,
    match: (e: MapPointerEvent) => boolean,
  ): Promise<MapPointerEvent> => {
    for (let i = 0; i < 60; i++) {
      const found = events.slice(from).find(match);
      if (found !== undefined) {
        return found;
      }
      await new Promise((resolve) => {
        h.map.once("render", resolve);
        h.map.triggerRepaint();
      });
    }
    throw new Error(`届かなかった: ${JSON.stringify(events.slice(from))}`);
  };

  const isHover = (e: MapPointerEvent): e is Extract<MapPointerEvent, { kind: "hover" }> =>
    e.kind === "hover";

  it("自前データの点を拾い、ポインタの経緯度と一緒に知らせる。地図の外に出たら leave を知らせる", async () => {
    const h = await startWithPoint();
    const events: MapPointerEvent[] = [];
    const stop = watchPointer(h, (e) => events.push(e));
    const at = h.map.project(meshCenter);

    move(h, at.x, at.y);
    const onPoint = await waitFor(h, events, 0, isHover);
    if (!isHover(onPoint)) throw new Error("hover でない");
    expect(onPoint.hit.feature).toMatchObject({ layerId: POINT_LAYER, index: 0 });
    expect(onPoint.hit.lon).toBeCloseTo(meshCenter[0], 3);
    expect(onPoint.hit.lat).toBeCloseTo(meshCenter[1], 3);
    // admin.pmtiles を置いていないので、市区町村の塗りの地物はない
    expect(onPoint.hit.municipalityCode).toBeNull();
    expect(onPoint).toMatchObject({ width: 400, height: 300 });

    const before = events.length;
    move(h, at.x + 60, at.y);
    const away = await waitFor(h, events, before, isHover);
    expect(isHover(away) && away.hit.feature).toBeNull();

    const left = events.length;
    leave(h, at.x + 60, at.y);
    expect(events.slice(left)).toEqual([{ kind: "leave" }]);
    stop();
  });

  it("地図が動き始めたら leave を知らせ、動いているあいだは知らせず、動き終えたあとはポインタが動くと知らせる", async () => {
    const h = await startWithPoint();
    const events: MapPointerEvent[] = [];
    const stop = watchPointer(h, (e) => events.push(e));
    const at = h.map.project(meshCenter);
    move(h, at.x, at.y);
    await waitFor(h, events, 0, isHover);

    const moved = new Promise((resolve) => h.map.once("moveend", resolve));
    const before = events.length;
    h.map.easeTo({ zoom: h.map.getZoom() + 0.5, duration: 200 });
    // 動いているあいだにポインタを動かしても知らせない
    for (let i = 0; i < 5; i++) {
      move(h, at.x + i, at.y);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await moved;
    // 動き終えただけでは引き直さない
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    expect(events.slice(before)).toEqual([{ kind: "leave" }]);
    // ポインタが動けば知らせる。ズームの中心の点は同じ位置に残る
    move(h, at.x, at.y);
    const after = await waitFor(h, events, before + 1, isHover);
    expect(isHover(after) && after.hit.feature).toMatchObject({ layerId: POINT_LAYER });
    stop();
  });

  it("ドラッグで地図を動かしても click にならない（MapLibre の clickTolerance）", async () => {
    const h = await startWithPoint();
    const events: MapPointerEvent[] = [];
    const stop = watchPointer(h, (e) => events.push(e));
    const clicks: unknown[] = [];
    h.map.on("click", (e) => clicks.push(e));

    // 動かさずに押して離すと click になる
    mouse(h, "mousedown", 100, 100, { button: 0, buttons: 1 });
    mouse(h, "mouseup", 100, 100, { button: 0, buttons: 0 });
    mouse(h, "click", 100, 100, { button: 0 });
    expect(clicks).toHaveLength(1);

    // 20px 動かして離すと、地図は動くが click にはならない
    const moved = new Promise((resolve) => h.map.once("moveend", resolve));
    mouse(h, "mousedown", 100, 100, { button: 0, buttons: 1 });
    for (const x of [105, 110, 115, 120]) {
      mouse(h, "mousemove", x, 100, { button: 0, buttons: 1 }, document);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    mouse(h, "mouseup", 120, 100, { button: 0, buttons: 0 });
    mouse(h, "click", 120, 100, { button: 0 });
    await moved;
    expect(clicks).toHaveLength(1);
    expect(events.map((e) => e.kind)).toContain("leave");
    stop();
  });

  it("やめたあとは知らせない", async () => {
    const h = await startWithPoint();
    const events: MapPointerEvent[] = [];
    watchPointer(h, (e) => events.push(e))();
    const at = h.map.project(meshCenter);
    move(h, at.x, at.y);
    leave(h, at.x, at.y);
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    expect(events).toEqual([]);
  });
});
