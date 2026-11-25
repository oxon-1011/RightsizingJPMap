import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WHOLE_COUNTRY } from "../core/region/region";
import type { DatasetEntry } from "../core/storage/manifest";
import { createBaseData, MESH_COLUMN_CACHE_SIZE } from "./base-data";
import { createDatasetCache, decodeDataset, decodeJson } from "./datasets";
import { fakeOpfs, testPorts } from "./test-fakes";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`tests/fixtures/${name}`));

const entry = (overrides: Partial<DatasetEntry>): DatasetEntry => ({
  id: "d",
  name: "d",
  source: { name: "d", size: 1 },
  imported_at: "2026-11-09T00:00:00Z",
  kind: "table",
  join: ["municipality"],
  columns: [],
  count: 1,
  style: { color: "#0072b2", size: 1, visible: true },
  stored_format: "parquet",
  ...overrides,
});

describe("decodeJson", () => {
  it("UTF-8 の JSON を読み、UTF-8 でないバイト列と JSON でない文字列を拒否する", () => {
    expect(decodeJson(new TextEncoder().encode('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
    expect(decodeJson(new Uint8Array([0x22, 0x93, 0x8c, 0x22])).ok).toBe(false);
    expect(decodeJson(new TextEncoder().encode("{")).ok).toBe(false);
  });
});

describe("decodeDataset", () => {
  // 正規化した Parquet の代わりに、テスト用データの Parquet を同じ形の表として読む
  it("code の表は、code 列と合計できる列を hyparquet で読む", async () => {
    const decoded = await decodeDataset(
      entry({
        columns: [
          { name: "code", type: "string" },
          { name: "name", type: "string" },
          { name: "pop", type: "integer" },
        ],
      }),
      fixture("municipal_indicators.tottori.parquet"),
    );
    if (!decoded.ok || decoded.value.kind !== "code") {
      throw new Error(JSON.stringify(decoded));
    }
    expect(decoded.value.codes).toHaveLength(140);
    expect(Object.keys(decoded.value.numeric)).toEqual(["pop"]);
  });

  it("mesh の表は、mesh 列を UINTEGER として読む", async () => {
    const decoded = await decodeDataset(
      entry({
        join: ["mesh"],
        columns: [
          { name: "mesh", type: "integer" },
          { name: "2050_pop", type: "float" },
        ],
      }),
      fixture("mesh_indicators.tottori.parquet"),
    );
    if (!decoded.ok || decoded.value.kind !== "mesh") {
      throw new Error(JSON.stringify(decoded));
    }
    expect(decoded.value.meshes).toBeInstanceOf(Uint32Array);
    expect(decoded.value.meshes).toHaveLength(1763);
  });

  it("線と面の GeoJSON は地図に渡す値に、点の GeoJSON は座標の列にする", async () => {
    const line = new TextEncoder().encode(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: null,
            geometry: {
              type: "LineString",
              coordinates: [
                [134.2, 35.5],
                [134.3, 35.5],
              ],
            },
          },
        ],
      }),
    );
    const decoded = await decodeDataset(
      entry({ kind: "line", join: [], stored_format: "geojson" }),
      line,
    );
    expect(decoded.ok && decoded.value.kind).toBe("shape");

    const point = new TextEncoder().encode(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { beds: 3 },
            geometry: { type: "Point", coordinates: [134.2, 35.5] },
          },
        ],
      }),
    );
    const points = await decodeDataset(
      entry({ kind: "point", join: ["mesh", "municipality"], stored_format: "geojson" }),
      point,
    );
    if (!points.ok || points.value.kind !== "point") {
      throw new Error(JSON.stringify(points));
    }
    expect([...points.value.lat]).toEqual([35.5]);
    expect(Array.from(new Map(Object.entries(points.value.numeric)).get("beds") ?? [])).toEqual([
      3,
    ]);
  });

  it("目録と形の違うファイルは失敗にする", async () => {
    const decoded = await decodeDataset(
      entry({ join: ["mesh"], columns: [{ name: "mesh", type: "integer" }] }),
      fixture("municipal_indicators.tottori.parquet"),
    );
    expect(decoded.ok).toBe(false);
  });
});

describe("createDatasetCache", () => {
  it("同じデータは一度だけ読み、目録から消えたものを捨てる", async () => {
    const storage = fakeOpfs();
    await storage.writeDataset("d.parquet", fixture("municipal_indicators.tottori.parquet"));
    let reads = 0;
    const counted = {
      ...storage,
      readDataset: (name: string) => {
        reads++;
        return storage.readDataset(name);
      },
    };
    const cache = createDatasetCache({
      storage: () => counted,
      assignPoints: () => Promise.reject(new Error("呼ばない")),
    });
    const table = entry({ columns: [{ name: "code", type: "string" }] });
    const [a, b] = await Promise.all([cache.load(table), cache.load(table)]);
    expect(a).toBe(b);
    const aggregate = await cache.codeJoin(table);
    expect(aggregate.ok && aggregate.value.keys).toContain("31201");
    expect(reads).toBe(1);
    cache.retain(new Set());
    await cache.load(table);
    expect(reads).toBe(2);
  });
});

describe("createBaseData", () => {
  it("持っておく列の数より多い列を一度に求めても、すべて返す", async () => {
    const base = createBaseData(testPorts());
    const years = [2025, 2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065, 2070];
    const names = years.flatMap((y) => [`${y}_pop`, `${y}_p65`]);
    expect(names.length).toBeGreaterThan(MESH_COLUMN_CACHE_SIZE);
    const columns = await base.meshColumns(WHOLE_COUNTRY, names);
    if (!columns.ok) {
      throw new Error(JSON.stringify(columns.error));
    }
    expect(Object.keys(columns.value)).toEqual(names);
    // 2回目は持っている列から返す
    const again = await base.meshColumns(WHOLE_COUNTRY, ["2050_pop"]);
    expect(again.ok && again.value["2050_pop"]).toBe(columns.value["2050_pop"]);
  });

  it("地域のメッシュは、都道府県ごとのファイルだけから読む", async () => {
    const ports = testPorts();
    const base = createBaseData(ports);
    const mesh = await base.mesh(["31"]);
    const columns = await base.meshColumns(["31"], ["2050_pop"]);
    if (!mesh.ok || !columns.ok) {
      throw new Error("読めなかった");
    }
    expect(mesh.value.codes.length).toBe(1763);
    expect(columns.value["2050_pop"]).toHaveLength(1763);
    expect(ports.openedParquet).toEqual(["mesh_pref/31.parquet"]);
  });

  it("複数の都道府県のファイルを、重複のない昇順の並びに合わせる", async () => {
    // 2つめのファイルにも鳥取県の分を使う。すべての行が県境のメッシュのように重なる場合にあたる
    const ports = testPorts({ parquetAliases: { "mesh_pref/32.parquet": "mesh_pref/31.parquet" } });
    const base = createBaseData(ports);
    const single = await base.mesh(["31"]);
    const merged = await base.mesh(["31", "32"]);
    const one = await base.meshColumns(["31"], ["2050_pop", "2050_masked"]);
    const two = await base.meshColumns(["31", "32"], ["2050_pop", "2050_masked"]);
    if (!single.ok || !merged.ok || !one.ok || !two.ok) {
      throw new Error("読めなかった");
    }
    expect(merged.value.codes).toEqual(single.value.codes);
    expect(merged.value.geometry.length).toBe(1763);
    expect(two.value["2050_pop"]).toEqual(one.value["2050_pop"]);
    expect(two.value["2050_masked"]).toEqual(one.value["2050_masked"]);
    // 鳥取県のファイルは、2つの地域で1回しか開かない
    expect(ports.openedParquet).toEqual(["mesh_pref/31.parquet", "mesh_pref/32.parquet"]);
  });

  it("地域のファイルのどれかを読めなければ失敗", async () => {
    const base = createBaseData(testPorts());
    const mesh = await base.mesh(["31", "32"]);
    expect(mesh).toMatchObject({
      ok: false,
      error: { kind: "base-data", file: "mesh_pref/32.parquet" },
    });
  });

  it("市区町村の表と、地図で塗る単位の団体コードを作る", async () => {
    const base = createBaseData(testPorts());
    const municipal = await base.municipal();
    if (!municipal.ok) {
      throw new Error(JSON.stringify(municipal.error));
    }
    expect(municipal.value.paintedCodes.size).toBe(19);
    expect(municipal.value.paintedCodes.has("31000")).toBe(false);
  });
});
