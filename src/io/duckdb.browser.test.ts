import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import type { Result } from "../core/result";
import {
  type DuckDb,
  dropFile,
  loadSpatial,
  type QueryResult,
  query,
  readFileBytes,
  registerFile,
  startDuckDb,
} from "./duckdb";

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const encoder = new TextEncoder();

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
/** Shift_JIS の「東京」 */
const SJIS_TOKYO = new Uint8Array([0x93, 0x8c, 0x8b, 0x9e]);

/** 列の名前から値を引く */
const valuesOf = (result: QueryResult, name: string): readonly unknown[] =>
  result.columns.find((column) => column.name === name)?.values ?? [];

const typeOf = (result: QueryResult, name: string): string | undefined =>
  result.columns.find((column) => column.name === name)?.type;

let duck: DuckDb;

beforeAll(async () => {
  duck = unwrap(await startDuckDb());
});

afterAll(async () => {
  await duck.db.terminate();
});

describe("startDuckDb", () => {
  it("COOP と COEP のないページで、シングルスレッドの bundle が起動する", () => {
    expect(globalThis.crossOriginIsolated).toBe(false);
    expect(duck.version).toBe("v1.5.4");
    // Chromium は WebAssembly の例外処理に対応しているので eh が選ばれる
    expect(duck.bundle).toBe("eh");
  });

  it("wasm の取得の進み具合を知らせる。速く取得できたときは一度も呼ばれないことがある", async () => {
    const progress: { bytesLoaded: number; bytesTotal: number }[] = [];
    const other = unwrap(await startDuckDb({ onProgress: (p) => progress.push(p) }));
    await other.db.terminate();
    for (const p of progress) expect(p.bytesLoaded).toBeLessThanOrEqual(p.bytesTotal);
  });
});

describe("query", () => {
  it("列の名前、Arrow の型、値の配列を返す。NULL は null、BIGINT は number になる", async () => {
    const result = unwrap(
      await query(
        duck,
        "SELECT * FROM (VALUES (1::INTEGER, 'a', 10::BIGINT, true), (NULL, NULL, NULL, NULL)) t(i, s, b, f)",
      ),
    );
    expect(result.numRows).toBe(2);
    expect(result.columns.map((c) => [c.name, c.type])).toEqual([
      ["i", "Int32"],
      ["s", "Utf8"],
      ["b", "Float64"],
      ["f", "Bool"],
    ]);
    expect(valuesOf(result, "i")).toEqual([1, null]);
    expect(valuesOf(result, "s")).toEqual(["a", null]);
    expect(valuesOf(result, "b")).toEqual([10, null]);
    expect(valuesOf(result, "f")).toEqual([true, null]);
  });

  it("BIGINT の合計（HUGEINT）も number になる", async () => {
    const result = unwrap(
      await query(
        duck,
        "SELECT sum(x) AS s, count(*) AS n FROM (VALUES (1::BIGINT), (2::BIGINT)) t(x)",
      ),
    );
    expect(valuesOf(result, "s")).toEqual([3]);
    expect(valuesOf(result, "n")).toEqual([2]);
  });

  it("失敗した問い合わせは、SQL とエラーの文を返す", async () => {
    const result = await query(duck, "SELECT * FROM no_such_table");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("query-failed");
    expect(result.error).toMatchObject({ sql: "SELECT * FROM no_such_table" });
  });
});

describe("registerFile", () => {
  it("バイト列は複製して渡すので、呼び出し側のバイト列は使えるまま残る", async () => {
    const bytes = encoder.encode("a\n1\n");
    unwrap(await registerFile(duck, "copied.csv", bytes));
    expect(bytes.byteLength).toBe(4);
    const result = unwrap(await query(duck, "SELECT a FROM read_csv('copied.csv')"));
    expect(valuesOf(result, "a")).toEqual([1]);
    unwrap(await dropFile(duck, "copied.csv"));
  });

  it("Blob（利用者が選んだ File など）を登録して読める", async () => {
    unwrap(await registerFile(duck, "blob.csv", new Blob(["code,v\n01101,1\n"])));
    const result = unwrap(await query(duck, "SELECT * FROM read_csv('blob.csv')"));
    expect(valuesOf(result, "code")).toEqual(["01101"]);
    unwrap(await dropFile(duck, "blob.csv"));
  });

  it("登録を消したファイルは読めない", async () => {
    unwrap(await registerFile(duck, "dropped.csv", encoder.encode("a\n1\n")));
    unwrap(await dropFile(duck, "dropped.csv"));
    const result = await query(duck, "SELECT * FROM read_csv('dropped.csv')");
    expect(result.ok).toBe(false);
  });
});

// docs/design/README.md の「実装時に確かめること」と、受け入れ条件の CSV の読み方
describe("read_csv の文字コード", () => {
  it("BOM 付きの UTF-8 を読め、列名に BOM が残らない", async () => {
    const bytes = concat(UTF8_BOM, encoder.encode("code,value\n01101,10\n"));
    unwrap(await registerFile(duck, "bom.csv", bytes));
    const result = unwrap(await query(duck, "SELECT * FROM read_csv('bom.csv')"));
    expect(result.columns.map((c) => c.name)).toEqual(["code", "value"]);
    expect(valuesOf(result, "code")).toEqual(["01101"]);
  });

  it("Shift_JIS の列名はエラーになる", async () => {
    // 「名前,code」と「東京,13101」
    const bytes = concat(
      new Uint8Array([0x96, 0xbc, 0x91, 0x4f]),
      encoder.encode(",code\n"),
      SJIS_TOKYO,
      encoder.encode(",13101\n"),
    );
    unwrap(await registerFile(duck, "sjis-header.csv", bytes));
    const result = await query(duck, "SELECT * FROM read_csv('sjis-header.csv')");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      message: expect.stringContaining("This file is not utf-8 encoded"),
    });
  });

  it("Shift_JIS の値は、all_varchar を指定してもエラーになる", async () => {
    const bytes = concat(encoder.encode("name,code\n"), SJIS_TOKYO, encoder.encode(",13101\n"));
    unwrap(await registerFile(duck, "sjis-value.csv", bytes));
    for (const sql of [
      "SELECT * FROM read_csv('sjis-value.csv')",
      "SELECT * FROM read_csv('sjis-value.csv', all_varchar = true)",
    ]) {
      const result = await query(duck, sql);
      expect(result.ok).toBe(false);
    }
  });

  it("後ろの行の Shift_JIS は、全行を読んだときにだけエラーになる", async () => {
    // 型の推定（sample_size = 20480 行）より後ろに Shift_JIS の行を置く
    const bytes = concat(
      encoder.encode(`name,code\n${"a,13101\n".repeat(30_000)}`),
      SJIS_TOKYO,
      encoder.encode(",13101\n"),
    );
    unwrap(await registerFile(duck, "sjis-late.csv", bytes));
    const head = await query(duck, "SELECT * FROM read_csv('sjis-late.csv') LIMIT 2");
    expect(head.ok).toBe(true);
    const describe = await query(duck, "DESCRIBE SELECT * FROM read_csv('sjis-late.csv')");
    expect(describe.ok).toBe(true);
    const all = await query(duck, "SELECT count(*) FROM read_csv('sjis-late.csv')");
    expect(all.ok).toBe(false);
  });
});

describe("read_csv で結合用の列を文字列として読む", () => {
  const csv = "code,mesh,value\n13101,53394611,10\n13102,53394612,20\n";

  beforeAll(async () => {
    unwrap(await registerFile(duck, "join.csv", encoder.encode(csv)));
    unwrap(await registerFile(duck, "zero.csv", encoder.encode("code,value\n01101,1\n13101,2\n")));
  });

  it("型の推定に任せると、先頭が 0 でない団体コードとメッシュコードは整数になる", async () => {
    const result = unwrap(await query(duck, "SELECT * FROM read_csv('join.csv')"));
    expect(typeOf(result, "code")).toBe("Float64");
    expect(valuesOf(result, "code")).toEqual([13101, 13102]);
    // 先頭が 0 の値を含む列は、推定で VARCHAR になる
    const zero = unwrap(await query(duck, "SELECT * FROM read_csv('zero.csv')"));
    expect(valuesOf(zero, "code")).toEqual(["01101", "13101"]);
  });

  it("types に、ファイルにない列を書くと Binder Error になる", async () => {
    const result = await query(
      duck,
      "SELECT * FROM read_csv('join.csv', types = {'code': 'VARCHAR', 'lat': 'VARCHAR'})",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      message: expect.stringContaining('Columns with names: "lat" do not exist in the CSV File'),
    });
  });

  it("DESCRIBE で列名を得てから、ある列だけを types で VARCHAR にできる", async () => {
    const described = unwrap(await query(duck, "DESCRIBE SELECT * FROM read_csv('join.csv')"));
    expect(valuesOf(described, "column_name")).toEqual(["code", "mesh", "value"]);
    expect(valuesOf(described, "column_type")).toEqual(["BIGINT", "BIGINT", "BIGINT"]);

    const result = unwrap(
      await query(
        duck,
        "SELECT * FROM read_csv('join.csv', types = {'code': 'VARCHAR', 'mesh': 'VARCHAR'})",
      ),
    );
    expect(valuesOf(result, "code")).toEqual(["13101", "13102"]);
    expect(valuesOf(result, "mesh")).toEqual(["53394611", "53394612"]);
    // 指定しなかった列は推定のまま
    expect(valuesOf(result, "value")).toEqual([10, 20]);
  });

  it("BOM 付きのファイルでも、1列目の名前で types を指定できる", async () => {
    unwrap(await registerFile(duck, "bom-join.csv", concat(UTF8_BOM, encoder.encode(csv))));
    const result = unwrap(
      await query(duck, "SELECT code FROM read_csv('bom-join.csv', types = {'code': 'VARCHAR'})"),
    );
    expect(valuesOf(result, "code")).toEqual(["13101", "13102"]);
  });

  it("all_varchar はすべての列を VARCHAR にする", async () => {
    const result = unwrap(
      await query(duck, "SELECT * FROM read_csv('join.csv', all_varchar = true)"),
    );
    expect(result.columns.map((c) => c.type)).toEqual(["Utf8", "Utf8", "Utf8"]);
    expect(valuesOf(result, "value")).toEqual(["10", "20"]);
  });
});

describe("Parquet の書き出し", () => {
  it("COPY で zstd の Parquet を書き、バイト列として取り出せる", async () => {
    unwrap(
      await query(
        duck,
        "COPY (SELECT range::UINTEGER AS mesh FROM range(10)) TO 'out.parquet' (FORMAT parquet, COMPRESSION zstd)",
      ),
    );
    const bytes = unwrap(await readFileBytes(duck, "out.parquet"));
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("PAR1");
    unwrap(await dropFile(duck, "out.parquet"));
    expect(await readFileBytes(duck, "out.parquet")).toEqual({
      ok: false,
      error: { kind: "file-not-found", name: "out.parquet" },
    });
  });

  it("書いていないファイルは取り出せず、DuckDB の側にもファイルを作らない", async () => {
    expect(await readFileBytes(duck, "missing.parquet")).toEqual({
      ok: false,
      error: { kind: "file-not-found", name: "missing.parquet" },
    });
    expect(await duck.db.globFiles("missing.parquet")).toEqual([]);
  });
});

// extensions.duckdb.org から拡張を取得するので、ネットワークが要る
describe("loadSpatial", () => {
  it("spatial 拡張を読み込み、ST_Contains で点がポリゴンに入るかを判定できる", async () => {
    unwrap(await loadSpatial(duck));
    const result = unwrap(
      await query(
        duck,
        `SELECT
           ST_Contains(ST_GeomFromText('POLYGON((139 35, 140 35, 140 36, 139 36, 139 35))'), ST_Point(139.76, 35.68)) AS inside,
           ST_Contains(ST_GeomFromText('POLYGON((139 35, 140 35, 140 36, 139 36, 139 35))'), ST_Point(141.35, 43.06)) AS outside`,
      ),
    );
    expect(valuesOf(result, "inside")).toEqual([true]);
    expect(valuesOf(result, "outside")).toEqual([false]);
  });

  it("読み込み済みなら、もう一度呼んでも成功する", async () => {
    unwrap(await loadSpatial(duck));
    unwrap(await loadSpatial(duck));
  });
});

describe("admin_geom（GeoParquet 1.1）", () => {
  const FIXTURE = "tests/fixtures/admin_geom.tottori.parquet";
  // 鳥取駅は鳥取市（31201）、米子駅は米子市（31202）に入る
  const ASSIGN = `SELECT p.label, a.code
    FROM (VALUES ('鳥取駅', 134.2253, 35.4941), ('米子駅', 133.3305, 35.4278)) p(label, lon, lat)
    LEFT JOIN read_parquet('admin_geom.parquet') a
      ON ST_Contains(ST_GeomFromWKB(a.geometry), ST_Point(p.lon, p.lat))
    ORDER BY p.label`;

  const startWithFixture = async (): Promise<DuckDb> => {
    const fresh = unwrap(await startDuckDb());
    const text = await commands.readFile(FIXTURE, { encoding: "base64" });
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    unwrap(await registerFile(fresh, "admin_geom.parquet", bytes));
    return fresh;
  };

  it("geometry 列は、spatial 拡張の前後どちらで読んでも BLOB になる", async () => {
    const fresh = await startWithFixture();
    const describeSql = "DESCRIBE SELECT * FROM read_parquet('admin_geom.parquet')";
    const before = unwrap(await query(fresh, describeSql));
    unwrap(await loadSpatial(fresh));
    const after = unwrap(await query(fresh, describeSql));
    for (const result of [before, after]) {
      const types = new Map(
        valuesOf(result, "column_name").map((name, i) => [
          name,
          valuesOf(result, "column_type")[i],
        ]),
      );
      expect(types.get("geometry")).toBe("BLOB");
    }
    await fresh.db.terminate();
  });

  it("spatial 拡張を先に読み込んでも、点を区域に割り当てられる", async () => {
    const fresh = await startWithFixture();
    unwrap(await loadSpatial(fresh));
    const result = unwrap(await query(fresh, ASSIGN));
    expect(valuesOf(result, "label")).toEqual(["米子駅", "鳥取駅"]);
    expect(valuesOf(result, "code")).toEqual(["31202", "31201"]);
    await fresh.db.terminate();
  });

  it("ファイルを先に読んでから spatial 拡張を読み込んでも、同じ結果になる", async () => {
    const fresh = await startWithFixture();
    unwrap(await query(fresh, "SELECT count(*) FROM read_parquet('admin_geom.parquet')"));
    unwrap(await loadSpatial(fresh));
    const result = unwrap(await query(fresh, ASSIGN));
    expect(valuesOf(result, "code")).toEqual(["31202", "31201"]);
    await fresh.db.terminate();
  });
});
