import { describe, expect, it } from "vitest";
import { indexMeshes } from "../join/per-population";
import {
  isInRegion,
  isPrefCode,
  PREFECTURES,
  regionBBox,
  regionKey,
  regionLabel,
  regionOf,
  restrictCodeValues,
  restrictMeshValues,
  sameRegion,
  toggleRegion,
  WHOLE_COUNTRY,
} from "./region";

describe("PREFECTURES", () => {
  it("01 から 47 までの 47 都道府県が、コードの順に並ぶ", () => {
    expect(PREFECTURES.map((p) => p.code)).toEqual(
      Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, "0")),
    );
    expect(new Set(PREFECTURES.map((p) => p.name)).size).toBe(47);
  });

  it("isPrefCode は、2桁の都道府県のコードだけを受け付ける", () => {
    expect(isPrefCode("01")).toBe(true);
    expect(isPrefCode("47")).toBe(true);
    for (const value of ["", "0", "1", "00", "48", "020", "20000", " 20", "２０"]) {
      expect(isPrefCode(value)).toBe(false);
    }
  });
});

describe("地域", () => {
  it("regionOf は、重複を除いて昇順に並べる", () => {
    expect(regionOf(["20", "19", "20"])).toEqual(["19", "20"]);
    expect(regionOf([])).toEqual(WHOLE_COUNTRY);
  });

  it("toggleRegion は、都道府県を1つ入れるか外す", () => {
    expect(toggleRegion(["20"], "19", true)).toEqual(["19", "20"]);
    expect(toggleRegion(["19", "20"], "20", false)).toEqual(["19"]);
    // すでに入っているものを入れても、ないものを外しても変わらない
    expect(toggleRegion(["20"], "20", true)).toEqual(["20"]);
    expect(toggleRegion(["20"], "19", false)).toEqual(["20"]);
    expect(toggleRegion(["20"], "20", false)).toEqual(WHOLE_COUNTRY);
  });

  it("sameRegion と regionKey は、同じ都道府県の組を同じとみなす", () => {
    expect(sameRegion(["19", "20"], ["19", "20"])).toBe(true);
    expect(sameRegion(["19"], ["19", "20"])).toBe(false);
    expect(sameRegion([], [])).toBe(true);
    expect(regionKey([])).toBe("all");
    expect(regionKey(["19", "20"])).toBe("19,20");
  });

  it("isInRegion は団体コードの上2桁で決め、全国ならどの区域も入れる", () => {
    expect(isInRegion("20201", ["19", "20"])).toBe(true);
    expect(isInRegion("20000", ["20"])).toBe(true);
    expect(isInRegion("21201", ["19", "20"])).toBe(false);
    // 上2桁より後ろに都道府県のコードと同じ並びがあっても入れない
    expect(isInRegion("12001", ["20"])).toBe(false);
    expect(isInRegion("21201", WHOLE_COUNTRY)).toBe(true);
  });

  it("regionLabel は、2つまでは名前を並べ、3つ以上は先頭の名前と残りの数にする", () => {
    expect(regionLabel([])).toBe("全国");
    expect(regionLabel(["20"])).toBe("長野県");
    expect(regionLabel(["19", "20"])).toBe("山梨県、長野県");
    expect(regionLabel(["19", "20", "22"])).toBe("山梨県 ほか 2");
  });

  it("regionBBox は、都道府県の範囲を合わせる。全国と、範囲の表にない都道府県があるときは null", () => {
    const index = { "19": [138.1, 35.1, 139.2, 36.0], "20": [137.3, 35.2, 138.8, 37.1] } as const;
    expect(regionBBox(index, ["19", "20"])).toEqual([137.3, 35.1, 139.2, 37.1]);
    expect(regionBBox(index, ["20"])).toEqual([137.3, 35.2, 138.8, 37.1]);
    expect(regionBBox(index, [])).toBeNull();
    expect(regionBBox(index, ["20", "21"])).toBeNull();
  });
});

describe("restrictCodeValues", () => {
  const values = new Map([
    ["19201", 1],
    ["20201", 2],
    ["21201", 3],
  ]);

  it("地域の外の区域を、値なしにして残す", () => {
    const restricted = restrictCodeValues(values, ["20"]);
    expect([...restricted.keys()]).toEqual(["19201", "20201", "21201"]);
    expect(restricted.get("20201")).toBe(2);
    expect(restricted.get("19201")).toBeNaN();
    expect(restricted.get("21201")).toBeNaN();
  });

  it("全国なら、同じ対応をそのまま返す", () => {
    expect(restrictCodeValues(values, WHOLE_COUNTRY)).toBe(values);
  });
});

describe("restrictMeshValues", () => {
  it("members にあるメッシュだけを、順を変えずに残す", () => {
    const meshes = Uint32Array.of(53380000, 53380001, 53380002, 53380003);
    const members = indexMeshes(Uint32Array.of(53380003, 53380001, 99999999));
    const restricted = restrictMeshValues(meshes, [10, 11, 12, 13], members);
    expect([...restricted.meshes]).toEqual([53380001, 53380003]);
    expect([...restricted.values]).toEqual([11, 13]);
  });

  it("メッシュの数と値の数が違えば、例外を投げる", () => {
    expect(() => restrictMeshValues(Uint32Array.of(1, 2), [1], new Map())).toThrow();
  });
});
