import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Place } from "../data/schema";
import { buildPlaceIndex, normalizePlaceText, parsePlaces, searchPlaces } from "./search";

const place = (
  code: string,
  name: string,
  pref_name: string,
  kind: Place["kind"] = "municipality",
): Place => ({ code, name, pref_name, kind, bbox: [139, 35, 140, 36] });

const PLACES: readonly Place[] = [
  place("13000", "東京都", "東京都", "prefecture"),
  place("13206", "府中市", "東京都"),
  place("34208", "府中市", "広島県"),
  place("34302", "府中町", "広島県"),
  place("22000", "静岡県", "静岡県", "prefecture"),
  place("22130", "浜松市", "静岡県", "designated-city"),
  place("22138", "浜松市中央区", "静岡県", "ward"),
  place("22139", "浜松市浜名区", "静岡県", "ward"),
  place("22140", "浜松市天竜区", "静岡県", "ward"),
  place("01233", "伊達市", "北海道"),
  place("07213", "伊達市", "福島県"),
];

const index = buildPlaceIndex(PLACES);
const names = (input: string) => searchPlaces(index, input).map((c) => c.place.code);

describe("searchPlaces", () => {
  it("同じ名前の市区町村には都道府県名を添え、都道府県には添えない", () => {
    expect(searchPlaces(index, "府中").map((c) => [c.place.name, c.prefName])).toEqual([
      ["府中市", "東京都"],
      ["府中市", "広島県"],
      ["府中町", "広島県"],
    ]);
    expect(searchPlaces(index, "東京")[0]).toMatchObject({ prefName: null, match: "prefix" });
  });

  it("政令指定都市は市全体と各区の両方を候補にし、前方一致を部分一致より上に並べる", () => {
    expect(names("浜松")).toEqual(["22130", "22138", "22139", "22140"]);
    // 「浜名区」は部分一致なので、前方一致の後ろに来る
    expect(searchPlaces(index, "浜名").map((c) => c.match)).toEqual(["substring"]);
  });

  it("都道府県名を前に付けた入力でも前方一致する", () => {
    expect(names("静岡県浜松市中")).toEqual(["22138"]);
    expect(names("福島県伊達")).toEqual(["07213"]);
  });

  it("全角と半角、空白の違いをなくして比べる", () => {
    expect(normalizePlaceText("ﾊﾏﾏﾂ　市")).toBe("ハママツ市");
    expect(names("浜松市　中央区")).toEqual(["22138"]);
  });

  it("空の入力では候補を出さず、limit で数を絞る", () => {
    expect(names("  ")).toEqual([]);
    expect(searchPlaces(index, "市", 2)).toHaveLength(2);
  });

  it("前方一致の候補は、いつも部分一致の候補より前に来る", () => {
    // 名前の一部を切り出して入力にする
    const query = fc
      .record({ p: fc.constantFrom(...PLACES), a: fc.nat(), b: fc.nat() })
      .map(({ p, a, b }) => {
        const start = a % p.name.length;
        return p.name.slice(start, start + 1 + (b % (p.name.length - start)));
      });
    fc.assert(
      fc.property(query, (q) => {
        const candidates = searchPlaces(index, q, 100);
        expect(candidates.length).toBeGreaterThan(0);
        const matches = candidates.map((c) => c.match);
        const lastPrefix = matches.lastIndexOf("prefix");
        const firstSubstring = matches.indexOf("substring");
        if (lastPrefix >= 0 && firstSubstring >= 0) {
          expect(lastPrefix).toBeLessThan(firstSubstring);
        }
      }),
    );
  });
});

describe("parsePlaces", () => {
  it("形の正しい一覧を受け付ける", () => {
    expect(parsePlaces(JSON.parse(JSON.stringify(PLACES)))).toEqual({ ok: true, value: PLACES });
  });

  it("形の違う要素の番号を返す", () => {
    const bad = [PLACES[0], { ...PLACES[1], kind: "city" }];
    expect(parsePlaces(bad)).toEqual({ ok: false, error: { kind: "invalid", index: 1 } });
    expect(parsePlaces([{ ...PLACES[0], bbox: [1, 2, 3] }])).toEqual({
      ok: false,
      error: { kind: "invalid", index: 0 },
    });
    expect(parsePlaces({})).toEqual({ ok: false, error: { kind: "invalid", index: null } });
  });
});
