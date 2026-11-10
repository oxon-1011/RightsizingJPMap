import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MeshLayerSpec } from "../core/render/mesh";
import type { IndicatorSelection } from "../core/state/state";
import {
  type DatasetEntry,
  EMPTY_MANIFEST,
  parseManifest,
  serializeManifest,
} from "../core/storage/manifest";
import type { DatasetStorage } from "../io/opfs";
import { openMemoryStorage } from "../io/opfs";
import { createApp, MESH_LAYER_ID } from "./create-app";
import { fakeMap, type MapCall } from "./fake-map";
import {
  fakeChannels,
  fakeLocks,
  fakeOpfs,
  fakeTables,
  recordStorage,
  settle,
  testPorts,
} from "./test-fakes";

const encoder = new TextEncoder();

const file = (text: string | Uint8Array<ArrayBuffer>, name: string): File => new File([text], name);

const POINTS_GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    // 鳥取駅と米子駅
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

const CODE_TABLE = {
  columns: [
    { name: "code", type: "string" },
    { name: "beds", type: "integer" },
  ],
  values: { code: { type: "string", values: ["31201", "31202"] } },
} as const;

const readManifest = async (storage: DatasetStorage) => {
  const text = await storage.readManifest();
  if (!text.ok || text.value === null) {
    return null;
  }
  const parsed = parseManifest(JSON.parse(text.value));
  return parsed.ok ? parsed.value : null;
};

const noticeKinds = (app: {
  readonly store: { getState: () => { state: { notices: readonly { kind: string }[] } } };
}) => app.store.getState().state.notices.map((n) => n.kind);

const entry = (id: string): DatasetEntry => ({
  id,
  name: id,
  source: { name: `${id}.geojson`, size: 1 },
  imported_at: "2026-11-09T00:00:00Z",
  kind: "point",
  join: ["mesh", "municipality"],
  columns: [{ name: "beds", type: "float" }],
  count: 1,
  style: { color: "#0072b2", size: 4, visible: true },
  stored_format: "geojson",
});

describe("起動", () => {
  it("書き込みの権利を取り、目録を読み、目録にないデータのファイルを消す", async () => {
    const storage = fakeOpfs();
    await storage.writeManifest(
      serializeManifest({ ...EMPTY_MANIFEST, datasets: [entry("kept")] }),
    );
    await storage.writeDataset("kept.geojson", encoder.encode(POINTS_GEOJSON));
    await storage.writeDataset("orphan.parquet", new Uint8Array([1]));
    const app = createApp(testPorts({ storage }));
    expect((await app.boot()).ok).toBe(true);
    const { state, runtime } = app.store.getState();
    expect(state.access).toBe("writer");
    expect(state.datasets.map((d) => d.id)).toEqual(["kept"]);
    expect(runtime.storage).toBe("opfs");
    expect(await storage.listDatasets()).toEqual({ ok: true, value: ["kept.geojson"] });
  });

  it("2つめのタブは閲覧専用になり、ファイルを掃除しない", async () => {
    const storage = fakeOpfs();
    const locks = fakeLocks();
    const first = createApp(testPorts({ storage, locks }));
    await first.boot();
    // 1つめのタブが取り込みの途中（データのファイルを書き、目録はまだ）
    await storage.writeDataset("pending.parquet", new Uint8Array([1]));
    const second = createApp(testPorts({ storage, locks }));
    await second.boot();
    expect(second.store.getState().state.access).toBe("read-only");
    expect(noticeKinds(second)).toEqual(["read-only"]);
    expect(await storage.listDatasets()).toEqual({ ok: true, value: ["pending.parquet"] });
  });

  it("OPFS が使えなければメモリ上で動かし、その旨を通知する", async () => {
    const app = createApp(testPorts({ storage: openMemoryStorage("no-opfs") }));
    await app.boot();
    expect(app.store.getState().runtime.storage).toBe("memory");
    expect(noticeKinds(app)).toEqual(["storage-unavailable"]);
  });

  it("読めない目録のもとでは、データのファイルを掃除しない", async () => {
    const storage = fakeOpfs();
    await storage.writeManifest('{"schema_version": 99, "datasets": []}');
    await storage.writeDataset("a.parquet", new Uint8Array([1]));
    const ports = testPorts({ storage });
    const app = createApp(ports);
    const booted = await app.boot();
    expect(booted.ok).toBe(false);
    expect(ports.errors.map((e) => e.kind)).toEqual(["manifest"]);
    expect(await storage.listDatasets()).toEqual({ ok: true, value: ["a.parquet"] });
  });

  it("何度呼んでも1回だけ起動する", async () => {
    const storage = fakeOpfs();
    const locks = fakeLocks();
    const app = createApp(testPorts({ storage, locks }));
    await Promise.all([app.boot(), app.boot()]);
    // 2回目にロックを取りにいっていれば、閲覧専用の通知が出る
    expect(app.store.getState().state.access).toBe("writer");
    expect(noticeKinds(app)).toEqual([]);
  });
});

describe("ほかのタブとのやりとり", () => {
  it("閲覧専用のタブは、書き込み側のタブが目録を更新したら読み直す", async () => {
    const storage = fakeOpfs();
    const locks = fakeLocks();
    const channels = fakeChannels();
    const writer = createApp(testPorts({ storage, locks, channels }));
    const reader = createApp(testPorts({ storage, locks, channels }));
    await writer.boot();
    await reader.boot();
    await writer.importFiles([file(POINTS_GEOJSON, "施設.geojson")]);
    await settle();
    expect(reader.store.getState().state.datasets.map((d) => d.name)).toEqual(["施設"]);
  });

  it("書き込み側のタブが閉じると、閲覧専用のタブが書き込めるようになり、残ったファイルを掃除する", async () => {
    const storage = fakeOpfs();
    const locks = fakeLocks();
    const channels = fakeChannels();
    const first = createApp(testPorts({ storage, locks, channels }));
    const second = createApp(testPorts({ storage, locks, channels }));
    await first.boot();
    await second.boot();
    await storage.writeDataset("left.parquet", new Uint8Array([1]));
    await first.dispose();
    await settle();
    expect(second.store.getState().state.access).toBe("writer");
    expect(noticeKinds(second)).toEqual(["became-writer"]);
    expect(await storage.listDatasets()).toEqual({ ok: true, value: [] });
  });
});

describe("取り込み", () => {
  it("受け付けない拡張子は、読まずに拒否を通知する", async () => {
    const app = createApp(testPorts());
    await app.boot();
    await app.importFiles([file("a", "施設.xlsx")]);
    expect(app.store.getState().state.notices).toMatchObject([
      {
        kind: "import-rejected",
        fileName: "施設.xlsx",
        rejection: { stage: "format", extension: "xlsx" },
      },
    ]);
  });

  it("CSV はデータのファイルを書いてから目録を更新し、件数は検査の結果から入る", async () => {
    const { storage, log } = recordStorage(fakeOpfs());
    const tables = fakeTables({ "病床.csv": CODE_TABLE });
    const ports = testPorts({ storage, tables });
    const app = createApp(ports);
    await app.boot();
    await app.importFiles([file("code,beds\n", "病床.csv")]);
    expect(log).toEqual(["writeDataset dataset-1.parquet", "writeManifest"]);
    expect(tables.closed).toEqual(["病床.csv"]);
    const [added] = app.store.getState().state.datasets;
    expect(added).toMatchObject({
      id: "dataset-1",
      name: "病床",
      kind: "table",
      join: ["municipality"],
      count: 2,
      stored_format: "parquet",
      imported_at: "2026-11-09T12:00:00.000Z",
    });
    expect((await readManifest(storage))?.datasets).toEqual([added]);
    // 最初の取り込みのときだけ、データを消さないよう求める
    expect(ports.persistRequests).toHaveLength(1);
  });

  it("地図で塗る単位でない団体コードは、行の番号を付けて拒否する", async () => {
    const tables = fakeTables({
      "a.csv": {
        ...CODE_TABLE,
        values: { code: { type: "string", values: ["31201", "13101", "01100"] } },
      },
    });
    const app = createApp(testPorts({ tables }));
    await app.boot();
    await app.importFiles([file("x", "a.csv")]);
    expect(app.store.getState().state.notices).toMatchObject([
      {
        kind: "import-rejected",
        rejection: {
          stage: "table",
          format: "csv",
          rejection: {
            kind: "invalid-values",
            violation: { condition: "code", positions: [1, 2], count: 2 },
          },
        },
      },
    ]);
    expect(app.store.getState().state.datasets).toEqual([]);
    expect(tables.closed).toEqual(["a.csv"]);
  });

  it("結合用の列がない表と、読めない表を拒否する。DuckDB の起動の失敗は拒否にしない", async () => {
    const tables = fakeTables({
      "none.csv": { columns: [{ name: "beds", type: "integer" }] },
      "sjis.csv": { columns: [], openError: { kind: "read-failed", message: "not utf-8" } },
      "late.csv": { ...CODE_TABLE, writeError: { kind: "read-failed", message: "not utf-8" } },
      "engine.parquet": { columns: [], openError: { kind: "engine-failed", message: "wasm" } },
    });
    const ports = testPorts({ tables });
    const app = createApp(ports);
    await app.boot();
    await app.importFiles([
      file("x", "none.csv"),
      file("x", "sjis.csv"),
      file("x", "late.csv"),
      file("x", "engine.parquet"),
    ]);
    const rejections = app.store
      .getState()
      .state.notices.map((n) => (n.kind === "import-rejected" ? n.rejection : null));
    expect(rejections).toEqual([
      { stage: "table", format: "csv", rejection: { kind: "no-join-columns" } },
      { stage: "read", format: "csv" },
      { stage: "read", format: "csv" },
    ]);
    expect(ports.errors).toMatchObject([{ kind: "engine", error: { kind: "engine-failed" } }]);
    expect(app.store.getState().state.datasets).toEqual([]);
  });

  it("GeoJSON は受け入れたファイルをそのまま保存する", async () => {
    const storage = fakeOpfs();
    const app = createApp(testPorts({ storage }));
    await app.boot();
    const bytes = encoder.encode(POINTS_GEOJSON);
    await app.importFiles([file(bytes, "施設.GeoJSON")]);
    const [added] = app.store.getState().state.datasets;
    expect(added).toMatchObject({ kind: "point", count: 2, stored_format: "geojson" });
    expect(await storage.readDataset("dataset-1.geojson")).toEqual({ ok: true, value: bytes });
  });

  it("JSON として読めない、UTF-8 でない、受け入れ条件を満たさない GeoJSON を拒否する", async () => {
    const app = createApp(testPorts());
    await app.boot();
    await app.importFiles([
      file("{", "a.json"),
      file(new Uint8Array([0x7b, 0x93, 0x8c, 0x7d]), "b.geojson"),
      file(JSON.stringify({ type: "FeatureCollection", features: [] }), "c.geojson"),
    ]);
    const rejections = app.store
      .getState()
      .state.notices.map((n) => (n.kind === "import-rejected" ? n.rejection : null));
    expect(rejections).toEqual([
      { stage: "read", format: "geojson" },
      { stage: "read", format: "geojson" },
      { stage: "geojson", rejection: { kind: "no-features" } },
    ]);
  });

  it("閲覧専用のタブでは、読まずに通知だけを出す", async () => {
    const locks = fakeLocks();
    const storage = fakeOpfs();
    await createApp(testPorts({ storage, locks })).boot();
    const tables = fakeTables({ "a.csv": CODE_TABLE });
    const reader = createApp(testPorts({ storage, locks, tables }));
    await reader.boot();
    await reader.importFiles([file("x", "a.csv")]);
    expect(noticeKinds(reader)).toEqual(["read-only", "write-blocked"]);
    expect(tables.closed).toEqual([]);
  });

  it("目録を書けなかったら、書いたデータのファイルを消し、データを加えない", async () => {
    const base = fakeOpfs();
    const storage: DatasetStorage = {
      ...base,
      writeManifest: () =>
        Promise.resolve({ ok: false, error: { kind: "quota-exceeded", name: "manifest.json" } }),
    };
    const ports = testPorts({ storage });
    const app = createApp(ports);
    await app.boot();
    await app.importFiles([file(POINTS_GEOJSON, "a.geojson")]);
    expect(app.store.getState().state.datasets).toEqual([]);
    expect(await storage.listDatasets()).toEqual({ ok: true, value: [] });
    expect(ports.errors).toMatchObject([{ kind: "storage", error: { kind: "quota-exceeded" } }]);
  });

  it("取り込みの途中で例外が出ても、report で知らせて次のファイルを取り込む", async () => {
    // 計画と違う型の値を返す誤った表。core の checkTableValues が例外を投げる
    const tables = fakeTables({
      "broken.csv": {
        ...CODE_TABLE,
        values: { code: { type: "float", values: Float64Array.from([1]) } },
      },
    });
    const ports = testPorts({ tables });
    const app = createApp(ports);
    await app.boot();
    await app.importFiles([file("x", "broken.csv"), file(POINTS_GEOJSON, "a.geojson")]);
    expect(ports.errors).toMatchObject([{ kind: "unexpected" }]);
    expect(app.store.getState().state.datasets.map((d) => d.name)).toEqual(["a"]);
    await app.importFiles([file(POINTS_GEOJSON, "b.geojson")]);
    expect(app.store.getState().state.datasets.map((d) => d.name)).toEqual(["a", "b"]);
    expect(app.store.getState().runtime.importing).toBe(false);
  });

  it("データを消さないよう求めて断られたら、その旨を通知する", async () => {
    const app = createApp(testPorts({ grantPersistence: false }));
    await app.boot();
    await app.importFiles([file(POINTS_GEOJSON, "a.geojson")]);
    expect(noticeKinds(app)).toEqual(["storage-not-persistent"]);
  });
});

describe("削除と、表示の変更", () => {
  const importTwo = async () => {
    const { storage, log } = recordStorage(fakeOpfs());
    const app = createApp(testPorts({ storage }));
    await app.boot();
    await app.importFiles([file(POINTS_GEOJSON, "a.geojson"), file(POINTS_GEOJSON, "b.geojson")]);
    log.length = 0;
    return { app, storage, log };
  };

  it("削除は、目録を書いてからデータのファイルを消す", async () => {
    const { app, storage, log } = await importTwo();
    await app.removeDataset("dataset-1");
    expect(log).toEqual(["writeManifest", "removeDataset dataset-1.geojson"]);
    expect(app.store.getState().state.datasets.map((d) => d.id)).toEqual(["dataset-2"]);
    expect((await readManifest(storage))?.datasets.map((d) => d.id)).toEqual(["dataset-2"]);
  });

  it("すべて削除は、空の目録を書いてから置き場所を空にする", async () => {
    const { app, storage, log } = await importTwo();
    await app.clearDatasets();
    expect(log).toEqual(["writeManifest", "clear"]);
    expect(app.store.getState().state.datasets).toEqual([]);
    expect(await storage.listDatasets()).toEqual({ ok: true, value: [] });
  });

  it("書き込めるタブでは表示の変更を目録に書き、閲覧専用のタブではこのタブの中だけで変える", async () => {
    const { app, storage } = await importTwo();
    await app.changeDatasetStyle("dataset-1", { visible: false });
    expect((await readManifest(storage))?.datasets[0]?.style.visible).toBe(false);

    // 同じロックを共有しない偽物なので、別のロックの持ち主として閲覧専用にする
    const locks = fakeLocks();
    await locks.acquire({ onPromoted: () => undefined });
    const reader = createApp(testPorts({ storage, locks }));
    await reader.boot();
    await reader.changeDatasetStyle("dataset-2", { color: "#000000" });
    expect(reader.store.getState().state.datasets[1]?.style.color).toBe("#000000");
    expect((await readManifest(storage))?.datasets[1]?.style.color).not.toBe("#000000");
  });
});

const lastOverlay = (calls: readonly MapCall[]) => {
  const overlays = calls.filter((c) => c.kind === "overlay");
  const last = overlays.at(-1);
  if (last?.kind !== "overlay") {
    throw new Error("地図に自前データのレイヤーを渡していない");
  }
  return last.layers;
};

const lastAdmin = (calls: readonly MapCall[]) => {
  const admins = calls.filter((c) => c.kind === "admin");
  const last = admins.at(-1);
  if (last?.kind !== "admin") {
    throw new Error("地図に行政区域の塗りを渡していない");
  }
  return last.spec;
};

const meshOf = (calls: readonly MapCall[]): MeshLayerSpec => {
  const { mesh } = lastOverlay(calls);
  if (mesh === null) {
    throw new Error("メッシュのレイヤーがない");
  }
  return mesh;
};

describe("地図の描画", () => {
  const start = async (options: Parameters<typeof testPorts>[0] = {}) => {
    const { view, calls } = fakeMap();
    const ports = testPorts({ ...options, map: view });
    const app = createApp(ports);
    await app.boot();
    await app.attachMap("map");
    await settle();
    return { app, calls, ports };
  };

  it("既定の 2050 年の高齢化率をメッシュで塗り、行政区域の塗りを隠す", async () => {
    const { calls } = await start();
    const mesh = meshOf(calls);
    expect(mesh.id).toBe(MESH_LAYER_ID);
    // 鳥取県のテスト用データは 1,763 メッシュ
    expect(mesh.geometry.length).toBe(1763);
    expect(mesh.colorKey).toBe("mesh/2050/base/aging_rate");
    expect(mesh.visible).toBe(true);
    expect(lastAdmin(calls).visible).toBe(false);
  });

  it("年を変えると、同じ形のまま色だけを作り直す", async () => {
    const { app, calls } = await start();
    const before = meshOf(calls);
    app.dispatch({ type: "year-selected", year: 2030 });
    await settle();
    const after = meshOf(calls);
    expect(after.geometry).toBe(before.geometry);
    expect(after.colorKey).toBe("mesh/2030/base/aging_rate");
  });

  it("市区町村に切り替えると、19 の市町村を塗り、メッシュは形を残して隠す", async () => {
    const { app, calls } = await start();
    const before = meshOf(calls);
    app.dispatch({ type: "unit-selected", unit: "municipality" });
    await settle();
    const admin = lastAdmin(calls);
    expect(admin.visible).toBe(true);
    expect(admin.colors.size).toBe(19);
    const hidden = meshOf(calls);
    expect(hidden.visible).toBe(false);
    expect(hidden.geometry).toBe(before.geometry);
  });

  it("続けて切り替えたら、最後の状態だけを描く", async () => {
    const { app, calls } = await start();
    for (const year of [2030, 2035, 2040]) {
      app.dispatch({ type: "year-selected", year });
    }
    await settle();
    const keys = calls
      .filter((c) => c.kind === "overlay")
      .map((c) => (c.kind === "overlay" ? c.layers.mesh?.colorKey : null));
    expect(keys.at(-1)).toBe("mesh/2040/base/aging_rate");
    expect(keys).not.toContain("mesh/2030/base/aging_rate");
  });

  it("点のデータを重ね、表示を変えても座標の配列とメッシュの指定は作り直さない", async () => {
    const { app, calls } = await start();
    await app.importFiles([file(POINTS_GEOJSON, "施設.geojson")]);
    await settle();
    const admins = calls.filter((c) => c.kind === "admin").length;
    const [point] = lastOverlay(calls).points;
    expect(point?.length).toBe(2);
    expect([...(point?.positions ?? [])]).toEqual([134.2253, 35.4941, 133.3305, 35.4278]);
    const mesh = meshOf(calls);
    await app.changeDatasetStyle("dataset-1", { color: "#d55e00" });
    await settle();
    const [restyled] = lastOverlay(calls).points;
    expect(restyled?.positions).toBe(point?.positions);
    expect(restyled?.color).toEqual([0xd5, 0x5e, 0x00, 255]);
    expect(meshOf(calls)).toBe(mesh);
    expect(calls.filter((c) => c.kind === "admin")).toHaveLength(admins);
  });

  it("点の件数をメッシュで塗り、凡例の区切りを runtime に置く", async () => {
    const { app, calls } = await start();
    await app.importFiles([file(POINTS_GEOJSON, "施設.geojson")]);
    const count: IndicatorSelection = {
      kind: "joined",
      datasetId: "dataset-1",
      measure: { kind: "count" },
      perPopulation: null,
    };
    app.dispatch({ type: "indicator-selected", indicator: count });
    await settle();
    const mesh = meshOf(calls);
    // 点のあるメッシュだけを描く
    expect(mesh.geometry.length).toBe(2);
    expect(app.store.getState().runtime.joinedClassification).not.toBeNull();

    app.dispatch({
      type: "indicator-selected",
      indicator: { ...count, perPopulation: { base: "p65", per: 1000 } },
    });
    await settle();
    expect(meshOf(calls).colorKey).toBe("mesh/2050/joined/dataset-1/count/p65:1000");

    app.dispatch({ type: "indicator-selected", indicator: { kind: "base", id: "pop" } });
    await settle();
    expect(app.store.getState().runtime.joinedClassification).toBeNull();
  });

  it("点を市区町村に割り当てて、点のない市町村を 0 件で塗る", async () => {
    const tables = fakeTables({}, (points) =>
      Promise.resolve({
        ok: true,
        value: { codes: Array.from(points.lon, (lon) => (lon > 134 ? "31201" : null)) },
      }),
    );
    const { app, calls } = await start({ tables });
    await app.importFiles([file(POINTS_GEOJSON, "施設.geojson")]);
    app.dispatch({ type: "unit-selected", unit: "municipality" });
    app.dispatch({
      type: "indicator-selected",
      indicator: {
        kind: "joined",
        datasetId: "dataset-1",
        measure: { kind: "count" },
        perPopulation: null,
      },
    });
    await settle();
    // 点の範囲に入る都道府県（鳥取県）の admin_geom だけを渡す
    expect(tables.assigned).toEqual([["31"]]);
    const admin = lastAdmin(calls);
    expect(admin.colors.size).toBe(19);
    expect(app.store.getState().runtime.assigningPoints).toBe(false);
  });

  it("消したデータの指標を選んでいたら、既定の指標に戻して塗り直す", async () => {
    const { app, calls } = await start();
    await app.importFiles([file(POINTS_GEOJSON, "施設.geojson")]);
    app.dispatch({
      type: "indicator-selected",
      indicator: {
        kind: "joined",
        datasetId: "dataset-1",
        measure: { kind: "sum", column: "beds" },
        perPopulation: null,
      },
    });
    await settle();
    await app.removeDataset("dataset-1");
    await settle();
    expect(meshOf(calls).colorKey).toBe("mesh/2050/base/aging_rate");
    expect(lastOverlay(calls).points).toEqual([]);
    expect(noticeKinds(app)).toContain("indicator-reset");
  });
});

describe("目録から復元した表の指標", () => {
  // 正規化した Parquet の代わりに、テスト用データの Parquet を同じ形の表として置く
  const restore = async (dataset: DatasetEntry, fixture: string) => {
    const storage = fakeOpfs();
    await storage.writeManifest(serializeManifest({ ...EMPTY_MANIFEST, datasets: [dataset] }));
    await storage.writeDataset(
      `${dataset.id}.parquet`,
      new Uint8Array(readFileSync(`tests/fixtures/${fixture}`)),
    );
    const { view, calls } = fakeMap();
    const app = createApp(testPorts({ storage, map: view }));
    await app.boot();
    await app.attachMap("map");
    return { app, calls };
  };

  it("code の表の合計を、人口あたりの値にして市区町村で塗る", async () => {
    const table: DatasetEntry = {
      ...entry("codes"),
      kind: "table",
      join: ["municipality"],
      columns: [
        { name: "code", type: "string" },
        { name: "pop", type: "integer" },
      ],
      stored_format: "parquet",
    };
    const { app, calls } = await restore(table, "municipal_indicators.tottori.parquet");
    app.dispatch({ type: "unit-selected", unit: "municipality" });
    app.dispatch({
      type: "indicator-selected",
      indicator: {
        kind: "joined",
        datasetId: "codes",
        measure: { kind: "sum", column: "pop" },
        perPopulation: { base: "pop", per: 1000 },
      },
    });
    await settle();
    const admin = lastAdmin(calls);
    expect(admin.visible).toBe(true);
    expect(admin.colors.has("31201")).toBe(true);
    expect(app.store.getState().runtime.joinedClassification?.colors.length).toBeGreaterThan(1);
  });

  it("mesh の表の件数を、ベースデータと同じメッシュの形で塗る", async () => {
    const table: DatasetEntry = {
      ...entry("meshes"),
      kind: "table",
      join: ["mesh"],
      columns: [{ name: "mesh", type: "integer" }],
      stored_format: "parquet",
    };
    const { app, calls } = await restore(table, "mesh_indicators.tottori.parquet");
    app.dispatch({
      type: "indicator-selected",
      indicator: {
        kind: "joined",
        datasetId: "meshes",
        measure: { kind: "count" },
        perPopulation: null,
      },
    });
    await settle();
    expect(meshOf(calls).geometry.length).toBe(1763);
    expect(meshOf(calls).colorKey).toBe("mesh/2050/joined/meshes/count/none");
  });
});

describe("場所への移動", () => {
  it("places.json を一度だけ読み、候補を出し、選んだ場所に地図を動かす", async () => {
    const { view, calls } = fakeMap();
    const app = createApp(testPorts({ map: view }));
    await app.attachMap("map");
    const loading = app.loadPlaces();
    expect(app.store.getState().runtime.places.kind).toBe("loading");
    await loading;
    expect(app.store.getState().runtime.places.kind).toBe("ready");
    const candidates = app.placeCandidates("鳥取");
    expect(candidates.map((c) => c.place.name)).toEqual(["鳥取県", "鳥取市"]);
    const [first] = candidates;
    if (first !== undefined) {
      app.moveToPlace(first.place);
    }
    expect(calls.at(-1)).toEqual({ kind: "fit", bbox: first?.place.bbox });
  });

  it("読めなければ失敗の状態にし、もう一度呼べば読み直す", async () => {
    const ports = testPorts({ json: { "places.json": [{ code: "x" }] } });
    const app = createApp(ports);
    await app.loadPlaces();
    expect(app.store.getState().runtime.places.kind).toBe("failed");
    expect(ports.errors.map((e) => e.kind)).toEqual(["base-data"]);
    expect(app.placeCandidates("鳥取")).toEqual([]);
  });
});
