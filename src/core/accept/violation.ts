// 受け入れ条件を満たさなかった行や地物の記録と、表示用の番号への変換（D12）。
// 番号の数え方はトラック D の利用者向けの文書と合わせている。

/** 先頭から示す、条件を満たさなかった行や地物の数 */
export const MAX_REPORTED_POSITIONS = 5;

/**
 * ある条件を満たさなかった行や地物。
 * positions は0始まりのデータの行の番号か地物の番号で、先頭から MAX_REPORTED_POSITIONS 件まで。
 * count は満たさなかった行や地物の総数。
 */
export type Violation<C extends string> = {
  readonly condition: C;
  readonly positions: readonly number[];
  readonly count: number;
};

/** 満たさなかった位置を集める。先頭から MAX_REPORTED_POSITIONS 件だけを残し、総数を数える */
export const violationCollector = <C extends string>(condition: C) => {
  const positions: number[] = [];
  let count = 0;
  return {
    add: (position: number): void => {
      if (positions.length < MAX_REPORTED_POSITIONS) {
        positions.push(position);
      }
      count++;
    },
    result: (): Violation<C> | null => (count === 0 ? null : { condition, positions, count }),
  };
};

export type SourceFormat = "csv" | "parquet" | "geojson";

/**
 * 0始まりの位置を、利用者に示す番号にする。
 * CSV は列名の行を1行目とした行番号、Parquet は1始まりの行の番号、GeoJSON は1始まりの地物の番号。
 */
export const displayPosition = (format: SourceFormat, position: number): number => {
  switch (format) {
    case "csv":
      return position + 2;
    case "parquet":
    case "geojson":
      return position + 1;
    default: {
      const unreachable: never = format;
      return unreachable;
    }
  }
};
