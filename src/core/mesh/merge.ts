// 複数の都道府県のメッシュのファイル（mesh_pref/<コード>.parquet）を、1つのメッシュの並びに合わせる。
// 県境のメッシュは、またぐ都道府県のファイルのそれぞれに、同じ値の行を持つ（docs/design/base-data.md）。
// 合わせた並びでは1行にし、メッシュコードの昇順に並べる（全国のファイルと同じ順）。

import type { ColumnArray } from "../data/schema";
import { isNumericColumn, type NumericColumn } from "../indicators/columns";
import { err, ok, type Result } from "../result";

export type MeshMerge = {
  /** 合わせたメッシュコード。重複がなく、昇順 */
  readonly codes: Uint32Array;
  /** rows[k][i] は、k 番目のファイルの i 行目が、合わせた並びの何行目か */
  readonly rows: readonly Uint32Array[];
};

/** ファイルごとの mesh 列から、合わせた並びと、各ファイルの行の行き先を作る */
export const mergeMeshCodes = (parts: readonly Uint32Array[]): MeshMerge => {
  const unique = new Set<number>();
  for (const part of parts) {
    for (const code of part) {
      unique.add(code);
    }
  }
  const codes = Uint32Array.from(unique).sort();
  const position = new Map<number, number>();
  codes.forEach((code, i) => {
    position.set(code, i);
  });
  return {
    codes,
    rows: parts.map((part) => part.map((code) => position.get(code) ?? 0)),
  };
};

export type MergeColumnError =
  /** ファイルの数か、行の数が、mesh 列から作った並びと合わない */
  | { readonly kind: "shape-mismatch"; readonly part: number | null }
  /** 数値の列でないか、ファイルによって型が違う */
  | { readonly kind: "type-mismatch"; readonly part: number };

const emptyLike = (column: NumericColumn, length: number): NumericColumn => {
  if (column instanceof Float32Array) {
    return new Float32Array(length);
  }
  if (column instanceof Float64Array) {
    return new Float64Array(length);
  }
  return column instanceof Uint32Array ? new Uint32Array(length) : new Uint8Array(length);
};

/**
 * ファイルごとに読んだ同じ名前の列を、合わせた並びの1つの列にする。
 * 県境のメッシュの値はどのファイルでも同じなので、あとのファイルの値で上書きしてよい
 */
export const mergeColumn = (
  parts: readonly ColumnArray[],
  merge: MeshMerge,
): Result<NumericColumn, MergeColumnError> => {
  const [first] = parts;
  if (first === undefined || parts.length !== merge.rows.length) {
    return err({ kind: "shape-mismatch", part: null });
  }
  if (!isNumericColumn(first)) {
    return err({ kind: "type-mismatch", part: 0 });
  }
  const out = emptyLike(first, merge.codes.length);
  for (const [k, part] of parts.entries()) {
    const rows = merge.rows[k];
    if (!isNumericColumn(part) || part.constructor !== first.constructor) {
      return err({ kind: "type-mismatch", part: k });
    }
    if (rows === undefined || part.length !== rows.length) {
      return err({ kind: "shape-mismatch", part: k });
    }
    for (let i = 0; i < part.length; i++) {
      out[rows[i] ?? 0] = part[i] ?? 0;
    }
  }
  return ok(out);
};
