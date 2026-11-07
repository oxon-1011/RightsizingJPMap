// 自前データを結合先の単位ごとに集計する（docs/design/user-data.md の「結合後の指標」）。
// 件数は行や点の数、合計は数値の列の合計。人口あたりの値は join/per-population.ts で求める。

import { latLonToMeshCode } from "../mesh/mesh-code";

/** 数値の列。名前から、行の順に並んだ値への対応。NULL は NaN */
export type NumericColumns = Readonly<Record<string, ArrayLike<number>>>;

/**
 * 単位ごとの集計。keys の順に counts と sums の値が並ぶ。
 * 合計は NaN（NULL）を除いて足し、その単位の値がすべて NaN なら NaN にする（SQL の SUM と同じ）。
 */
export type Aggregate<K> = {
  readonly keys: K;
  readonly counts: Float64Array;
  readonly sums: Readonly<Record<string, Float64Array>>;
};

/** メッシュごとの集計。keys は昇順のメッシュコード */
export type MeshAggregate = Aggregate<Uint32Array>;

/** 行政区域ごとの集計。keys は昇順の団体コード。skipped はどの行政区域にも入らなかった行の数 */
export type CodeAggregate = Aggregate<readonly string[]> & { readonly skipped: number };

const assertSameLength = (length: number, numeric: NumericColumns): void => {
  for (const [name, values] of Object.entries(numeric)) {
    if (values.length !== length) {
      throw new Error(`列 ${name} の長さが行の数と違う: ${values.length} と ${length}`);
    }
  }
};

/**
 * 行ごとの単位（グループの番号）から、件数と合計を作る。
 * groupOf[i] は i 行めのグループの番号で、-1 の行は数えない。order はグループを並べる順。
 */
const sumByGroup = (
  groupOf: Int32Array,
  groupCount: number,
  order: readonly number[],
  numeric: NumericColumns,
): Pick<Aggregate<unknown>, "counts" | "sums"> => {
  const counts = new Float64Array(groupCount);
  for (const g of groupOf) {
    if (g >= 0) {
      counts[g] = (counts[g] ?? 0) + 1;
    }
  }
  const sums: Record<string, Float64Array> = {};
  for (const [name, values] of Object.entries(numeric)) {
    const total = new Float64Array(groupCount);
    const seen = new Uint8Array(groupCount);
    for (let i = 0; i < groupOf.length; i++) {
      const g = groupOf[i] ?? -1;
      const v = values[i] ?? Number.NaN;
      if (g >= 0 && !Number.isNaN(v)) {
        total[g] = (total[g] ?? 0) + v;
        seen[g] = 1;
      }
    }
    sums[name] = Float64Array.from(order, (g) => (seen[g] === 1 ? (total[g] ?? 0) : Number.NaN));
  }
  return { counts: Float64Array.from(order, (g) => counts[g] ?? 0), sums };
};

/** mesh 列で結合する表を、メッシュごとに集計する */
export const aggregateByMesh = (
  meshes: ArrayLike<number>,
  numeric: NumericColumns,
): MeshAggregate => {
  assertSameLength(meshes.length, numeric);
  const groups = new Map<number, number>();
  const groupOf = new Int32Array(meshes.length);
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i] ?? Number.NaN;
    let g = groups.get(mesh);
    if (g === undefined) {
      g = groups.size;
      groups.set(mesh, g);
    }
    groupOf[i] = g;
  }
  const sorted = [...groups].sort(([a], [b]) => a - b);
  const { counts, sums } = sumByGroup(
    groupOf,
    groups.size,
    sorted.map(([, g]) => g),
    numeric,
  );
  return { keys: Uint32Array.from(sorted, ([mesh]) => mesh), counts, sums };
};

/** 点（検査済みの緯度経度）を、入るメッシュごとに集計する */
export const aggregatePointsByMesh = (
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  numeric: NumericColumns,
): MeshAggregate => {
  if (lat.length !== lon.length) {
    throw new Error(`lat と lon の長さが違う: ${lat.length} と ${lon.length}`);
  }
  const meshes = Float64Array.from({ length: lat.length }, (_, i) =>
    latLonToMeshCode({ lat: lat[i] ?? Number.NaN, lon: lon[i] ?? Number.NaN }),
  );
  return aggregateByMesh(meshes, numeric);
};

/**
 * 団体コードごとに集計する。code 列で結合する表と、点を行政区域に割り当てた結果の両方に使う。
 * null の行（どの行政区域にも入らなかった点）は数えず、skipped に数を入れる。
 */
export const aggregateByCode = (
  codes: readonly (string | null)[],
  numeric: NumericColumns,
): CodeAggregate => {
  assertSameLength(codes.length, numeric);
  const groups = new Map<string, number>();
  const groupOf = new Int32Array(codes.length);
  let skipped = 0;
  codes.forEach((code, i) => {
    if (code === null) {
      groupOf[i] = -1;
      skipped++;
      return;
    }
    let g = groups.get(code);
    if (g === undefined) {
      g = groups.size;
      groups.set(code, g);
    }
    groupOf[i] = g;
  });
  const sorted = [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { counts, sums } = sumByGroup(
    groupOf,
    groups.size,
    sorted.map(([, g]) => g),
    numeric,
  );
  return { keys: sorted.map(([code]) => code), counts, sums, skipped };
};

/** 結合した指標の値の種類。件数か、数値の列の合計 */
export type JoinMeasure =
  | { readonly kind: "count" }
  | { readonly kind: "sum"; readonly column: string };

/** 集計から、指標にする値の列を取り出す。合計の列がなければ null */
export const measureValues = <K>(
  aggregate: Aggregate<K>,
  measure: JoinMeasure,
): Float64Array | null => {
  switch (measure.kind) {
    case "count":
      return aggregate.counts;
    case "sum":
      return aggregate.sums[measure.column] ?? null;
    default: {
      const unreachable: never = measure;
      return unreachable;
    }
  }
};
