// 人口あたりの値（docs/design/user-data.md の「結合後の指標」）。
// 件数か合計を、選んだ年のベースの人数の指標で割る。分母が値なし（NaN、秘匿）か 0 なら NaN にする。

import { safeRatio } from "../indicators/columns";

/** メッシュコードから、mesh_indicators.parquet の行の番号への対応 */
export type MeshLookup = ReadonlyMap<number, number>;

/** ベースデータの mesh 列から、メッシュコードで行を引く対応を作る。読み込み時に一度だけ作る */
export const indexMeshes = (meshes: ArrayLike<number>): MeshLookup => {
  const lookup = new Map<number, number>();
  for (let i = 0; i < meshes.length; i++) {
    lookup.set(meshes[i] ?? Number.NaN, i);
  }
  return lookup;
};

/**
 * メッシュごとの人口あたりの値。per は「何人あたり」（1000 なら 1,000 人あたり）。
 * meshes と numerators は集計の順（join/aggregate.ts の MeshAggregate）。
 * baseValues はベースの人数の指標の値で、lookup の行の順。ベースデータにないメッシュは NaN。
 */
export const perPopulationByMesh = (args: {
  readonly meshes: ArrayLike<number>;
  readonly numerators: ArrayLike<number>;
  readonly lookup: MeshLookup;
  readonly baseValues: ArrayLike<number>;
  readonly per: number;
}): Float32Array => {
  const { meshes, numerators, lookup, baseValues, per } = args;
  if (meshes.length !== numerators.length) {
    throw new Error("メッシュの数と分子の数が違う");
  }
  const out = new Float32Array(meshes.length);
  for (let i = 0; i < meshes.length; i++) {
    const row = lookup.get(meshes[i] ?? Number.NaN);
    const denominator = row === undefined ? Number.NaN : (baseValues[row] ?? Number.NaN);
    out[i] = safeRatio(numerators[i] ?? Number.NaN, denominator) * per;
  }
  return out;
};

/**
 * 行政区域ごとの人口あたりの値。baseValues は indicators/municipal.ts の computeMunicipalIndicator の戻り値。
 * ベースの値がない団体コードは NaN。
 */
export const perPopulationByCode = (args: {
  readonly codes: readonly string[];
  readonly numerators: ArrayLike<number>;
  readonly baseValues: ReadonlyMap<string, number>;
  readonly per: number;
}): ReadonlyMap<string, number> => {
  const { codes, numerators, baseValues, per } = args;
  if (codes.length !== numerators.length) {
    throw new Error("団体コードの数と分子の数が違う");
  }
  const out = new Map<string, number>();
  codes.forEach((code, i) => {
    out.set(code, safeRatio(numerators[i] ?? Number.NaN, baseValues.get(code) ?? Number.NaN) * per);
  });
  return out;
};

/**
 * 団体コードごとの値を、地図で塗るすべての地域に広げる。値のない地域には fill を入れる。
 * 点の件数では 0 を、表の値では NaN（透明）を入れる。前の指標の色が残らないようにするために使う。
 */
export const completeCodeValues = (
  codes: readonly string[],
  values: ArrayLike<number>,
  allCodes: ReadonlySet<string>,
  fill: number,
): ReadonlyMap<string, number> => {
  const out = new Map<string, number>();
  for (const code of allCodes) {
    out.set(code, fill);
  }
  codes.forEach((code, i) => {
    out.set(code, values[i] ?? Number.NaN);
  });
  return out;
};
