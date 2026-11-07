import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { latLonToMeshCode, MESH3_LAT_SIZE, MESH3_LON_SIZE, meshCodeToBounds } from "./mesh-code";

// 日本の範囲に入る3次メッシュコードを、桁ごとに組み立てて生成する
const meshCodeArb = fc
  .record({
    p: fc.integer({ min: 30, max: 68 }),
    u: fc.integer({ min: 22, max: 53 }),
    q: fc.integer({ min: 0, max: 7 }),
    v: fc.integer({ min: 0, max: 7 }),
    r: fc.integer({ min: 0, max: 9 }),
    w: fc.integer({ min: 0, max: 9 }),
  })
  .map(({ p, u, q, v, r, w }) => p * 1_000_000 + u * 10_000 + q * 1_000 + v * 100 + r * 10 + w);

// メッシュの内側の位置（境界から少し離す）
const insideArb = fc.double({ min: 0.001, max: 0.999, noNaN: true });

describe("latLonToMeshCode", () => {
  it("東京駅と札幌駅で、ベースデータに存在するメッシュのコードになる", () => {
    expect(latLonToMeshCode({ lat: 35.681236, lon: 139.767125 })).toBe(53394611);
    expect(latLonToMeshCode({ lat: 43.068661, lon: 141.350755 })).toBe(64414288);
  });

  it("メッシュの内側の点は、そのメッシュのコードに戻る", () => {
    fc.assert(
      fc.property(meshCodeArb, insideArb, insideArb, (code, fy, fx) => {
        const { south, west } = meshCodeToBounds(code);
        const lat = south + fy * MESH3_LAT_SIZE;
        const lon = west + fx * MESH3_LON_SIZE;
        expect(latLonToMeshCode({ lat, lon })).toBe(code);
      }),
    );
  });
});

describe("meshCodeToBounds", () => {
  it("範囲の大きさは緯度 30 秒、経度 45 秒になる", () => {
    fc.assert(
      fc.property(meshCodeArb, (code) => {
        const { south, west, north, east } = meshCodeToBounds(code);
        expect(north - south).toBeCloseTo(MESH3_LAT_SIZE, 12);
        expect(east - west).toBeCloseTo(MESH3_LON_SIZE, 12);
      }),
    );
  });
});
