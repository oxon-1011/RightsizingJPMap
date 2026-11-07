import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MESH_AGE_YEARS } from "../data/schema";
import { INDICATOR_IDS, meshColumnsToRead, usesAgeGroups } from "./definitions";
import { computeMeshIndicator } from "./mesh";

const f32 = (...values: number[]) => Float32Array.from(values);
const bool = (...values: number[]) => Uint8Array.from(values);

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) {
    throw new Error(`失敗した: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

describe("computeMeshIndicator", () => {
  const columns = {
    "2025_pop": f32(100, 50, 10, 0),
    "2050_pop": f32(80, 0, 20, 5),
    "2025_p65": f32(30, 20, 2, 0),
    "2050_p65": f32(40, 0, 6, 1),
    "2025_masked": bool(0, 0, 1, 0),
    "2050_masked": bool(0, 0, 0, 1),
  };

  it("総人口は秘匿の有無にかかわらず値を持つ（D7）", () => {
    const values = unwrap(computeMeshIndicator("pop", 2050, columns, 4));
    expect([...values]).toEqual([80, 0, 20, 5]);
  });

  it("人口増減率は秘匿を見ず、分母が 0 なら NaN", () => {
    const values = unwrap(computeMeshIndicator("pop_change", 2050, columns, 4));
    expect(values[0]).toBeCloseTo(-0.2, 6);
    expect(values[1]).toBeCloseTo(-1, 6);
    expect(values[2]).toBeCloseTo(1, 6);
    expect(values[3]).toBeNaN();
  });

  it("高齢化率は、その年に秘匿なら NaN、総人口が 0 なら NaN", () => {
    const values = unwrap(computeMeshIndicator("aging_rate", 2050, columns, 4));
    expect(values[0]).toBeCloseTo(0.5, 6);
    expect(values[1]).toBeNaN();
    expect(values[2]).toBeCloseTo(0.3, 6);
    expect(values[3]).toBeNaN();
  });

  it("高齢者増加率は、どちらかの年が秘匿なら NaN", () => {
    const values = unwrap(computeMeshIndicator("elderly_change", 2050, columns, 4));
    expect(values[0]).toBeCloseTo(40 / 30 - 1, 6);
    expect(values[1]).toBeCloseTo(-1, 6);
    expect(values[2]).toBeNaN();
    expect(values[3]).toBeNaN();
  });

  it("NULL（NaN）の値は NaN のまま", () => {
    const values = unwrap(computeMeshIndicator("pop", 2025, { "2025_pop": f32(Number.NaN) }, 1));
    expect(values[0]).toBeNaN();
  });

  it("選べない年、足りない列、長さの違う列、文字列の列は失敗にする", () => {
    expect(computeMeshIndicator("p65", 2020, columns, 4)).toEqual({
      ok: false,
      error: { kind: "unavailable-year", id: "p65", year: 2020 },
    });
    expect(computeMeshIndicator("pop", 2030, columns, 4)).toEqual({
      ok: false,
      error: { kind: "missing-column", column: "2030_pop" },
    });
    expect(computeMeshIndicator("pop", 2025, columns, 3)).toEqual({
      ok: false,
      error: { kind: "length-mismatch", column: "2025_pop", expected: 3, actual: 4 },
    });
    expect(computeMeshIndicator("pop", 2025, { "2025_pop": ["1"] }, 1)).toEqual({
      ok: false,
      error: { kind: "not-numeric-column", column: "2025_pop" },
    });
  });
});

describe("computeMeshIndicator の性質", () => {
  const ageIndicators = INDICATOR_IDS.filter(usesAgeGroups);
  const value = fc.oneof(
    fc.float({ min: 0, max: 20000, noNaN: true }),
    fc.constant(0),
    fc.constant(Number.NaN),
  );
  const row = fc.record({ v: value, m: fc.boolean() });

  it("年齢別の指標では、計算に使う年のどれかで秘匿なら必ず NaN", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ageIndicators),
        fc.constantFrom(...MESH_AGE_YEARS),
        fc.array(row, { minLength: 1, maxLength: 20 }),
        (id, year, rows) => {
          // 読む列をすべて、メッシュごとの乱数で埋める。秘匿の列も同じ
          const names = meshColumnsToRead(id, year);
          const columns = Object.fromEntries(
            names.map((name, k) => {
              const shifted = rows.map((_, i) => rows[(i + k) % rows.length] ?? { v: 0, m: false });
              return name.endsWith("_masked")
                ? [name, Uint8Array.from(shifted, (r) => (r.m ? 1 : 0))]
                : [name, Float32Array.from(shifted, (r) => r.v)];
            }),
          );
          const values = unwrap(computeMeshIndicator(id, year, columns, rows.length));
          const maskedNames = names.filter((name) => name.endsWith("_masked"));
          for (let i = 0; i < rows.length; i++) {
            const masked = maskedNames.some((name) => columns[name]?.[i] === 1);
            if (masked) {
              expect(values[i]).toBeNaN();
            }
          }
        },
      ),
    );
  });
});
