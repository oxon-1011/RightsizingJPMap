// 点を行政区域に割り当てる処理のうち、core が持つ部分（docs/design/user-data.md の「点から行政区域を求める」）。
// 割り当ての判定は io が DuckDB の spatial 拡張で行う。core は、読み込む都道府県の選択と、受け取る結果の型を持つ。

import type { AdminGeomIndex, BBox } from "../data/schema";
import { err, ok, type Result } from "../result";

/**
 * 点を行政区域に割り当てた結果。codes[i] は i 番目の点が入る行政区域の5桁の団体コードで、
 * どのポリゴンにも入らなかった点（海の上、簡略化した境界の外）は null。
 * io はこの型で返し、集計は join/aggregate.ts の aggregateByCode で行う。
 */
export type PointAdminAssignment = { readonly codes: readonly (string | null)[] };

const contains = ([west, south, east, north]: BBox, lat: number, lon: number): boolean =>
  lon >= west && lon <= east && lat >= south && lat <= north;

/**
 * 点を1つでも範囲に含む都道府県の2桁のコードを、昇順に並べて返す。
 * io は、この都道府県の admin_geom/<コード>.parquet だけを読んで判定する。範囲の境界上の点も含める。
 */
export const prefecturesForPoints = (
  index: AdminGeomIndex,
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
): readonly string[] => {
  if (lat.length !== lon.length) {
    throw new Error(`lat と lon の長さが違う: ${lat.length} と ${lon.length}`);
  }
  const remaining = new Map(Object.entries(index));
  const found: string[] = [];
  for (let i = 0; i < lat.length && remaining.size > 0; i++) {
    const y = lat[i] ?? Number.NaN;
    const x = lon[i] ?? Number.NaN;
    for (const [code, bbox] of remaining) {
      if (contains(bbox, y, x)) {
        found.push(code);
        remaining.delete(code);
      }
    }
  }
  return found.sort();
};

export type AdminGeomIndexError = { readonly kind: "invalid"; readonly key: string | null };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBBox = (value: unknown): BBox | null => {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const [west, south, east, north]: readonly unknown[] = value;
  return typeof west === "number" &&
    typeof south === "number" &&
    typeof east === "number" &&
    typeof north === "number" &&
    [west, south, east, north].every(Number.isFinite) &&
    west <= east &&
    south <= north
    ? [west, south, east, north]
    : null;
};

/** JSON.parse した admin_geom/index.json を検査する。キーは2桁の都道府県コード */
export const parseAdminGeomIndex = (
  input: unknown,
): Result<AdminGeomIndex, AdminGeomIndexError> => {
  if (!isRecord(input)) {
    return err({ kind: "invalid", key: null });
  }
  const index: Record<string, BBox> = {};
  for (const [key, value] of Object.entries(input)) {
    const bbox = parseBBox(value);
    if (!/^\d{2}$/.test(key) || bbox === null) {
      return err({ kind: "invalid", key });
    }
    index[key] = bbox;
  }
  return ok(index);
};
