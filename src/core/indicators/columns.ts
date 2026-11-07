// io から受け取った列（ColumnArray）を、指標の計算の前に検査するための道具。

import type { ColumnArray } from "../data/schema";
import { err, ok, type Result } from "../result";

/** 数値の列。VARCHAR 以外の ColumnArray */
export type NumericColumn = Exclude<ColumnArray, readonly string[]>;

/** 列の名前から列への対応。io が Parquet から読んだ列を詰めて渡す */
export type Columns = Readonly<Record<string, ColumnArray>>;

export type ColumnError =
  | { readonly kind: "missing-column"; readonly column: string }
  | { readonly kind: "not-numeric-column"; readonly column: string }
  | { readonly kind: "not-string-column"; readonly column: string }
  | {
      readonly kind: "length-mismatch";
      readonly column: string;
      readonly expected: number;
      readonly actual: number;
    };

export const isNumericColumn = (column: ColumnArray): column is NumericColumn =>
  column instanceof Float32Array ||
  column instanceof Float64Array ||
  column instanceof Uint32Array ||
  column instanceof Uint8Array;

/** 数値の列を取り出す。length を渡したときは行数も検査する */
export const numericColumn = (
  columns: Columns,
  name: string,
  length: number | null,
): Result<NumericColumn, ColumnError> => {
  const column = columns[name];
  if (column === undefined) {
    return err({ kind: "missing-column", column: name });
  }
  if (!isNumericColumn(column)) {
    return err({ kind: "not-numeric-column", column: name });
  }
  if (length !== null && column.length !== length) {
    return err({ kind: "length-mismatch", column: name, expected: length, actual: column.length });
  }
  return ok(column);
};

/** 文字列の列を取り出す。length を渡したときは行数も検査する */
export const stringColumn = (
  columns: Columns,
  name: string,
  length: number | null,
): Result<readonly string[], ColumnError> => {
  const column = columns[name];
  if (column === undefined) {
    return err({ kind: "missing-column", column: name });
  }
  if (isNumericColumn(column)) {
    return err({ kind: "not-string-column", column: name });
  }
  if (length !== null && column.length !== length) {
    return err({ kind: "length-mismatch", column: name, expected: length, actual: column.length });
  }
  return ok(column);
};

/**
 * 比の値。分母が 0 か NaN、分子が NaN なら NaN にする。
 * 増減率は ratio(current, base) - 1 で求める。
 */
export const safeRatio = (numerator: number, denominator: number): number =>
  denominator === 0 || Number.isNaN(denominator) || Number.isNaN(numerator)
    ? Number.NaN
    : numerator / denominator;
