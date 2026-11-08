// hyparquet で Parquet の必要な列だけを読み、core に渡す型付き配列（ColumnArray）に変換する。
// URL から読むときは、末尾のメタデータと、指定した列の範囲だけを Range リクエストで取りにいく
// （docs/design/map-and-hosting.md の「データの配信」）。

import {
  type AsyncBuffer,
  asyncBufferFromUrl,
  type ColumnData,
  type FileMetaData,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type SchemaElement,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { ColumnArray } from "../core/data/schema";
import { err, ok, type Result } from "../core/result";

/**
 * Parquet の列の型を、DuckDB の型の名前に読み替えたもの。
 * ColumnArray に変換できる型だけを名前で表し、それ以外は "unsupported" にする。
 */
export type ParquetColumnType =
  | "BOOLEAN"
  | "INTEGER"
  | "UINTEGER"
  | "BIGINT"
  | "FLOAT"
  | "DOUBLE"
  | "VARCHAR"
  | "unsupported";

export type ParquetColumnInfo = {
  readonly name: string;
  readonly type: ParquetColumnType;
  /** Parquet の物理型（INT32、BYTE_ARRAY など）。type が "unsupported" のときの手がかりにする */
  readonly physicalType: string;
  /** NULL を持ちうる列か（Parquet の repetition_type が REQUIRED でない） */
  readonly nullable: boolean;
};

/** メタデータを読み終えた Parquet ファイル。列を何度読んでも、メタデータは読み直さない */
export type ParquetFile = {
  readonly numRows: number;
  readonly columns: readonly ParquetColumnInfo[];
  readonly file: AsyncBuffer;
  readonly metadata: FileMetaData;
};

export type ParquetError =
  /** ファイルの大きさを知るための通信に失敗した */
  | { readonly kind: "fetch-failed"; readonly message: string }
  /** サーバーが Range リクエストに 206 を返さなかった。全体を読むことになるので、読まずに止める */
  | { readonly kind: "range-not-supported"; readonly status: number }
  /** メタデータを読めなかった（Parquet でない、壊れている、末尾の取得に失敗した） */
  | { readonly kind: "invalid-file"; readonly message: string }
  | { readonly kind: "column-not-found"; readonly column: string }
  | { readonly kind: "unsupported-type"; readonly column: string; readonly physicalType: string }
  /** NULL を表せない型（UINTEGER、BOOLEAN、VARCHAR）の列に NULL があった */
  | {
      readonly kind: "null-not-representable";
      readonly column: string;
      readonly type: ParquetColumnType;
      readonly row: number;
    }
  /** 列のデータの取得や展開に失敗した */
  | { readonly kind: "read-failed"; readonly message: string };

export type ParquetColumns = {
  readonly numRows: number;
  /** 列の名前から値への対応。指定した列だけを持つ */
  readonly columns: ReadonlyMap<string, ColumnArray>;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const columnTypeOf = (element: SchemaElement): ParquetColumnType => {
  if ((element.num_children ?? 0) > 0) return "unsupported";
  const { type, converted_type: ctype, logical_type: ltype } = element;
  switch (type) {
    case "BOOLEAN":
      return "BOOLEAN";
    case "INT32": {
      if (ltype?.type === "INTEGER") {
        if (ltype.bitWidth !== 32) return "unsupported";
        return ltype.isSigned ? "INTEGER" : "UINTEGER";
      }
      if (ctype === "UINT_32") return "UINTEGER";
      return ctype === undefined || ctype === "INT_32" ? "INTEGER" : "unsupported";
    }
    case "INT64": {
      if (ltype?.type === "INTEGER") {
        return ltype.bitWidth === 64 && ltype.isSigned ? "BIGINT" : "unsupported";
      }
      return ctype === undefined || ctype === "INT_64" ? "BIGINT" : "unsupported";
    }
    case "FLOAT":
      return ltype === undefined ? "FLOAT" : "unsupported";
    case "DOUBLE":
      return ltype === undefined ? "DOUBLE" : "unsupported";
    case "BYTE_ARRAY":
      return ctype === "UTF8" || ltype?.type === "STRING" ? "VARCHAR" : "unsupported";
    default:
      return "unsupported";
  }
};

const columnsOf = (metadata: FileMetaData): readonly ParquetColumnInfo[] =>
  parquetSchema(metadata).children.map(({ element }) => ({
    name: element.name,
    type: columnTypeOf(element),
    physicalType: element.type ?? "GROUP",
    nullable: element.repetition_type !== "REQUIRED",
  }));

const openAsyncBuffer = async (file: AsyncBuffer): Promise<Result<ParquetFile, ParquetError>> => {
  try {
    const metadata = await parquetMetadataAsync(file);
    return ok({ numRows: Number(metadata.num_rows), columns: columnsOf(metadata), file, metadata });
  } catch (e) {
    return err({ kind: "invalid-file", message: messageOf(e) });
  }
};

/**
 * 先頭の2バイトを Range リクエストで取得し、Content-Range からファイルの大きさを知る。
 * 1バイト（bytes=0-0）にしないのは、Vite の開発サーバーの静的ファイルの配信（sirv）が
 * 終わりの位置の 0 を省略とみなし、ファイル全体を返すからである。
 *
 * HEAD リクエストは使わない。GitHub Pages は Accept-Encoding に gzip があると gzip で返し、
 * HEAD の Content-Length も圧縮後の大きさになるからである（2026-11-09 に本番で確かめた）。
 * ブラウザは Range を付けた要求に Accept-Encoding: identity を付けるので（Fetch の仕様）、
 * Range リクエストの応答は圧縮されず、Content-Range の全体の大きさも元のファイルのものになる。
 */
const byteLengthOf = async (
  url: string,
  fetchFn: typeof globalThis.fetch,
): Promise<Result<number, ParquetError>> => {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Range: "bytes=0-1" } });
  } catch (e) {
    return err({ kind: "fetch-failed", message: messageOf(e) });
  }
  await response.body?.cancel();
  if (!response.ok) return err({ kind: "fetch-failed", message: `HTTP ${response.status}` });
  if (response.status !== 206) return err({ kind: "range-not-supported", status: response.status });
  const total = /\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "")?.[1];
  return total === undefined
    ? err({ kind: "fetch-failed", message: "Content-Range から大きさを読めない" })
    : ok(Number(total));
};

/**
 * URL の Parquet のメタデータを読む。
 * 先頭の2バイトの Range リクエストで大きさを知り、末尾のメタデータだけを Range リクエストで取得する。
 * fetch を渡すと、通信にそれを使う（テストで要求を記録するためなど）。
 */
export const openParquetUrl = async (
  url: string,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): Promise<Result<ParquetFile, ParquetError>> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const byteLength = await byteLengthOf(url, fetchFn);
  if (!byteLength.ok) return byteLength;
  let file: AsyncBuffer;
  try {
    file = await asyncBufferFromUrl({ url, byteLength: byteLength.value, fetch: fetchFn });
  } catch (e) {
    return err({ kind: "fetch-failed", message: messageOf(e) });
  }
  return openAsyncBuffer(file);
};

/** メモリ上のバイト列の Parquet のメタデータを読む */
export const openParquetBuffer = (
  buffer: ArrayBuffer,
): Promise<Result<ParquetFile, ParquetError>> =>
  openAsyncBuffer({
    byteLength: buffer.byteLength,
    slice: (start, end) => buffer.slice(start, end),
  });

type ConvertResult = Result<ColumnArray, ParquetError>;

const isNull = (value: unknown): boolean => value === null || value === undefined;

/** 読んだ断片（行グループやページごと）を、行の位置に合わせて1つの型付き配列に詰める */
const assemble = (
  info: ParquetColumnInfo,
  numRows: number,
  chunks: readonly ColumnData[],
): ConvertResult => {
  const { name, type } = info;
  const nullError = (row: number): ConvertResult =>
    err({ kind: "null-not-representable", column: name, type, row });

  switch (type) {
    case "UINTEGER":
    case "BOOLEAN": {
      const out = type === "UINTEGER" ? new Uint32Array(numRows) : new Uint8Array(numRows);
      for (const { columnData, rowStart } of chunks) {
        for (let i = 0; i < columnData.length; i++) {
          const v: unknown = columnData[i];
          if (isNull(v)) return nullError(rowStart + i);
          // UINT32 は Int32Array で届くことがあるので、符号なしに読み替える
          out[rowStart + i] = type === "BOOLEAN" ? (v ? 1 : 0) : Number(v) >>> 0;
        }
      }
      return ok(out);
    }
    case "FLOAT":
    case "INTEGER":
    case "BIGINT":
    case "DOUBLE": {
      const out = type === "FLOAT" ? new Float32Array(numRows) : new Float64Array(numRows);
      for (const { columnData, rowStart } of chunks) {
        for (let i = 0; i < columnData.length; i++) {
          const v: unknown = columnData[i];
          out[rowStart + i] = isNull(v) ? Number.NaN : Number(v);
        }
      }
      return ok(out);
    }
    case "VARCHAR": {
      const out = new Array<string>(numRows);
      for (const { columnData, rowStart } of chunks) {
        for (let i = 0; i < columnData.length; i++) {
          const v: unknown = columnData[i];
          if (typeof v !== "string") return nullError(rowStart + i);
          out[rowStart + i] = v;
        }
      }
      return ok(out);
    }
    case "unsupported":
      return err({ kind: "unsupported-type", column: name, physicalType: info.physicalType });
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
};

/**
 * 指定した列だけを読み、ColumnArray に変換する。
 * 列の型と ColumnArray の対応は schema.ts の ColumnArray の説明に従う。DOUBLE は Float64Array にする。
 */
export const readParquetColumns = async (
  parquet: ParquetFile,
  names: readonly string[],
): Promise<Result<ParquetColumns, ParquetError>> => {
  const infos: ParquetColumnInfo[] = [];
  for (const name of names) {
    const info = parquet.columns.find((c) => c.name === name);
    if (info === undefined) return err({ kind: "column-not-found", column: name });
    if (info.type === "unsupported") {
      return err({ kind: "unsupported-type", column: name, physicalType: info.physicalType });
    }
    infos.push(info);
  }

  const chunks = new Map<string, ColumnData[]>(infos.map((info) => [info.name, []]));
  try {
    await parquetRead({
      file: parquet.file,
      metadata: parquet.metadata,
      columns: infos.map((info) => info.name),
      compressors,
      onChunk: (chunk) => chunks.get(chunk.columnName)?.push(chunk),
    });
  } catch (e) {
    return err({ kind: "read-failed", message: messageOf(e) });
  }

  const columns = new Map<string, ColumnArray>();
  for (const info of infos) {
    const assembled = assemble(info, parquet.numRows, chunks.get(info.name) ?? []);
    if (!assembled.ok) return assembled;
    columns.set(info.name, assembled.value);
  }
  return ok({ numRows: parquet.numRows, columns });
};
