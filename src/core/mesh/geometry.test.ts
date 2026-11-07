import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildMeshGeometry, MESH_RING_VERTEX_COUNT, MESH_TRIANGLE_INDEX_COUNT } from "./geometry";
import { meshCodeToBounds } from "./mesh-code";

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

// @math.gl/polygon の getPolygonSignedArea と同じ式。正なら時計回り（WINDING.CLOCKWISE）
const signedArea = (ring: readonly (readonly [number, number])[]): number => {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    area += (xi - xj) * (yi + yj);
  }
  return area / 2;
};

const ringOf = (positions: Float64Array, start: number): (readonly [number, number])[] =>
  Array.from({ length: MESH_RING_VERTEX_COUNT }, (_, k) => [
    positions[(start + k) * 2] ?? Number.NaN,
    positions[(start + k) * 2 + 1] ?? Number.NaN,
  ]);

describe("buildMeshGeometry", () => {
  it("配列の長さと startIndices が SolidPolygonLayer の形にそろう", () => {
    const geometry = buildMeshGeometry(Uint32Array.from([53394611, 64414288]));
    expect(geometry.length).toBe(2);
    expect([...geometry.startIndices]).toEqual([0, 5, 10]);
    expect(geometry.positions).toHaveLength(2 * MESH_RING_VERTEX_COUNT * 2);
    expect(geometry.indices).toHaveLength(2 * MESH_TRIANGLE_INDEX_COUNT);
    expect([...geometry.indices]).toEqual([0, 1, 2, 0, 2, 3, 5, 6, 7, 5, 7, 8]);
  });

  it("空の配列からは空の形を作る", () => {
    const geometry = buildMeshGeometry([]);
    expect(geometry.length).toBe(0);
    expect([...geometry.startIndices]).toEqual([0]);
  });

  it("四角形の頂点は meshCodeToBounds の範囲の角と一致し、輪は閉じて時計回り", () => {
    fc.assert(
      fc.property(fc.array(meshCodeArb, { minLength: 1, maxLength: 30 }), (codes) => {
        const { positions, startIndices } = buildMeshGeometry(codes);
        codes.forEach((code, i) => {
          const { south, west, north, east } = meshCodeToBounds(code);
          const ring = ringOf(positions, startIndices[i] ?? 0);
          expect(ring).toEqual([
            [west, south],
            [west, north],
            [east, north],
            [east, south],
            [west, south],
          ]);
          expect(signedArea(ring)).toBeGreaterThan(0);
        });
      }),
    );
  });

  it("三角形の頂点の番号は、そのメッシュの輪の中を指す", () => {
    fc.assert(
      fc.property(fc.array(meshCodeArb, { maxLength: 30 }), (codes) => {
        const { indices, startIndices } = buildMeshGeometry(codes);
        codes.forEach((_, i) => {
          const start = startIndices[i] ?? 0;
          const own = indices.subarray(i * MESH_TRIANGLE_INDEX_COUNT, (i + 1) * 6);
          for (const index of own) {
            expect(index).toBeGreaterThanOrEqual(start);
            expect(index).toBeLessThan(start + MESH_RING_VERTEX_COUNT - 1);
          }
        });
      }),
    );
  });
});
