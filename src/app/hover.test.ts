// ホバーのカードの手続き（hover.ts）を、地図の偽物から送ったポインタの知らせで確かめる。
// ベースデータは tests/fixtures/ の鳥取県の Parquet を使う。

import { describe, expect, it } from "vitest";
import type { HoverHit } from "../core/hover/hover";
import { latLonToMeshCode, meshCodeToBounds } from "../core/mesh/mesh-code";
import type { IndicatorSelection } from "../core/state/state";
import type { MapPointerEvent } from "../io/map";
import { createApp } from "./create-app";
import { fakeMap } from "./fake-map";
import { datasetLayerId } from "./overlays";
import { settle, testPorts } from "./test-fakes";

// 鳥取駅
const TOTTORI_STATION = { lat: 35.4941, lon: 134.2253 };
// テスト用データで 2050 年に秘匿記号の付いたメッシュと、2050 年の総人口が 0 のメッシュ
const MASKED_2050 = 52335390;
const EMPTY_2050 = 52335148;

const centerOf = (code: number) => {
  const b = meshCodeToBounds(code);
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
};

const hover = (
  at: { lat: number; lon: number },
  overrides: Partial<HoverHit> = {},
): MapPointerEvent => ({
  kind: "hover",
  hit: { ...at, municipalityCode: null, feature: null, ...overrides },
  x: 100,
  y: 200,
  width: 1340,
  height: 806,
});

const start = async () => {
  const map = fakeMap();
  const app = createApp(testPorts({ map: map.view }));
  await app.boot();
  await app.attachMap("map");
  await settle();
  const card = () => app.hover.getState().card;
  return { app, map, card };
};

const POINTS_GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { beds: 10, name: "a" },
      geometry: { type: "Point", coordinates: [134.2253, 35.4941] },
    },
    {
      type: "Feature",
      properties: { beds: 5, name: "b" },
      geometry: { type: "Point", coordinates: [133.3305, 35.4278] },
    },
  ],
});

describe("ホバーのカード", () => {
  it("ポインタの下のメッシュの値とその年の総人口を出し、地図の外に出たら消す", async () => {
    const { map, card } = await start();
    map.pointer(hover(TOTTORI_STATION));
    await settle();
    const shown = card();
    expect(shown).toMatchObject({ x: 100, y: 200, width: 1340, height: 806 });
    expect(shown?.content).toMatchObject({
      kind: "mesh",
      code: latLonToMeshCode(TOTTORI_STATION),
      year: 2050,
      indicator: { kind: "base", id: "aging_rate" },
      value: { kind: "number" },
      population: { kind: "number" },
    });
    map.pointer({ kind: "leave" });
    expect(card()).toBeNull();
  });

  it("秘匿のメッシュは秘匿、総人口が 0 のメッシュは値なしにする", async () => {
    const { map, card } = await start();
    map.pointer(hover(centerOf(MASKED_2050)));
    await settle();
    expect(card()?.content).toMatchObject({ code: MASKED_2050, value: { kind: "masked" } });
    map.pointer(hover(centerOf(EMPTY_2050)));
    expect(card()?.content).toMatchObject({
      code: EMPTY_2050,
      value: { kind: "none" },
      population: { kind: "number", value: 0 },
    });
  });

  it("ベースデータにないメッシュ（海など）には出さない", async () => {
    const { map, card } = await start();
    map.pointer(hover({ lat: 36.0, lon: 134.0 }));
    await settle();
    expect(card()).toBeNull();
  });

  it("年を変えると、ポインタを動かさなくても、新しい年の値でカードを作り直す", async () => {
    const { app, map, card } = await start();
    map.pointer(hover(TOTTORI_STATION));
    await settle();
    expect(card()?.content).toMatchObject({ year: 2050 });
    app.dispatch({ type: "year-selected", year: 2030 });
    // 作り直すあいだは前のカードを残す
    expect(card()?.content).toMatchObject({ year: 2050 });
    await settle();
    expect(card()?.content).toMatchObject({ year: 2030 });
  });

  it("市区町村では、区域の名前と都道府県、その年の総人口を出す", async () => {
    const { app, map, card } = await start();
    app.dispatch({ type: "unit-selected", unit: "municipality" });
    await settle();
    map.pointer(hover(TOTTORI_STATION, { municipalityCode: "31201" }));
    await settle();
    expect(card()?.content).toMatchObject({
      kind: "municipality",
      code: "31201",
      name: "鳥取市",
      prefecture: "鳥取県",
      value: { kind: "number" },
      population: { kind: "number" },
    });
  });

  it("総人口の指標では、総人口の行を出さない", async () => {
    const { app, map, card } = await start();
    app.dispatch({ type: "indicator-selected", indicator: { kind: "base", id: "pop" } });
    await settle();
    map.pointer(hover(TOTTORI_STATION));
    await settle();
    expect(card()?.content).toMatchObject({ value: { kind: "number" }, population: null });
  });

  it("点のデータでは、メモリに持つ数値の属性を出す（文字列の属性は持たない）", async () => {
    const { app, map, card } = await start();
    await app.importFiles([new File([POINTS_GEOJSON], "施設.geojson")]);
    await settle();
    const [dataset] = app.store.getState().state.datasets;
    const layerId = datasetLayerId(dataset?.id ?? "");
    map.pointer(hover(TOTTORI_STATION, { feature: { layerId, index: 1, properties: undefined } }));
    await settle();
    expect(card()?.content).toEqual({
      kind: "feature",
      datasetId: dataset?.id,
      layerName: dataset?.name,
      attributes: [{ name: "beds", value: 5 }],
      omitted: 0,
    });
  });

  it("結合した指標では、結合した値とデータの名前、その年の総人口を出す", async () => {
    const { app, map, card } = await start();
    await app.importFiles([new File([POINTS_GEOJSON], "施設.geojson")]);
    const [dataset] = app.store.getState().state.datasets;
    const count: IndicatorSelection = {
      kind: "joined",
      datasetId: dataset?.id ?? "",
      measure: { kind: "count" },
      perPopulation: null,
    };
    app.dispatch({ type: "indicator-selected", indicator: count });
    await settle();
    map.pointer(hover(TOTTORI_STATION));
    await settle();
    expect(card()?.content).toMatchObject({
      kind: "mesh",
      datasetName: dataset?.name,
      value: { kind: "number", value: 1 },
      population: { kind: "number" },
    });
  });

  it("地図を片付けたら、カードを消し、ポインタの知らせを受けるのをやめる", async () => {
    const { app, map, card } = await start();
    map.pointer(hover(TOTTORI_STATION));
    await settle();
    expect(card()).not.toBeNull();
    expect(map.pointerListeners()).toBe(1);
    app.detachMap();
    expect(card()).toBeNull();
    expect(map.pointerListeners()).toBe(0);
  });
});
