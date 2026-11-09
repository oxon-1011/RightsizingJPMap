import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MESH_AGE_YEARS, MESH_YEARS, MUNICIPAL_YEARS } from "../core/data/schema";
import { trackYears, yearAtRatio, yearForKey, yearRatio } from "./year-slider";

describe("trackYears", () => {
  it("メッシュは 2020〜2070 年、市区町村は 2020〜2050 年", () => {
    expect(trackYears("mesh")).toEqual(MESH_YEARS);
    expect(trackYears("municipality")).toEqual(MUNICIPAL_YEARS);
  });
});

describe("yearRatio", () => {
  it("2050 年はメッシュのトラックの 6/10 の位置（Figma のスライダーと同じ）", () => {
    expect(yearRatio(2050, MESH_YEARS)).toBeCloseTo(0.6);
    expect(yearRatio(2020, MESH_YEARS)).toBe(0);
    expect(yearRatio(2070, MESH_YEARS)).toBe(1);
  });

  it("市区町村では 2050 年が右端", () => {
    expect(yearRatio(2050, MUNICIPAL_YEARS)).toBe(1);
  });
});

describe("yearAtRatio", () => {
  it("位置に最も近い選べる年にする", () => {
    expect(yearAtRatio(0.6, MESH_YEARS, MESH_YEARS)).toBe(2050);
    expect(yearAtRatio(0.62, MESH_YEARS, MESH_YEARS)).toBe(2050);
    expect(yearAtRatio(0.66, MESH_YEARS, MESH_YEARS)).toBe(2055);
  });

  it("年齢別の指標では、メッシュの左端でも 2025 年にする", () => {
    expect(yearAtRatio(0, MESH_YEARS, MESH_AGE_YEARS)).toBe(2025);
  });

  it("トラックの外の位置は端に寄せる", () => {
    expect(yearAtRatio(-0.5, MESH_YEARS, MESH_YEARS)).toBe(2020);
    expect(yearAtRatio(1.5, MESH_YEARS, MESH_YEARS)).toBe(2070);
  });

  it("どの位置でも選べる年を返す", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (ratio) => {
        expect(MESH_AGE_YEARS).toContain(yearAtRatio(ratio, MESH_YEARS, MESH_AGE_YEARS));
      }),
    );
  });

  it("yearRatio の位置から元の年に戻る", () => {
    for (const year of MESH_YEARS) {
      expect(yearAtRatio(yearRatio(year, MESH_YEARS), MESH_YEARS, MESH_YEARS)).toBe(year);
    }
  });
});

describe("yearForKey", () => {
  it("矢印のキーで5年ずつ動かす", () => {
    expect(yearForKey("ArrowRight", 2050, MESH_YEARS)).toBe(2055);
    expect(yearForKey("ArrowUp", 2050, MESH_YEARS)).toBe(2055);
    expect(yearForKey("ArrowLeft", 2050, MESH_YEARS)).toBe(2045);
    expect(yearForKey("ArrowDown", 2050, MESH_YEARS)).toBe(2045);
  });

  it("PageUp と PageDown で 10 年ずつ動かし、端を越えない", () => {
    expect(yearForKey("PageUp", 2050, MESH_YEARS)).toBe(2060);
    expect(yearForKey("PageDown", 2025, MESH_YEARS)).toBe(2020);
    expect(yearForKey("PageUp", 2065, MESH_YEARS)).toBe(2070);
  });

  it("Home と End で端に動かす", () => {
    expect(yearForKey("Home", 2050, MESH_AGE_YEARS)).toBe(2025);
    expect(yearForKey("End", 2030, MUNICIPAL_YEARS)).toBe(2050);
  });

  it("端ではそれ以上動かさない", () => {
    expect(yearForKey("ArrowRight", 2070, MESH_YEARS)).toBe(2070);
    expect(yearForKey("ArrowLeft", 2025, MESH_AGE_YEARS)).toBe(2025);
  });

  it("スライダーで扱わないキーは null", () => {
    expect(yearForKey("Enter", 2050, MESH_YEARS)).toBeNull();
    expect(yearForKey("a", 2050, MESH_YEARS)).toBeNull();
  });
});
