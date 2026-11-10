import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { planTableJoin, type TableFormat } from "../core/accept/table";
import type { Result } from "../core/result";
import { openParquetBuffer, readParquetColumns } from "../io/parquet";
import { createDuckDbEngine } from "./duckdb-engine";
import type { TableEngine, TableSource } from "./ports";

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const encoder = new TextEncoder();

const fixtureBytes = async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
  const text = await commands.readFile(path, { encoding: "base64" });
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
};

let engine: TableEngine;

beforeAll(() => {
  engine = createDuckDbEngine();
});

afterAll(async () => {
  await engine.stop();
});

const open = async (
  content: string | Uint8Array<ArrayBuffer>,
  format: TableFormat,
): Promise<TableSource> => unwrap(await engine.openTable(new Blob([content]), format));

describe("CSV の列", () => {
  it("結合用の列を文字列として読み、属性の列は型を推定する", async () => {
    const source = await open("code,病床数,名称\n01101,10,a\n13101,2.5,b\n", "csv");
    expect(source.columns).toEqual([
      { name: "code", type: "string" },
      { name: "病床数", type: "float" },
      { name: "名称", type: "string" },
    ]);
    const plan = unwrap(planTableJoin(source.columns));
    expect(unwrap(await source.readJoinValues(plan))).toEqual({
      code: { type: "string", values: ["01101", "13101"] },
    });
    await source.close();
  });

  it("列名は1行目のとおりにする。前後に空白のある code は結合用の列にしない", async () => {
    const source = await open(" code,v\n01101,1\n", "csv");
    expect(source.columns.map((c) => c.name)).toEqual([" code", "v"]);
    expect(planTableJoin(source.columns)).toEqual({
      ok: false,
      error: { kind: "no-join-columns" },
    });
    await source.close();
  });

  it("重なった列名は、DuckDB が付け替える前の名前で返す", async () => {
    const source = await open("code,code,v\n01101,01102,1\n", "csv");
    expect(planTableJoin(source.columns)).toEqual({
      ok: false,
      error: { kind: "duplicate-column-names", names: ["code"] },
    });
    await source.close();
  });

  it("1行目が列名でない CSV、列の数がそろわない CSV、列名が空の CSV は読めない", async () => {
    for (const content of ["title\ncode,v\n01101,1\n", "code,v\n01101,1,2\n", "code,,v\n1,2,3\n"]) {
      const opened = await engine.openTable(new Blob([content]), "csv");
      expect(opened).toMatchObject({ ok: false, error: { kind: "read-failed" } });
    }
  });

  it("型の推定より後ろの行が UTF-8 でなくても、全行から型を推定するので読めない", async () => {
    const head = encoder.encode(`code,name\n${"31201,a\n".repeat(30_000)}31201,`);
    const sjis = new Uint8Array([0x93, 0x8c, 0x8b, 0x9e, 0x0a]);
    const bytes = new Uint8Array(head.length + sjis.length);
    bytes.set(head);
    bytes.set(sjis, head.length);
    const opened = await engine.openTable(new Blob([bytes]), "csv");
    expect(opened).toMatchObject({
      ok: false,
      error: { kind: "read-failed", message: expect.stringContaining("not utf-8 encoded") },
    });
  });
});

describe("正規化した Parquet", () => {
  it("結合用の列を保存の型に、数値の属性を DOUBLE にし、列名を元のとおりに残す", async () => {
    const source = await open("mesh,lat_note, 病床数\n53394611,x,10\n53394612,y,\n", "csv");
    const plan = unwrap(planTableJoin(source.columns));
    const bytes = unwrap(await source.writeNormalized(plan));
    await source.close();
    const parquet = unwrap(await openParquetBuffer(bytes.slice().buffer));
    expect(parquet.columns.map((c) => [c.name, c.type])).toEqual([
      ["mesh", "UINTEGER"],
      ["lat_note", "VARCHAR"],
      [" 病床数", "DOUBLE"],
    ]);
    const read = unwrap(await readParquetColumns(parquet, ["mesh", " 病床数"]));
    const meshes = read.columns.get("mesh");
    const beds = read.columns.get(" 病床数");
    expect(meshes instanceof Uint32Array && Array.from(meshes)).toEqual([53394611, 53394612]);
    expect(beds instanceof Float64Array && Array.from(beds)).toEqual([10, Number.NaN]);
  });

  it("点の lat と lon は、文字列で書かれていても DOUBLE にする", async () => {
    const source = await open("lat,lon\n35.4941,134.2253\n", "csv");
    const plan = unwrap(planTableJoin(source.columns));
    const bytes = unwrap(await source.writeNormalized(plan));
    await source.close();
    const parquet = unwrap(await openParquetBuffer(bytes.slice().buffer));
    expect(parquet.columns.map((c) => [c.name, c.type])).toEqual([
      ["lat", "DOUBLE"],
      ["lon", "DOUBLE"],
    ]);
  });
});

describe("Parquet の列", () => {
  it("Parquet の型のまま読み、整数型の code は core が拒否する", async () => {
    const parquet = await fixtureBytes("tests/fixtures/municipal_indicators.tottori.parquet");
    const source = await open(parquet, "parquet");
    expect(source.columns.find((c) => c.name === "code")).toEqual({
      name: "code",
      type: "string",
    });
    expect(source.columns.find((c) => c.name === "pop")).toEqual({ name: "pop", type: "integer" });
    await source.close();
  });
});

// extensions.duckdb.org から spatial 拡張を取得するので、ネットワークが要る
describe("assignPoints", () => {
  it("点を、admin_geom のポリゴンで市町村に割り当てる。どこにも入らない点は null", async () => {
    const bytes = await fixtureBytes("tests/fixtures/admin_geom.tottori.parquet");
    const assigned = unwrap(
      await engine.assignPoints(
        {
          // 鳥取駅、日本海の上、米子駅
          lat: Float64Array.from([35.4941, 35.7, 35.4278]),
          lon: Float64Array.from([134.2253, 134.0, 133.3305]),
        },
        [{ prefCode: "31", bytes }],
      ),
    );
    expect(assigned.codes).toEqual(["31201", null, "31202"]);
  });
});
