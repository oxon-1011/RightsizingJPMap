import { describe, expect, it } from "vitest";
import { mergeColumn, mergeMeshCodes } from "./merge";

// 2つの都道府県のファイル。53380002 と 53380005 が県境のメッシュで、両方にある
const A = Uint32Array.of(53380001, 53380002, 53380005);
const B = Uint32Array.of(53380002, 53380004, 53380005, 53380009);

describe("mergeMeshCodes", () => {
  it("重複を除いて昇順に並べ、各ファイルの行の行き先を返す", () => {
    const merge = mergeMeshCodes([A, B]);
    expect([...merge.codes]).toEqual([53380001, 53380002, 53380004, 53380005, 53380009]);
    expect(merge.rows.map((rows) => [...rows])).toEqual([
      [0, 1, 3],
      [1, 2, 3, 4],
    ]);
  });

  it("ファイルが昇順でなくても、合わせた並びは昇順になる", () => {
    const merge = mergeMeshCodes([Uint32Array.of(3, 1), Uint32Array.of(2)]);
    expect([...merge.codes]).toEqual([1, 2, 3]);
    expect(merge.rows.map((rows) => [...rows])).toEqual([[2, 0], [1]]);
  });

  it("ファイルが1つなら、行の行き先は行の番号そのもの", () => {
    const merge = mergeMeshCodes([A]);
    expect([...merge.codes]).toEqual([...A]);
    expect([...(merge.rows[0] ?? [])]).toEqual([0, 1, 2]);
  });
});

describe("mergeColumn", () => {
  const merge = mergeMeshCodes([A, B]);

  it("列を合わせた並びにする。型は元の列と同じ", () => {
    const column = mergeColumn([Float32Array.of(1, 2, 5), Float32Array.of(2, 4, 5, 9)], merge);
    expect(column.ok && column.value).toBeInstanceOf(Float32Array);
    expect(column.ok && [...column.value]).toEqual([1, 2, 4, 5, 9]);
    const masked = mergeColumn([Uint8Array.of(0, 1, 0), Uint8Array.of(1, 0, 0, 1)], merge);
    expect(masked.ok && masked.value).toBeInstanceOf(Uint8Array);
    expect(masked.ok && [...masked.value]).toEqual([0, 1, 0, 0, 1]);
  });

  it("ファイルの数か行の数が合わなければ失敗", () => {
    expect(mergeColumn([Float32Array.of(1, 2, 5)], merge)).toEqual({
      ok: false,
      error: { kind: "shape-mismatch", part: null },
    });
    expect(mergeColumn([Float32Array.of(1, 2, 5), Float32Array.of(2, 4, 5)], merge)).toEqual({
      ok: false,
      error: { kind: "shape-mismatch", part: 1 },
    });
    expect(mergeColumn([], merge)).toEqual({
      ok: false,
      error: { kind: "shape-mismatch", part: null },
    });
  });

  it("数値の列でないか、ファイルによって型が違えば失敗", () => {
    expect(mergeColumn([["a", "b", "c"], Float32Array.of(2, 4, 5, 9)], merge)).toEqual({
      ok: false,
      error: { kind: "type-mismatch", part: 0 },
    });
    expect(mergeColumn([Float32Array.of(1, 2, 5), Float64Array.of(2, 4, 5, 9)], merge)).toEqual({
      ok: false,
      error: { kind: "type-mismatch", part: 1 },
    });
  });
});
