import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classIndex } from "../classify/classify";
import { TRANSPARENT } from "../classify/color";
import { classificationOf, DADS_ORANGE_6 } from "../classify/scales";
import { buildMeshGeometry, MESH_RING_VERTEX_COUNT } from "../mesh/geometry";
import { adminFillSpec } from "./admin";
import { meshColorAt, meshLayerSpec, meshVertexColors } from "./mesh";
import { geoJsonLayerSpec, pointLayerSpec } from "./overlay";

const aging = classificationOf("aging_rate", "mesh");

describe("meshVertexColors", () => {
  it("値を階級の色にし、値なしを透明にする", () => {
    const colors = meshVertexColors(Float32Array.from([0.25, 0.55, Number.NaN, 0.8]), aging);
    expect(colors).toHaveLength(4 * MESH_RING_VERTEX_COUNT * 4);
    expect(meshColorAt(colors, 0)).toEqual(DADS_ORANGE_6[0]);
    expect(meshColorAt(colors, 1)).toEqual(DADS_ORANGE_6[3]);
    expect(meshColorAt(colors, 2)).toEqual(TRANSPARENT);
    expect(meshColorAt(colors, 3)).toEqual(DADS_ORANGE_6[5]);
  });

  it("1つのメッシュの5つの頂点は同じ色で、色は階級の色か透明", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN)), { maxLength: 30 }),
        (values) => {
          const colors = meshVertexColors(values, aging);
          values.forEach((value, i) => {
            const expected = Number.isNaN(value)
              ? TRANSPARENT
              : aging.colors[classIndex(value, aging.breaks)];
            for (let v = 0; v < MESH_RING_VERTEX_COUNT; v++) {
              const o = (i * MESH_RING_VERTEX_COUNT + v) * 4;
              expect([...colors.subarray(o, o + 4)]).toEqual(expected);
            }
          });
        },
      ),
    );
  });
});

describe("meshLayerSpec", () => {
  it("メッシュの数と値の数が違えば例外を投げる", () => {
    const geometry = buildMeshGeometry([53394611]);
    expect(() =>
      meshLayerSpec({
        id: "mesh",
        geometry,
        values: [0.1, 0.2],
        classification: aging,
        colorKey: "aging_rate/2050",
        visible: true,
      }),
    ).toThrow();
  });
});

describe("adminFillSpec", () => {
  it("すべての地域に色を付け、値なしは透明にする", () => {
    const spec = adminFillSpec(
      new Map([
        ["31201", 0.35],
        ["31202", Number.NaN],
      ]),
      aging,
      true,
    );
    expect(spec.sourceLayer).toBe("muni");
    expect(spec.promoteId).toBe("code");
    expect(spec.colors).toEqual(
      new Map([
        ["31201", DADS_ORANGE_6[1]],
        ["31202", TRANSPARENT],
      ]),
    );
  });
});

describe("pointLayerSpec", () => {
  it("経度と緯度を交互に並べる", () => {
    const spec = pointLayerSpec("d1", [35.6, 43.0], [139.7, 141.3], {
      color: "#0072b2",
      size: 4,
      visible: true,
    });
    expect([...spec.positions]).toEqual([139.7, 35.6, 141.3, 43.0]);
    expect(spec.color).toEqual([0, 114, 178, 255]);
    expect(spec.radiusPixels).toBe(4);
  });
});

describe("geoJsonLayerSpec", () => {
  it("面には半透明の塗りを付け、線には付けない", () => {
    const style = { color: "#009e73", size: 2, visible: false };
    expect(geoJsonLayerSpec("p", "polygon", style).fillColor).toEqual([0, 158, 115, 32]);
    expect(geoJsonLayerSpec("l", "line", style).fillColor).toBeNull();
  });
});
