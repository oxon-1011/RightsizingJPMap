// メッシュの指標の計算。mesh_indicators.parquet の列から、メッシュの順に並んだ値を作る。
// 値なしは NaN にする。秘匿の扱いは D7（docs/design/base-data.md の「地図での扱い」）に従う。

import { err, ok, type Result } from "../result";
import {
  type ColumnError,
  type Columns,
  type NumericColumn,
  numericColumn,
  safeRatio,
} from "./columns";
import { type IndicatorId, meshIndicatorColumns } from "./definitions";

export type MeshIndicatorError =
  | { readonly kind: "unavailable-year"; readonly id: IndicatorId; readonly year: number }
  | ColumnError;

/** ある年のある人数。masked は秘匿の列で、総数のときは null */
type Source = { readonly values: NumericColumn; readonly masked: NumericColumn | null };

const readSource = (
  columns: Columns,
  names: { readonly value: string; readonly masked: string | null },
  meshCount: number,
): Result<Source, ColumnError> => {
  const values = numericColumn(columns, names.value, meshCount);
  if (!values.ok) {
    return values;
  }
  if (names.masked === null) {
    return ok({ values: values.value, masked: null });
  }
  const masked = numericColumn(columns, names.masked, meshCount);
  return masked.ok ? ok({ values: values.value, masked: masked.value }) : masked;
};

/**
 * i 番目のメッシュの値。秘匿の列で 0 以外（NaN を含む）なら NaN にする。
 * 秘匿の列が NaN になるのは io の誤りなので、値なしとして扱う。
 */
const valueAt = (source: Source, i: number): number => {
  const masked = source.masked === null ? 0 : (source.masked[i] ?? Number.NaN);
  return masked === 0 ? (source.values[i] ?? Number.NaN) : Number.NaN;
};

/**
 * 指標の値を、メッシュの順に並べた Float32Array で返す。値なし（秘匿、分母 0、NULL）は NaN。
 * meshCount は mesh 列の長さで、どの列もこの長さでなければならない。
 */
export const computeMeshIndicator = (
  id: IndicatorId,
  year: number,
  columns: Columns,
  meshCount: number,
): Result<Float32Array, MeshIndicatorError> => {
  const plan = meshIndicatorColumns(id, year);
  if (plan === null) {
    return err({ kind: "unavailable-year", id, year });
  }
  const out = new Float32Array(meshCount);
  switch (plan.kind) {
    case "count": {
      const source = readSource(columns, plan.value, meshCount);
      if (!source.ok) {
        return source;
      }
      for (let i = 0; i < meshCount; i++) {
        out[i] = valueAt(source.value, i);
      }
      return ok(out);
    }
    case "ratio": {
      const numerator = readSource(columns, plan.numerator, meshCount);
      if (!numerator.ok) {
        return numerator;
      }
      const denominator = readSource(columns, plan.denominator, meshCount);
      if (!denominator.ok) {
        return denominator;
      }
      for (let i = 0; i < meshCount; i++) {
        out[i] = safeRatio(valueAt(numerator.value, i), valueAt(denominator.value, i));
      }
      return ok(out);
    }
    case "change": {
      const current = readSource(columns, plan.current, meshCount);
      if (!current.ok) {
        return current;
      }
      const base = readSource(columns, plan.base, meshCount);
      if (!base.ok) {
        return base;
      }
      for (let i = 0; i < meshCount; i++) {
        out[i] = safeRatio(valueAt(current.value, i), valueAt(base.value, i)) - 1;
      }
      return ok(out);
    }
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
};
