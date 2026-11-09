import { describe, expect, it } from "vitest";
import { classificationOf } from "../core/classify/scales";
import { buildMeshGeometry } from "../core/mesh/geometry";
import { meshLayerSpec } from "../core/render/mesh";
import { geoJsonLayerSpec, pointLayerSpec } from "../core/render/overlay";
import {
  geoJsonLayer,
  meshLayer,
  type OverlayGeoJson,
  overlayDeckLayers,
  parseOverlayGeoJson,
  pointLayer,
} from "./deck-layers";

const geometry = buildMeshGeometry([53394611, 53394612]);
const aging = classificationOf("aging_rate", "mesh");

const meshSpec = (values: readonly number[], colorKey: string, g = geometry) =>
  meshLayerSpec({
    id: "mesh",
    geometry: g,
    values,
    classification: aging,
    colorKey,
    visible: true,
  });

const geoJson = (text: string): OverlayGeoJson => {
  const parsed = parseOverlayGeoJson(new TextEncoder().encode(text));
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
};

const polygon = geoJson(
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [139, 35],
              [140, 35],
              [140, 36],
              [139, 35],
            ],
          ],
        },
      },
    ],
  }),
);

describe("meshLayer", () => {
  it("形と色の配列をバイナリ形式で渡し、色の鍵を updateTriggers にする", () => {
    const spec = meshSpec([0.25, 0.55], "aging_rate/2050");
    const layer = meshLayer(spec, "road");
    expect(layer.props.data).toEqual({
      length: 2,
      startIndices: geometry.startIndices,
      attributes: {
        getPolygon: { value: geometry.positions, size: 2 },
        indices: geometry.indices,
        getFillColor: { value: spec.fillColors, size: 4, normalized: true },
      },
    });
    expect(layer.props._normalize).toBe(false);
    expect(layer.props.updateTriggers).toEqual({ getFillColor: "aging_rate/2050" });
    expect(layer.props).toMatchObject({ id: "mesh", beforeId: "road", visible: true });
  });

  it("同じ形から作った data は、色が違っても変わっていないとみなす", () => {
    const a = meshLayer(meshSpec([0.25, 0.55], "a"), "road");
    const b = meshLayer(meshSpec([0.75, 0.15], "b"), "road");
    expect(b.props.dataComparator?.(b.props.data, a.props.data)).toBe(true);
  });

  it("別の形から作った data は、変わったとみなす", () => {
    const other = buildMeshGeometry([53394611, 53394612]);
    const a = meshLayer(meshSpec([0.25, 0.55], "a"), "road");
    const b = meshLayer(meshSpec([0.25, 0.55], "a", other), "road");
    expect(b.props.dataComparator?.(b.props.data, a.props.data)).toBe(false);
  });
});

describe("pointLayer", () => {
  const style = { color: "#1d4ed8", size: 4, visible: true };

  it("座標をバイナリ形式で渡し、色と大きさをピクセルで指定する", () => {
    const spec = pointLayerSpec("p", [35, 36], [139, 140], style);
    const layer = pointLayer(spec);
    expect(layer.props.data).toEqual({
      length: 2,
      attributes: { getPosition: { value: spec.positions, size: 2 } },
    });
    expect(layer.props.getFillColor).toEqual([29, 78, 216, 255]);
    expect(layer.props.getRadius).toBe(4);
    expect(layer.props.radiusUnits).toBe("pixels");
  });

  it("同じ座標の配列には同じ data を渡す", () => {
    const spec = pointLayerSpec("p", [35], [139], style);
    const restyled = { ...spec, radiusPixels: 8 };
    expect(pointLayer(restyled).props.data).toBe(pointLayer(spec).props.data);
  });
});

describe("geoJsonLayer", () => {
  it("面は半透明で塗り、枠を描く", () => {
    const spec = geoJsonLayerSpec("g", "polygon", { color: "#047857", size: 2, visible: true });
    const layer = geoJsonLayer({ spec, data: polygon });
    expect(layer.props.filled).toBe(true);
    expect(layer.props.getFillColor).toEqual(spec.fillColor);
    expect(layer.props.getLineColor).toEqual([4, 120, 87, 255]);
    expect(layer.props.getLineWidth).toBe(2);
    expect(layer.props.lineWidthUnits).toBe("pixels");
  });

  it("線は塗らない", () => {
    const spec = geoJsonLayerSpec("g", "line", { color: "#047857", size: 2, visible: true });
    expect(geoJsonLayer({ spec, data: polygon }).props.filled).toBe(false);
  });
});

describe("overlayDeckLayers", () => {
  it("メッシュ、線と面、点の順に並べ、メッシュがなければ省く", () => {
    const style = { color: "#1d4ed8", size: 4, visible: true };
    const points = [pointLayerSpec("p", [35], [139], style)];
    const geoJsons = [{ spec: geoJsonLayerSpec("g", "polygon", style), data: polygon }];
    const mesh = meshSpec([0.25, 0.55], "a");
    expect(overlayDeckLayers({ mesh, points, geoJsons }, "road").map((l) => l.id)).toEqual([
      "mesh",
      "g",
      "p",
    ]);
    expect(overlayDeckLayers({ mesh: null, points, geoJsons }, "road").map((l) => l.id)).toEqual([
      "g",
      "p",
    ]);
  });
});

describe("parseOverlayGeoJson", () => {
  it("JSON として読めなければ失敗を返す", () => {
    const result = parseOverlayGeoJson(new TextEncoder().encode("{"));
    expect(result.ok).toBe(false);
  });
});
