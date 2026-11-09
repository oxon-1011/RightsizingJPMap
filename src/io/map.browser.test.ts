import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSPARENT } from "../core/classify/color";
import { classificationOf, DADS_ORANGE_6 } from "../core/classify/scales";
import type { BBox } from "../core/data/schema";
import { buildMeshGeometry } from "../core/mesh/geometry";
import { meshCodeToBounds } from "../core/mesh/mesh-code";
import { adminFillSpec } from "../core/render/admin";
import { meshLayerSpec } from "../core/render/mesh";
import type { Result } from "../core/result";
import {
  ADMIN_LAYER_IDS,
  ADMIN_SOURCE_ID,
  type MapHandle,
  setAdminFill,
  setOverlayLayers,
  startMap,
  stopMap,
} from "./map";

// ネットワークに頼らないよう、背景地図は背景色だけのスタイルにする。
// choropleth と boundary の位置は、描かない背景のレイヤーで示す。
// admin.pmtiles は置いていないので、タイルの取得は失敗する（MapLibre がコンソールに出す）。
// feature-state はタイルがなくても読み書きできるので、塗りの検査には差し支えない。

const SEA: readonly [number, number, number, number] = [230, 230, 230, 255];

const baseStyle = (metadata: unknown) => ({
  version: 8,
  metadata,
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "rgb(230,230,230)" } },
    { id: "road", type: "background", paint: { "background-opacity": 0 } },
    { id: "label", type: "background", paint: { "background-opacity": 0 } },
  ],
});

const VALID_METADATA = { "rjm:insertBefore": { choropleth: "road", boundary: "label" } };

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

const start = (style: unknown, url = styleUrl(style)) =>
  startMap({
    container,
    styleUrl: url,
    adminTilesUrl: new URL("/no-such-admin.pmtiles", window.location.href).href,
    bounds: AROUND_MESH,
    attributionDetailsUrl: "#sources",
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
      ADMIN_LAYER_IDS.prefectureFill,
      ADMIN_LAYER_IDS.municipalityFill,
      "road",
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

  it("metadata に差し込む位置がなければ style-contract を返し、地図を片付ける", async () => {
    const result = await start(baseStyle({}));
    expect(result.ok ? null : result.error.kind).toBe("style-contract");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("差し込む位置のレイヤーがスタイルになければ style-contract を返す", async () => {
    const result = await start(
      baseStyle({ "rjm:insertBefore": { choropleth: "road", boundary: "no-such-layer" } }),
    );
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "style-contract",
      message: expect.stringContaining("no-such-layer"),
    });
  });

  it("スタイルを読めなければ style-failed を返す", async () => {
    const result = await start(null, new URL("/no-such-style.json", window.location.href).href);
    expect(result.ok ? null : result.error.kind).toBe("style-failed");
    expect(container.querySelector("canvas")).toBeNull();
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
    // deck.gl のレイヤーは、choropleth の位置（road の直前）に入る
    expect(h.map.getLayer("deck-layer-group-before:road")).toBeDefined();

    show(0.8, "high");
    expect(await waitForPixel(h.map, meshCenter, DADS_ORANGE_6[5] ?? [])).toEqual(DADS_ORANGE_6[5]);

    show(Number.NaN, "none");
    expect(await waitForPixel(h.map, meshCenter, SEA)).toEqual(SEA);
  });
});
