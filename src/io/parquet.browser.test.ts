import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import type { Result } from "../core/result";
import { type DuckDb, dropFile, query, readFileBytes, registerFile, startDuckDb } from "./duckdb";
import { openStorage } from "./opfs";
import { openParquetBuffer, openParquetUrl, type ParquetFile, readParquetColumns } from "./parquet";

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

let duck: DuckDb;

beforeAll(async () => {
  duck = unwrap(await startDuckDb());
});

afterAll(async () => {
  await duck.db.terminate();
});

/** DuckDB-WASM に zstd の Parquet を書かせ、そのバイト列を返す。行グループが分かれるよう小さくする */
const writeParquet = async (select: string): Promise<ArrayBuffer> => {
  unwrap(
    await query(
      duck,
      `COPY (${select}) TO 'test.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2048)`,
    ),
  );
  const bytes = unwrap(await readFileBytes(duck, "test.parquet"));
  unwrap(await dropFile(duck, "test.parquet"));
  return bytes.slice().buffer;
};

const openWritten = async (select: string): Promise<ParquetFile> =>
  unwrap(await openParquetBuffer(await writeParquet(select)));

describe("DuckDB-WASM が書いた zstd の Parquet を hyparquet で読む", () => {
  const ROWS = 5000;
  let parquet: ParquetFile;

  beforeAll(async () => {
    parquet = await openWritten(`
      SELECT
        CASE WHEN range = 0 THEN 4294967295 ELSE 53394611 + range END::UINTEGER AS mesh,
        CASE WHEN range % 7 = 0 THEN NULL ELSE range * 0.5 END::FLOAT AS pop,
        (range % 3 = 0) AS masked,
        CASE WHEN range % 5 = 0 THEN NULL ELSE 2020 + range END::INTEGER AS year,
        (range * 1000000000)::BIGINT AS big,
        (range / 4)::DOUBLE AS ratio,
        lpad(range::VARCHAR, 5, '0') AS code,
        DATE '2020-01-01' AS day
      FROM range(${ROWS})`);
  });

  it("圧縮は zstd で、行グループが複数に分かれている", () => {
    expect(parquet.metadata.row_groups.length).toBeGreaterThan(1);
    expect(parquet.metadata.row_groups[0]?.columns[0]?.meta_data?.codec).toBe("ZSTD");
  });

  it("列の型を DuckDB の型の名前で返す。変換できない型は unsupported にする", () => {
    expect(parquet.numRows).toBe(ROWS);
    expect(parquet.columns.map((c) => [c.name, c.type])).toEqual([
      ["mesh", "UINTEGER"],
      ["pop", "FLOAT"],
      ["masked", "BOOLEAN"],
      ["year", "INTEGER"],
      ["big", "BIGINT"],
      ["ratio", "DOUBLE"],
      ["code", "VARCHAR"],
      ["day", "unsupported"],
    ]);
    expect(parquet.columns.find((c) => c.name === "day")?.physicalType).toBe("INT32");
  });

  it("指定した列だけを、契約の型付き配列に変換して返す", async () => {
    const { numRows, columns } = unwrap(
      await readParquetColumns(parquet, ["mesh", "pop", "masked", "year", "big", "ratio", "code"]),
    );
    expect(numRows).toBe(ROWS);
    expect([...columns.keys()]).toEqual(["mesh", "pop", "masked", "year", "big", "ratio", "code"]);

    const mesh = columns.get("mesh");
    expect(mesh).toBeInstanceOf(Uint32Array);
    expect(mesh?.[0]).toBe(4294967295);
    expect(mesh?.[ROWS - 1]).toBe(53394611 + ROWS - 1);

    const pop = columns.get("pop");
    expect(pop).toBeInstanceOf(Float32Array);
    expect(pop?.[0]).toBeNaN();
    expect(pop?.[1]).toBe(0.5);
    expect(pop?.[4999]).toBe(2499.5);

    const masked = columns.get("masked");
    expect(masked).toBeInstanceOf(Uint8Array);
    expect(Array.from(masked instanceof Uint8Array ? masked.subarray(0, 4) : [])).toEqual([
      1, 0, 0, 1,
    ]);

    const year = columns.get("year");
    expect(year).toBeInstanceOf(Float64Array);
    expect(year?.[0]).toBeNaN();
    expect(year?.[1]).toBe(2021);

    const big = columns.get("big");
    expect(big).toBeInstanceOf(Float64Array);
    expect(big?.[4999]).toBe(4_999_000_000_000);

    const ratio = columns.get("ratio");
    expect(ratio).toBeInstanceOf(Float64Array);
    expect(ratio?.[3]).toBe(0.75);

    const code = columns.get("code");
    expect(Array.isArray(code)).toBe(true);
    expect(code?.[0]).toBe("00000");
    expect(code?.[4999]).toBe("04999");
  });

  it("ない列と、変換できない型の列は読まない", async () => {
    expect(await readParquetColumns(parquet, ["mesh", "nothing"])).toEqual({
      ok: false,
      error: { kind: "column-not-found", column: "nothing" },
    });
    expect(await readParquetColumns(parquet, ["day"])).toEqual({
      ok: false,
      error: { kind: "unsupported-type", column: "day", physicalType: "INT32" },
    });
  });
});

describe("NULL を表せない型", () => {
  it("UINTEGER、BOOLEAN、VARCHAR の列に NULL があれば、最初の行の番号を返す", async () => {
    const parquet = await openWritten(`
      SELECT
        CASE WHEN range = 3 THEN NULL ELSE range END::UINTEGER AS mesh,
        CASE WHEN range = 4 THEN NULL ELSE true END AS masked,
        CASE WHEN range = 5 THEN NULL ELSE 'a' END AS code
      FROM range(10)`);
    expect(await readParquetColumns(parquet, ["mesh"])).toEqual({
      ok: false,
      error: { kind: "null-not-representable", column: "mesh", type: "UINTEGER", row: 3 },
    });
    expect(await readParquetColumns(parquet, ["masked"])).toEqual({
      ok: false,
      error: { kind: "null-not-representable", column: "masked", type: "BOOLEAN", row: 4 },
    });
    expect(await readParquetColumns(parquet, ["code"])).toEqual({
      ok: false,
      error: { kind: "null-not-representable", column: "code", type: "VARCHAR", row: 5 },
    });
  });
});

describe("壊れたファイルと通信の失敗", () => {
  it("Parquet でないバイト列は invalid-file になる", async () => {
    const result = await openParquetBuffer(new TextEncoder().encode("not a parquet file").buffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-file");
  });

  it("大きさを知るためのリクエストが失敗すると fetch-failed になる", async () => {
    const result = await openParquetUrl("https://example.invalid/missing.parquet", {
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    expect(result).toEqual({ ok: false, error: { kind: "fetch-failed", message: "HTTP 404" } });
  });
});

describe("取り込みの流れ", () => {
  it("CSV を DuckDB-WASM で Parquet にして OPFS に保存し、読み直して hyparquet と DuckDB-WASM の両方で読める", async () => {
    const csv = "﻿code,beds\n01101,120\n13101,80\n";
    unwrap(await registerFile(duck, "upload.csv", new Blob([csv])));
    unwrap(
      await query(
        duck,
        `COPY (SELECT * FROM read_csv('upload.csv', types = {'code': 'VARCHAR'}))
         TO 'normalized.parquet' (FORMAT parquet, COMPRESSION zstd)`,
      ),
    );
    const bytes = unwrap(await readFileBytes(duck, "normalized.parquet"));
    unwrap(await dropFile(duck, "normalized.parquet"));

    const storage = await openStorage();
    unwrap(await storage.writeDataset("round-trip.parquet", bytes));
    const restored = unwrap(await storage.readDataset("round-trip.parquet"));
    unwrap(await storage.removeDataset("round-trip.parquet"));

    const parquet = unwrap(await openParquetBuffer(restored.slice().buffer));
    expect(parquet.columns.map((c) => [c.name, c.type])).toEqual([
      ["code", "VARCHAR"],
      ["beds", "BIGINT"],
    ]);
    const { columns } = unwrap(await readParquetColumns(parquet, ["code", "beds"]));
    expect(columns.get("code")).toEqual(["01101", "13101"]);
    expect(columns.get("beds")).toEqual(new Float64Array([120, 80]));

    unwrap(await registerFile(duck, "restored.parquet", restored));
    const described = unwrap(await query(duck, "DESCRIBE SELECT * FROM 'restored.parquet'"));
    expect(described.columns.find((c) => c.name === "column_type")?.values).toEqual([
      "VARCHAR",
      "BIGINT",
    ]);
    unwrap(await dropFile(duck, "restored.parquet"));
  });
});

/** commands.writeFile に渡すため、バイト列を base64 にする */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

type RecordedRequest = {
  readonly method: string;
  readonly range: string | null;
  readonly status: number;
  readonly bytes: number;
};

describe("URL から Range リクエストで読む", () => {
  // テストのサーバー（Vite）が配信できるよう、プロジェクトの中に一時的に置く。パスはプロジェクトの直下から数える
  const path = "src/io/parquet-range.tmp.parquet";
  const url = `/${path}`;
  const ROWS = 200_000;
  let fileSize = 0;
  let expected: Float32Array;

  beforeAll(async () => {
    // 圧縮の効かない乱数の列を4つ並べ、1列がファイルのおよそ 1/4 を占めるようにする
    const buffer = await writeParquet(`
      SELECT random()::FLOAT AS a, random()::FLOAT AS b, random()::FLOAT AS c, random()::FLOAT AS d
      FROM range(${ROWS})`);
    fileSize = buffer.byteLength;
    const fromBuffer = unwrap(
      await readParquetColumns(unwrap(await openParquetBuffer(buffer)), ["b"]),
    );
    const b = fromBuffer.columns.get("b");
    if (!(b instanceof Float32Array)) throw new Error("column b is not Float32Array");
    expected = b;
    await commands.writeFile(path, toBase64(new Uint8Array(buffer)), { encoding: "base64" });
  });

  afterAll(async () => {
    await commands.removeFile(path);
  });

  it("テストのサーバーは Range リクエストに 206 を返す", async () => {
    const response = await fetch(url, { headers: { Range: "bytes=0-3" } });
    expect(response.status).toBe(206);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("PAR1");
  });

  it("メタデータと指定した列の範囲だけを取得し、バイト列から読んだときと同じ値になる", async () => {
    const requests: RecordedRequest[] = [];
    const recordingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      requests.push({
        method: init?.method ?? "GET",
        range: new Headers(init?.headers).get("Range"),
        status: response.status,
        bytes: Number(response.headers.get("Content-Length")),
      });
      return response;
    };

    const parquet = unwrap(await openParquetUrl(url, { fetch: recordingFetch }));
    expect(parquet.numRows).toBe(ROWS);
    const { columns } = unwrap(await readParquetColumns(parquet, ["b"]));
    expect(columns.get("b")).toEqual(expected);

    const gets = requests.filter((r) => r.method === "GET");
    // 大きさは HEAD ではなく、先頭の2バイトの Range リクエストで知る
    expect(requests.some((r) => r.method === "HEAD")).toBe(false);
    expect(requests[0]).toMatchObject({ method: "GET", range: "bytes=0-1", status: 206, bytes: 2 });
    expect(gets.length).toBeGreaterThan(1);
    for (const get of gets) {
      expect(get.range).toMatch(/^bytes=\d+-\d+$/);
      expect(get.status).toBe(206);
    }
    // 末尾の取得（既定で 512KB）と b 列の範囲だけで済み、ファイル全体は読まない
    const fetched = gets.reduce((sum, r) => sum + r.bytes, 0);
    expect(fetched).toBeLessThan(fileSize * 0.6);
  });

  it("HEAD の Content-Length が圧縮後の大きさでも、元のファイルとして読める", async () => {
    // GitHub Pages は gzip で返せるとき、HEAD に圧縮後の大きさを返す。HEAD に頼っていないことを確かめる
    const pagesLikeFetch: typeof globalThis.fetch = (input, init) =>
      init?.method === "HEAD"
        ? Promise.resolve(
            new Response(null, {
              headers: { "Content-Encoding": "gzip", "Content-Length": String(fileSize - 100) },
            }),
          )
        : fetch(input, init);
    const parquet = unwrap(await openParquetUrl(url, { fetch: pagesLikeFetch }));
    const { columns } = unwrap(await readParquetColumns(parquet, ["b"]));
    expect(columns.get("b")).toEqual(expected);
  });

  it("Range リクエストに 206 が返らなければ、全体を読まずに range-not-supported になる", async () => {
    const result = await openParquetUrl(url, {
      fetch: () => Promise.resolve(new Response(new Uint8Array(fileSize), { status: 200 })),
    });
    expect(result).toEqual({ ok: false, error: { kind: "range-not-supported", status: 200 } });
  });
});
