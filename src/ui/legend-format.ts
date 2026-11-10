// 凡例の目盛りと、スクリーンリーダーに読ませる階級の範囲（docs/design/ui.md の「凡例」）。
// 区切りと配色は core の classify から受け取り、ここでは数字の書き方だけを決める。

import type { Classification } from "../core/classify/classify";

/**
 * 凡例の数字の種類。
 * - persons：人数。1万以上で1万の倍数なら「3万」と書く
 * - fraction：比（0.3 が 30%）。最後の目盛りにだけ % を付ける
 * - number：自前データを結合した指標（件数、合計、人口あたりの値）。単位を付けない
 */
export type LegendScale = "persons" | "fraction" | "number";

/** 負の数に付ける記号。ハイフンではなくマイナス記号（U+2212）にする（Figma の凡例と同じ） */
const MINUS = "−";

const integerFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

/** 0 以上の数の書き方。整数は桁区切りか「万」、小数は有効数字 digits 桁 */
const formatMagnitude = (value: number, digits: number): string => {
  if (Number.isInteger(value)) {
    return value >= 10_000 && value % 10_000 === 0
      ? `${integerFormat.format(value / 10_000)}万`
      : integerFormat.format(value);
  }
  return new Intl.NumberFormat("ja-JP", { maximumSignificantDigits: digits }).format(value);
};

/** 比を百分率の数にする。0.3 * 100 のような浮動小数点の誤差を丸める */
const toPercent = (value: number): number => Math.round(value * 100 * 1e6) / 1e6;

/**
 * 凡例の数字1つ。単位の記号は付けない。
 * signed なら正の数に + を付ける（減少と増加の両方を区切りに持つ指標）。
 */
export const formatLegendValue = (
  value: number,
  scale: LegendScale,
  signed: boolean,
  digits = 3,
): string => {
  const shown = scale === "fraction" ? toPercent(value) : value;
  const magnitude = formatMagnitude(Math.abs(shown), digits);
  if (shown < 0) {
    return `${MINUS}${magnitude}`;
  }
  return shown > 0 && signed ? `+${magnitude}` : magnitude;
};

/** 区切りに負の数があれば、正の数に + を付けて減少と増加を見分ける。ホバーのカードの値でも使う */
export const isSigned = (breaks: readonly number[]): boolean => breaks.some((b) => b < 0);

/** 小数の区切りが同じ文字列に丸まらないよう、有効数字を増やしながら書く */
const formatBreaks = (breaks: readonly number[], scale: LegendScale): readonly string[] => {
  const signed = isSigned(breaks);
  for (let digits = 3; digits < 10; digits++) {
    const labels = breaks.map((b) => formatLegendValue(b, scale, signed, digits));
    if (new Set(labels).size === labels.length) {
      return labels;
    }
  }
  return breaks.map((b) => formatLegendValue(b, scale, signed, 10));
};

/** 凡例の目盛り。position は色の帯の左端を 0、右端を 1 とした位置 */
export type LegendTick = { readonly position: number; readonly label: string };

/**
 * 色の帯の境目に置く目盛り。比の指標は最後の目盛りにだけ % を付ける（Figma の凡例と同じ）。
 * 区切りがなければ（自前データの値がすべて 0 など）空の配列を返す。
 */
export const legendTicks = (
  { breaks, colors }: Classification,
  scale: LegendScale,
): readonly LegendTick[] => {
  const labels = formatBreaks(breaks, scale);
  return labels.map((label, i) => ({
    position: (i + 1) / colors.length,
    label: scale === "fraction" && i === labels.length - 1 ? `${label}%` : label,
  }));
};

/** 範囲の文での単位と、「未満」「以上」の前の空白。「10 人未満」「30% 未満」のように書く */
export const RANGE_UNIT: Readonly<
  Record<LegendScale, { readonly unit: string; readonly gap: string }>
> = {
  persons: { unit: " 人", gap: "" },
  fraction: { unit: "%", gap: " " },
  number: { unit: "", gap: " " },
};

/**
 * 階級ごとの範囲の文。低い階級から並べ、スクリーンリーダー向けの一覧に使う。
 * 最初の階級は「未満」、最後の階級は「以上」、その間は「〜」で書く。
 */
export const legendRangeTexts = (
  { breaks, colors }: Classification,
  scale: LegendScale,
): readonly string[] => {
  const labels = formatBreaks(breaks, scale);
  const { unit, gap } = RANGE_UNIT[scale];
  const first = labels[0];
  const last = labels[labels.length - 1];
  if (first === undefined || last === undefined) {
    return colors.map(() => "すべての値");
  }
  return colors.map((_, k) => {
    if (k === 0) {
      return `${first}${unit}${gap}未満`;
    }
    if (k === labels.length) {
      return `${last}${unit}${gap}以上`;
    }
    return `${labels[k - 1]}〜${labels[k]}${unit}`;
  });
};

/** 値なしの階級の文。値がないメッシュと、年齢別の値が秘匿されたメッシュは透明に塗る（D7） */
export const NO_VALUE_TEXT = "値なし、または秘匿";
