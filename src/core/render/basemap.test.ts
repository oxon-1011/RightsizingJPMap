import { describe, expect, it } from "vitest";
import {
  ALL_BASEMAP_LAYERS_VISIBLE,
  basemapLayerVisibility,
  parseBasemapLayerIds,
} from "./basemap";

const GROUPS = { rail: ["rail-tunnel", "rail", "rail-dash"], road: ["road"], river: ["river"] };

describe("parseBasemapLayerIds", () => {
  it("3つの単位のレイヤーの ID を読む", () => {
    expect(parseBasemapLayerIds(GROUPS)).toEqual({ ok: true, value: GROUPS });
  });

  it("単位が足りない、空の配列、文字列でない ID、知らない単位を受け付けない", () => {
    const { river: _, ...withoutRiver } = GROUPS;
    for (const value of [
      undefined,
      [],
      withoutRiver,
      { ...GROUPS, road: [] },
      { ...GROUPS, road: "road" },
      { ...GROUPS, rail: ["rail", 1] },
      { ...GROUPS, label: ["label-place"] },
    ]) {
      expect(parseBasemapLayerIds(value).ok).toBe(false);
    }
  });

  it("失敗の文に、足りない単位と知らない単位の名前を入れる", () => {
    const { river: _, ...withoutRiver } = GROUPS;
    expect(parseBasemapLayerIds(withoutRiver)).toEqual({
      ok: false,
      error: expect.stringContaining("river"),
    });
    expect(parseBasemapLayerIds({ ...GROUPS, label: ["label-place"] })).toEqual({
      ok: false,
      error: expect.stringContaining("label"),
    });
  });
});

describe("basemapLayerVisibility", () => {
  it("鉄道の3つのレイヤーをまとめて切り替え、ほかの単位はそのままにする", () => {
    expect(basemapLayerVisibility(GROUPS, { ...ALL_BASEMAP_LAYERS_VISIBLE, rail: false })).toEqual([
      { id: "rail-tunnel", visible: false },
      { id: "rail", visible: false },
      { id: "rail-dash", visible: false },
      { id: "road", visible: true },
      { id: "river", visible: true },
    ]);
  });
});
