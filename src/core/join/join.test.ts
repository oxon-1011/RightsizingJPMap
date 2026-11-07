import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAdminGeomIndex, prefecturesForPoints } from "./admin";
import {
  aggregateByCode,
  aggregateByMesh,
  aggregatePointsByMesh,
  measureValues,
} from "./aggregate";
import {
  completeCodeValues,
  indexMeshes,
  perPopulationByCode,
  perPopulationByMesh,
} from "./per-population";

const sum = (aggregate: { readonly sums: Readonly<Record<string, Float64Array>> }, name: string) =>
  new Map(Object.entries(aggregate.sums)).get(name);

describe("aggregatePointsByMesh", () => {
  it("点を入るメッシュごとに数え、数値の列を合計する", () => {
    // 東京駅の近くに2点、札幌駅に1点
    const result = aggregatePointsByMesh(
      [35.681236, 35.6813, 43.068661],
      [139.767125, 139.7672, 141.350755],
      { beds: [10, Number.NaN, 5] },
    );
    expect([...result.keys]).toEqual([53394611, 64414288]);
    expect([...result.counts]).toEqual([2, 1]);
    expect([...(sum(result, "beds") ?? [])]).toEqual([10, 5]);
  });
});

describe("aggregateByMesh", () => {
  it("値がすべて NULL の単位の合計は NaN", () => {
    const result = aggregateByMesh([53394611, 53394611], { beds: [Number.NaN, Number.NaN] });
    expect([...result.counts]).toEqual([2]);
    expect(sum(result, "beds")?.[0]).toBeNaN();
  });

  it("件数の合計は行の数で、メッシュは昇順で重ならない", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ mesh: fc.constantFrom(53394611, 53394612, 64414288), v: fc.integer() }),
        ),
        (rows) => {
          const result = aggregateByMesh(
            rows.map((r) => r.mesh),
            { v: rows.map((r) => r.v) },
          );
          expect(result.counts.reduce((a, b) => a + b, 0)).toBe(rows.length);
          const keys = [...result.keys];
          expect(keys).toEqual([...new Set(keys)].sort((a, b) => a - b));
          keys.forEach((mesh, i) => {
            const own = rows.filter((r) => r.mesh === mesh);
            expect(sum(result, "v")?.[i]).toBe(own.reduce((a, r) => a + r.v, 0));
          });
        },
      ),
    );
  });
});

describe("aggregateByCode", () => {
  it("どの行政区域にも入らなかった点は数えず、skipped に数える", () => {
    const result = aggregateByCode(["31202", null, "31201", "31202"], { beds: [1, 2, 3, 4] });
    expect(result.keys).toEqual(["31201", "31202"]);
    expect([...result.counts]).toEqual([1, 2]);
    expect([...(sum(result, "beds") ?? [])]).toEqual([3, 5]);
    expect(result.skipped).toBe(1);
  });

  it("measureValues で件数か合計の列を取り出す", () => {
    const result = aggregateByCode(["31201"], { beds: [7] });
    expect([...(measureValues(result, { kind: "count" }) ?? [])]).toEqual([1]);
    expect([...(measureValues(result, { kind: "sum", column: "beds" }) ?? [])]).toEqual([7]);
    expect(measureValues(result, { kind: "sum", column: "none" })).toBeNull();
    expect(measureValues(result, { kind: "sum", column: "constructor" })).toBeNull();
  });
});

describe("perPopulationByMesh", () => {
  const lookup = indexMeshes([53394611, 53394612, 53394613]);
  const baseValues = Float32Array.from([2000, 0, Number.NaN]);

  it("分母が 0、NaN（秘匿）、ベースデータにないメッシュは NaN", () => {
    const values = perPopulationByMesh({
      meshes: [53394611, 53394612, 53394613, 99999999],
      numerators: [4, 1, 1, 1],
      lookup,
      baseValues,
      per: 1000,
    });
    expect(values[0]).toBeCloseTo(2, 6);
    expect(values[1]).toBeNaN();
    expect(values[2]).toBeNaN();
    expect(values[3]).toBeNaN();
  });
});

describe("perPopulationByCode", () => {
  it("ベースの値がない地域は NaN", () => {
    const values = perPopulationByCode({
      codes: ["31201", "31202"],
      numerators: [30, 1],
      baseValues: new Map([["31201", 60000]]),
      per: 1000,
    });
    expect(values.get("31201")).toBeCloseTo(0.5, 12);
    expect(values.get("31202")).toBeNaN();
  });
});

describe("completeCodeValues", () => {
  it("値のない地域を fill で埋める", () => {
    const all = new Set(["31201", "31202", "31203"]);
    expect(completeCodeValues(["31202"], [3], all, 0)).toEqual(
      new Map([
        ["31201", 0],
        ["31202", 3],
        ["31203", 0],
      ]),
    );
  });
});

describe("prefecturesForPoints", () => {
  const index = {
    "31": [133.1, 35.0, 134.5, 35.7],
    "32": [131.6, 34.3, 133.4, 37.3],
    "13": [136.0, 20.4, 153.99, 35.9],
  } as const;

  it("点を範囲に含む都道府県だけを、昇順で返す", () => {
    // 鳥取市と、鳥取県と島根県の範囲が重なる場所
    expect(prefecturesForPoints(index, [35.5, 35.4], [134.2, 133.2])).toEqual(["31", "32"]);
    expect(prefecturesForPoints(index, [], [])).toEqual([]);
  });
});

describe("parseAdminGeomIndex", () => {
  it("2桁のコードと、西南東北の順の範囲だけを受け付ける", () => {
    expect(parseAdminGeomIndex({ "31": [133.1, 35.0, 134.5, 35.7] })).toEqual({
      ok: true,
      value: { "31": [133.1, 35.0, 134.5, 35.7] },
    });
    expect(parseAdminGeomIndex({ "310": [133.1, 35.0, 134.5, 35.7] })).toEqual({
      ok: false,
      error: { kind: "invalid", key: "310" },
    });
    expect(parseAdminGeomIndex({ "31": [134.5, 35.0, 133.1, 35.7] })).toEqual({
      ok: false,
      error: { kind: "invalid", key: "31" },
    });
    expect(parseAdminGeomIndex([])).toEqual({ ok: false, error: { kind: "invalid", key: null } });
  });
});
