import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    const columns = await base.meshColumns(names);
    if (!columns.ok) {
      throw new Error(JSON.stringify(columns.error));
    }
    expect(Object.keys(columns.value)).toEqual(names);
    // 2回目は持っている列から返す
    const again = await base.meshColumns(["2050_pop"]);
    expect(again.ok && again.value["2050_pop"]).toBe(columns.value["2050_pop"]);
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
