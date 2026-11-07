import { describe, expect, it } from "vitest";
import {
  computeMunicipalIndicator,
  type MunicipalTable,
  paintedMunicipalCodes,
  parseMunicipalTable,
} from "./municipal";

const f64 = (...values: number[]) => Float64Array.from(values);

// 鳥取県（都道府県）、鳥取市、米子市の 2025 年と 2050 年
const columns = {
  code: ["31000", "31201", "31202", "31000", "31201", "31202"],
  area_type: ["a", "2", "2", "a", "2", "2"],
  year: f64(2025, 2025, 2025, 2050, 2050, 2050),
  pop: f64(540000, 180000, 0, 440000, 150000, 140000),
  p0_14: f64(60000, 20000, 0, 45000, 15000, 14000),
  p15_64: f64(300000, 100000, 0, 230000, 80000, 75000),
  p65: f64(180000, 60000, 0, 165000, 55000, 51000),
  p75: f64(100000, 33000, 0, 105000, 35000, 32000),
};

const table = (): MunicipalTable => {
  const parsed = parseMunicipalTable(columns);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.error));
  }
  return parsed.value;
};

describe("parseMunicipalTable", () => {
  it("同じ団体コードと年の行が2つあれば拒否する", () => {
    const duplicated = { ...columns, year: f64(2025, 2025, 2025, 2050, 2025, 2050) };
    expect(parseMunicipalTable(duplicated)).toEqual({
      ok: false,
      error: { kind: "duplicate-row", code: "31201", year: 2025 },
    });
  });

  it("文字列であるべき列が数値なら拒否する", () => {
    expect(parseMunicipalTable({ ...columns, code: f64(1, 2, 3, 4, 5, 6) })).toEqual({
      ok: false,
      error: { kind: "not-string-column", column: "code" },
    });
  });
});

describe("paintedMunicipalCodes", () => {
  it("都道府県の行を除く", () => {
    expect([...paintedMunicipalCodes(table())].sort()).toEqual(["31201", "31202"]);
  });
});

describe("computeMunicipalIndicator", () => {
  it("地図で塗る単位だけに値を付ける", () => {
    const result = computeMunicipalIndicator(table(), "pop", 2050);
    expect(result).toEqual({
      ok: true,
      value: new Map([
        ["31201", 150000],
        ["31202", 140000],
      ]),
    });
  });

  it("高齢化率の分母が 0 なら NaN", () => {
    const result = computeMunicipalIndicator(table(), "aging_rate", 2025);
    if (!result.ok) {
      throw new Error("失敗した");
    }
    expect(result.value.get("31201")).toBeCloseTo(60000 / 180000, 12);
    expect(result.value.get("31202")).toBeNaN();
  });

  it("増減率は 2025 年の値で割り、2025 年が 0 なら NaN", () => {
    const result = computeMunicipalIndicator(table(), "elderly_change", 2050);
    if (!result.ok) {
      throw new Error("失敗した");
    }
    expect(result.value.get("31201")).toBeCloseTo(55000 / 60000 - 1, 12);
    expect(result.value.get("31202")).toBeNaN();
  });

  it("2050 年より後は選べない", () => {
    expect(computeMunicipalIndicator(table(), "pop", 2055)).toEqual({
      ok: false,
      error: { kind: "unavailable-year", id: "pop", year: 2055 },
    });
  });
});
