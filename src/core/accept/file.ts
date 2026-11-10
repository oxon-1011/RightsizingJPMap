// 取り込むファイルの形式の判定と、大きさの警告（docs/design/user-data.md の「取り込みの流れ」）。

import { err, ok, type Result } from "../result";
import type { GeoJsonRejection } from "./geojson";
import type { TableFormat, TableRejection } from "./table";
import type { SourceFormat } from "./violation";

/** 拡張子（小文字）から形式への対応。.json も GeoJSON として読み、中身は checkGeoJson で検査する */
const EXTENSIONS: Readonly<Record<string, SourceFormat>> = {
  csv: "csv",
  parquet: "parquet",
  geojson: "geojson",
  json: "geojson",
};

export type FormatRejection = { readonly stage: "format"; readonly extension: string };

/** ファイル名の拡張子から形式を決める。拡張子は大文字と小文字を区別しない */
export const detectFormat = (fileName: string): Result<SourceFormat, FormatRejection> => {
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  // Object.prototype の名前（"constructor" など）を拡張子として引かないよう、自身のキーだけを見る
  const format = Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
  return format === undefined ? err({ stage: "format", extension }) : ok(format);
};

/**
 * 警告を出すファイルの大きさ（バイト）。
 * 点の CSV で、24MB の取り込みに約 6 秒、105MB に約 70 秒かかった（2026-11-10）。待ちが目立つ大きさとして 50MB にする。
 */
export const LARGE_FILE_BYTES = 50 * 1024 * 1024;

export const isLargeFile = (bytes: number): boolean => bytes > LARGE_FILE_BYTES;

/**
 * 取り込めなかった理由。どの段階で拒否したかで分ける。
 * - format：拡張子が受け付ける形式でない（Excel、Shapefile など）
 * - read：io が読み込みに失敗した（UTF-8 でない CSV、JSON として読めないファイルなど）
 * - table、geojson：受け入れ検査で拒否した
 */
export type ImportRejection =
  | FormatRejection
  | { readonly stage: "read"; readonly format: SourceFormat }
  | {
      readonly stage: "table";
      readonly format: TableFormat;
      readonly rejection: TableRejection;
    }
  | { readonly stage: "geojson"; readonly rejection: GeoJsonRejection };
