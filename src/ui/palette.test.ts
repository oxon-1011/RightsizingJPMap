import { describe, expect, it } from "vitest";
import type { PlaceCandidate } from "../core/places/search";
import { PALETTE_COMMANDS, paletteItemKey, paletteItems } from "./palette";

const NAGANO: PlaceCandidate = {
  place: {
    code: "20000",
    name: "長野県",
    pref_name: "長野県",
    kind: "prefecture",
    bbox: [137.3, 35.2, 138.8, 37.1],
  },
  match: "prefix",
  prefName: null,
};

describe("paletteItems", () => {
  it("入力が空なら、操作をすべて出す", () => {
    expect(paletteItems("", [])).toEqual(
      PALETTE_COMMANDS.map((command) => ({ kind: "command", command })),
    );
    expect(paletteItems("  ", [])).toHaveLength(PALETTE_COMMANDS.length);
  });

  it("名前か言葉に入力を含む操作を、場所の候補の前に並べる", () => {
    const items = paletteItems("県", [NAGANO]);
    expect(items.map(paletteItemKey)).toEqual(["command:region", "place:20000"]);
    expect(paletteItems("絞る", []).map(paletteItemKey)).toEqual(["command:region"]);
    expect(paletteItems("地域", []).map(paletteItemKey)).toEqual(["command:region"]);
  });

  it("入力が操作に合わなければ、場所の候補だけを出す", () => {
    expect(paletteItems("長野", [NAGANO]).map(paletteItemKey)).toEqual(["place:20000"]);
    expect(paletteItems("ながの", [])).toEqual([]);
  });

  it("全角と半角、空白の違いを無視して突き合わせる", () => {
    expect(paletteItems("ﾌｨﾙﾀ", []).map(paletteItemKey)).toEqual(["command:region"]);
    expect(paletteItems("都道府県 を", []).map(paletteItemKey)).toEqual(["command:region"]);
  });
});
