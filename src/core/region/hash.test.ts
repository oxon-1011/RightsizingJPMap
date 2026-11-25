import { describe, expect, it } from "vitest";
import { formatRegionHash, hasHashParam, parseRegionHash } from "./hash";

describe("parseRegionHash", () => {
  it("カンマで区切った都道府県のコードを読み、昇順に並べる", () => {
    expect(parseRegionHash("#pref=19,20", "pref")).toEqual(["19", "20"]);
    expect(parseRegionHash("#pref=20,19", "pref")).toEqual(["19", "20"]);
    expect(parseRegionHash("#pref=01", "pref")).toEqual(["01"]);
  });

  it("ほかの名前の値と並んでいても読む", () => {
    expect(parseRegionHash("#map=7.75/36.1/138.2&pref=20", "pref")).toEqual(["20"]);
    expect(parseRegionHash("#pref=20&map=7.75/36.1/138.2", "pref")).toEqual(["20"]);
  });

  it("名前の値がなければ null", () => {
    expect(parseRegionHash("", "pref")).toBeNull();
    expect(parseRegionHash("#map=7.75/36.1/138.2", "pref")).toBeNull();
    expect(parseRegionHash("#prefs=20", "pref")).toBeNull();
  });

  it("都道府県のコードでないものか、同じコードが2回あれば、残りも使わずに null", () => {
    for (const value of [
      "",
      "20,",
      ",20",
      "20,48",
      "20,20",
      "2",
      "020",
      "20000",
      "20 ,19",
      "長野",
    ]) {
      expect(parseRegionHash(`#pref=${value}`, "pref")).toBeNull();
    }
  });
});

describe("formatRegionHash", () => {
  it("名前の値がなければ末尾に足し、あれば置き換える。ほかの値と並びは変えない", () => {
    expect(formatRegionHash("", "pref", ["20"])).toBe("#pref=20");
    expect(formatRegionHash("#map=7/36/138", "pref", ["19", "20"])).toBe(
      "#map=7/36/138&pref=19,20",
    );
    expect(formatRegionHash("#pref=01&map=7/36/138", "pref", ["20"])).toBe("#pref=20&map=7/36/138");
  });

  it("全国なら名前の値を取り除き、何も残らなければ空の文字列にする", () => {
    expect(formatRegionHash("#pref=20&map=7/36/138", "pref", [])).toBe("#map=7/36/138");
    expect(formatRegionHash("#pref=20", "pref", [])).toBe("");
    expect(formatRegionHash("", "pref", [])).toBe("");
  });

  it("書いたものを読むと、同じ地域になる", () => {
    const region = ["13", "19", "20"] as const;
    expect(parseRegionHash(formatRegionHash("#map=7/36/138", "pref", region), "pref")).toEqual(
      region,
    );
  });
});

describe("hasHashParam", () => {
  it("その名前の値があるかだけを見る", () => {
    expect(hasHashParam("#pref=20&map=x", "map")).toBe(true);
    expect(hasHashParam("#pref=20", "map")).toBe(false);
    expect(hasHashParam("#mapx=1", "map")).toBe(false);
    expect(hasHashParam("", "map")).toBe(false);
  });
});
