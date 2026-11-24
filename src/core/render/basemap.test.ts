import { describe, expect, it } from "vitest";
import {
  ALL_BASEMAP_LAYERS_VISIBLE,
  BASEMAP_CREDITS,
  BASEMAP_HIDDEN_GROUPS,
  BASEMAP_IDS,
  BASEMAP_LAYER_GROUPS,
  type BasemapSelection,
  type BasemapStyleLayers,
  basemapCredits,
  basemapLayerVisibility,
  DEFAULT_BASEMAP,
  isGroupShown,
  parseBasemapLayerIds,
  parseBasemapSurfaceIds,
} from "./basemap";

const GROUPS = {
  rail: ["rail-tunnel", "rail", "rail-dash"],
  road: ["road"],
  river: ["river"],
  label: ["label-place"],
};

const SURFACES = {
  vector: ["land", "water"],
  photo: ["gsi-photo"],
  pale: ["gsi-pale"],
  std: ["gsi-std"],
  relief: ["gsi-relief"],
  osm: ["osm-standard"],
};

const LAYERS: BasemapStyleLayers = { groups: GROUPS, surfaces: SURFACES };

const select = (
  id: BasemapSelection["id"],
  visibility: Partial<BasemapSelection["visibility"]> = {},
): BasemapSelection => ({ id, visibility: { ...ALL_BASEMAP_LAYERS_VISIBLE, ...visibility } });

/** 表示するレイヤーの ID */
const visibleIds = (selection: BasemapSelection): readonly string[] =>
  basemapLayerVisibility(LAYERS, selection)
    .filter((layer) => layer.visible)
    .map((layer) => layer.id);

describe("parseBasemapLayerIds", () => {
  it("4つの単位のレイヤーの ID を読む", () => {
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
      { ...GROUPS, building: ["building"] },
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
    expect(parseBasemapLayerIds({ ...GROUPS, building: ["building"] })).toEqual({
      ok: false,
      error: expect.stringContaining("building"),
    });
  });
});

describe("parseBasemapSurfaceIds", () => {
  it("背景地図の候補のすべてのレイヤーの ID を読む", () => {
    expect(parseBasemapSurfaceIds(SURFACES)).toEqual({ ok: true, value: SURFACES });
  });

  it("候補が足りない、空の配列、文字列でない ID、知らない候補を受け付けない", () => {
    const { osm: _, ...withoutOsm } = SURFACES;
    for (const value of [
      undefined,
      [],
      withoutOsm,
      { ...SURFACES, photo: [] },
      { ...SURFACES, photo: "gsi-photo" },
      { ...SURFACES, vector: ["land", null] },
      { ...SURFACES, hillshade: ["gsi-hillshade"] },
    ]) {
      expect(parseBasemapSurfaceIds(value).ok).toBe(false);
    }
  });

  it("失敗の文に、足りない候補と知らない候補の名前を入れる", () => {
    const { osm: _, ...withoutOsm } = SURFACES;
    expect(parseBasemapSurfaceIds(withoutOsm)).toEqual({
      ok: false,
      error: expect.stringContaining("osm"),
    });
    expect(parseBasemapSurfaceIds({ ...SURFACES, hillshade: ["gsi-hillshade"] })).toEqual({
      ok: false,
      error: expect.stringContaining("hillshade"),
    });
  });
});

describe("basemapLayerVisibility", () => {
  it("どの選択でも、スタイルのすべてのレイヤーの表示を1回ずつ返す", () => {
    const all = [...Object.values(SURFACES).flat(), ...Object.values(GROUPS).flat()].sort();
    for (const id of BASEMAP_IDS) {
      const ids = basemapLayerVisibility(LAYERS, select(id)).map((layer) => layer.id);
      expect([...ids].sort()).toEqual(all);
    }
  });

  it("既定では、ベクトルタイルの陸と海、線、地名を表示し、ラスターのレイヤーを隠す", () => {
    expect(visibleIds(DEFAULT_BASEMAP)).toEqual([
      "land",
      "water",
      "rail-tunnel",
      "rail",
      "rail-dash",
      "road",
      "river",
      "label-place",
    ]);
  });

  it("鉄道の3つのレイヤーをまとめて切り替え、ほかの単位はそのままにする", () => {
    expect(visibleIds(select("vector", { rail: false }))).toEqual([
      "land",
      "water",
      "road",
      "river",
      "label-place",
    ]);
  });

  it("写真では、写真のレイヤーに替え、川と湖だけを隠す", () => {
    expect(visibleIds(select("photo"))).toEqual([
      "gsi-photo",
      "rail-tunnel",
      "rail",
      "rail-dash",
      "road",
      "label-place",
    ]);
  });

  it("色別標高図では、線と地名を表示の設定のとおりにする", () => {
    expect(visibleIds(select("relief", { road: false }))).toEqual([
      "gsi-relief",
      "rail-tunnel",
      "rail",
      "rail-dash",
      "river",
      "label-place",
    ]);
  });

  it("線と地名を画像に持つ背景地図では、表示の設定にかかわらず、線と地名をすべて隠す", () => {
    expect(visibleIds(select("pale"))).toEqual(["gsi-pale"]);
    expect(visibleIds(select("std"))).toEqual(["gsi-std"]);
    expect(visibleIds(select("osm"))).toEqual(["osm-standard"]);
  });
});

describe("isGroupShown", () => {
  it("表示の設定が入っていて、背景地図が隠さない単位だけを描く", () => {
    for (const id of BASEMAP_IDS) {
      for (const group of BASEMAP_LAYER_GROUPS) {
        const hidden = BASEMAP_HIDDEN_GROUPS[id].includes(group);
        expect(isGroupShown(select(id), group)).toBe(!hidden);
        expect(isGroupShown(select(id, { [group]: false }), group)).toBe(false);
      }
    }
  });
});

describe("basemapCredits", () => {
  const { gsiVector, gsiRaster, osm } = BASEMAP_CREDITS;

  it("既定では、最適化ベクトルタイルだけを出す。線と地名をすべて消しても、陸と海を描くので出す", () => {
    expect(basemapCredits(DEFAULT_BASEMAP)).toEqual([gsiVector]);
    expect(
      basemapCredits(select("vector", { rail: false, road: false, river: false, label: false })),
    ).toEqual([gsiVector]);
  });

  it("写真と色別標高図では、地理院タイルを先に出し、線か地名を描いていれば最適化ベクトルタイルを続ける", () => {
    expect(basemapCredits(select("photo"))).toEqual([gsiRaster, gsiVector]);
    expect(basemapCredits(select("relief", { rail: false, road: false, label: false }))).toEqual([
      gsiRaster,
      gsiVector,
    ]);
    expect(
      basemapCredits(select("relief", { rail: false, road: false, river: false, label: false })),
    ).toEqual([gsiRaster]);
  });

  it("写真では川と湖を描かないので、川と湖だけの設定では最適化ベクトルタイルを出さない", () => {
    expect(basemapCredits(select("photo", { rail: false, road: false, label: false }))).toEqual([
      gsiRaster,
    ]);
  });

  it("線と地名を画像に持つ背景地図では、その提供元だけを出す", () => {
    expect(basemapCredits(select("pale"))).toEqual([gsiRaster]);
    expect(basemapCredits(select("std"))).toEqual([gsiRaster]);
    expect(basemapCredits(select("osm"))).toEqual([osm]);
  });
});
