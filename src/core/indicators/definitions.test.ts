import { describe, expect, it } from "vitest";
import { MESH_AGE_YEARS, MESH_YEARS, MUNICIPAL_YEARS } from "../data/schema";
import { availableYears, INDICATOR_IDS, meshColumnsToRead, usesAgeGroups } from "./definitions";

describe("availableYears", () => {
  it("メッシュの年齢別の指標は 2025 年から、総数の指標は 2020 年から選べる", () => {
    expect(availableYears("mesh", "aging_rate")).toEqual(MESH_AGE_YEARS);
    expect(availableYears("mesh", "elderly_change")).toEqual(MESH_AGE_YEARS);
    expect(availableYears("mesh", "pop")).toEqual(MESH_YEARS);
    expect(availableYears("mesh", "pop_change")).toEqual(MESH_YEARS);
  });

  it("行政区域はどの指標も 2020〜2050 年", () => {
    for (const id of INDICATOR_IDS) {
      expect(availableYears("municipality", id)).toEqual(MUNICIPAL_YEARS);
    }
  });
});

describe("usesAgeGroups", () => {
  it("総人口と人口増減率だけが年齢別の値を使わない", () => {
    const totalOnly = INDICATOR_IDS.filter((id) => !usesAgeGroups(id));
    expect(totalOnly).toEqual(["pop", "pop_change"]);
  });
});

describe("meshColumnsToRead", () => {
  it("2050 年の高齢化率は、総人口、65 歳以上人口、秘匿の3列を読む", () => {
    expect(meshColumnsToRead("aging_rate", 2050)).toEqual(["2050_p65", "2050_masked", "2050_pop"]);
  });

  it("人口増減率は、その年と 2025 年の総人口を読み、秘匿の列は読まない", () => {
    expect(meshColumnsToRead("pop_change", 2070)).toEqual(["2070_pop", "2025_pop"]);
  });

  it("高齢者増加率は、両方の年の 65 歳以上人口と秘匿を読む", () => {
    expect(meshColumnsToRead("elderly_change", 2040)).toEqual([
      "2040_p65",
      "2040_masked",
      "2025_p65",
      "2025_masked",
    ]);
  });

  it("基準年そのものの増減率では、同じ列を1度だけ並べる", () => {
    expect(meshColumnsToRead("pop_change", 2025)).toEqual(["2025_pop"]);
  });

  it("選べない年なら空", () => {
    expect(meshColumnsToRead("p65", 2020)).toEqual([]);
    expect(meshColumnsToRead("pop", 2075)).toEqual([]);
  });
});
