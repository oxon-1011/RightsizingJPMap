import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkGeoJson } from "./geojson";
import { MAX_REPORTED_POSITIONS } from "./violation";

const point = (lon: number, lat: number, properties: Record<string, unknown> | null = {}) => ({
  type: "Feature",
  properties,
  geometry: { type: "Point", coordinates: [lon, lat] },
});

const square = (lon: number, lat: number) => ({
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [lon, lat],
        [lon, lat + 0.1],
        [lon + 0.1, lat + 0.1],
        [lon + 0.1, lat],
        [lon, lat],
      ],
    ],
  },
});

const collection = (features: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "FeatureCollection",
  features,
  ...extra,
});

describe("checkGeoJson", () => {
  it("点の FeatureCollection から、座標と数値の属性の列を作る", () => {
    const result = checkGeoJson(
      collection([
        point(139.767125, 35.681236, { name: "東京駅", beds: 10 }),
        point(141.350755, 43.068661, { name: "札幌駅", beds: null }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.geometryKind).toBe("point");
    expect(result.value.featureCount).toBe(2);
    expect(result.value.attributes).toEqual([
      { name: "name", type: "string" },
      { name: "beds", type: "float" },
    ]);
    expect([...(result.value.points?.lat ?? [])]).toEqual([35.681236, 43.068661]);
    expect([...(result.value.points?.lon ?? [])]).toEqual([139.767125, 141.350755]);
    const { beds } = result.value.points?.numeric ?? {};
    expect([...(beds ?? [])]).toEqual([10, Number.NaN]);
  });

  it("面は点の列を作らない", () => {
    const result = checkGeoJson(collection([square(139, 35)]));
    expect(result).toMatchObject({ ok: true, value: { geometryKind: "polygon", points: null } });
  });

  it("FeatureCollection でなければ拒否する", () => {
    expect(checkGeoJson(point(139, 35))).toEqual({
      ok: false,
      error: { kind: "not-feature-collection" },
    });
    expect(checkGeoJson(null)).toEqual({ ok: false, error: { kind: "not-feature-collection" } });
    expect(checkGeoJson({ type: "FeatureCollection" })).toEqual({
      ok: false,
      error: { kind: "not-feature-collection" },
    });
  });

  it("crs は CRS84 だけを受け付ける", () => {
    const crs = (name: string) => ({ crs: { type: "name", properties: { name } } });
    const features = [point(139, 35)];
    expect(checkGeoJson(collection(features, crs("urn:ogc:def:crs:OGC:1.3:CRS84"))).ok).toBe(true);
    expect(checkGeoJson(collection(features, crs("urn:ogc:def:crs:EPSG::4326")))).toEqual({
      ok: false,
      error: { kind: "unsupported-crs" },
    });
    expect(checkGeoJson(collection(features, { crs: null }))).toEqual({
      ok: false,
      error: { kind: "unsupported-crs" },
    });
  });

  it("地物が1つもなければ拒否する", () => {
    expect(checkGeoJson(collection([]))).toEqual({ ok: false, error: { kind: "no-features" } });
  });

  it("地物ごとの違反を、最初に満たさなかった条件で数える", () => {
    const result = checkGeoJson(
      collection([
        point(139, 35),
        { type: "Feature", properties: {}, geometry: null },
        { type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [] } },
        point(35.68, 139.76), // 緯度と経度の入れ違い
        point(-15000, 30000), // 投影座標
        square(139, 35), // 最初の地物と違う種類
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [139] } },
        { type: "Point", coordinates: [139, 35] },
        { ...point(139, 35), properties: "x" },
      ]),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-features",
        violations: [
          { condition: "feature", positions: [7, 8], count: 2 },
          { condition: "geometry-null", positions: [1], count: 1 },
          { condition: "geometry-type", positions: [2], count: 1 },
          { condition: "coordinates", positions: [6], count: 1 },
          { condition: "coordinate-range", positions: [3, 4], count: 2 },
          { condition: "single-geometry-kind", positions: [5], count: 1 },
        ],
      },
    });
  });

  it("閉じていない輪と、頂点の足りない線を拒否する", () => {
    const open = square(139, 35);
    open.geometry.coordinates[0]?.pop();
    const shortLine = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[139, 35]] },
    };
    expect(checkGeoJson(collection([open]))).toMatchObject({
      ok: false,
      error: { violations: [{ condition: "coordinates", positions: [0] }] },
    });
    expect(checkGeoJson(collection([shortLine]))).toMatchObject({
      ok: false,
      error: { violations: [{ condition: "coordinates", positions: [0] }] },
    });
  });

  it("線と、線の Multi は同じ種類として扱う", () => {
    const line = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [139, 35],
          [139.1, 35.1],
        ],
      },
    };
    const multi = {
      type: "Feature",
      properties: null,
      geometry: { type: "MultiLineString", coordinates: [line.geometry.coordinates] },
    };
    expect(checkGeoJson(collection([line, multi]))).toMatchObject({
      ok: true,
      value: { geometryKind: "line" },
    });
  });

  it("範囲の外の座標を持つ地物はすべて数えられ、先頭から5件が報告される", () => {
    const feature = fc.oneof(
      fc
        .record({
          lon: fc.double({ min: 122, max: 154, noNaN: true }),
          lat: fc.double({ min: 20, max: 46, noNaN: true }),
        })
        .map(({ lon, lat }) => ({ feature: point(lon, lat), valid: true })),
      fc
        .record({
          lon: fc.double({ min: -180, max: 121.9, noNaN: true }),
          lat: fc.double({ min: -90, max: 90, noNaN: true }),
        })
        .map(({ lon, lat }) => ({ feature: point(lon, lat), valid: false })),
    );
    fc.assert(
      fc.property(fc.array(feature, { minLength: 1, maxLength: 40 }), (features) => {
        const result = checkGeoJson(collection(features.map((f) => f.feature)));
        const invalid = features.flatMap((f, i) => (f.valid ? [] : [i]));
        if (invalid.length === 0) {
          expect(result.ok).toBe(true);
        } else {
          expect(result).toEqual({
            ok: false,
            error: {
              kind: "invalid-features",
              violations: [
                {
                  condition: "coordinate-range",
                  positions: invalid.slice(0, MAX_REPORTED_POSITIONS),
                  count: invalid.length,
                },
              ],
            },
          });
        }
      }),
    );
  });
});
