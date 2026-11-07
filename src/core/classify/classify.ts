// 階級区分。値を、固定した区切りで階級の番号に変える（docs/design/map-and-hosting.md の「表示の切り替え」）。

import type { Rgba } from "./color";

/**
 * 階級区分と配色。breaks は昇順で、colors より1つ少ない。
 * 階級 k は breaks[k-1] 以上 breaks[k] 未満の値で、最初の階級は breaks[0] 未満、最後の階級は breaks の最後以上。
 */
export type Classification = {
  readonly breaks: readonly number[];
  readonly colors: readonly Rgba[];
};

/** 値なしを表す階級の番号 */
export const NO_CLASS = -1;

/** 値の階級の番号。NaN は NO_CLASS */
export const classIndex = (value: number, breaks: readonly number[]): number => {
  if (Number.isNaN(value)) {
    return NO_CLASS;
  }
  let k = 0;
  while (k < breaks.length && value >= (breaks[k] ?? Number.POSITIVE_INFINITY)) {
    k++;
  }
  return k;
};

/** 区切りが昇順に並び、色の数が区切りより1つ多いか。表を足したときの検査に使う */
export const isWellFormed = ({ breaks, colors }: Classification): boolean =>
  colors.length === breaks.length + 1 &&
  breaks.every((b, i) => Number.isFinite(b) && (i === 0 || (breaks[i - 1] ?? b) < b));

/** 凡例の1段。from 以上 to 未満。最初の段の from と最後の段の to は null */
export type LegendEntry = {
  readonly color: Rgba;
  readonly from: number | null;
  readonly to: number | null;
};

/** 凡例の段を、低い階級から順に並べる。値なし（透明）の段は含めない */
export const legendEntries = ({ breaks, colors }: Classification): readonly LegendEntry[] =>
  colors.map((color, k) => ({
    color,
    from: k === 0 ? null : (breaks[k - 1] ?? null),
    to: k === breaks.length ? null : (breaks[k] ?? null),
  }));
