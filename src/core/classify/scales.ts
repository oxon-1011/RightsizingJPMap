// 指標ごとの階級区分と配色の表。年をまたいで固定する（docs/design/map-and-hosting.md）。
// 高齢化率は Figma のデザインで決めた値（docs/design/ui.md の「デザインで決めたこと」）。
// それ以外は仮の値で、tentative: true を付けている。値はトラック C（デザイン）が決める。

import type { IndicatorId, Unit } from "../indicators/definitions";
import type { Classification } from "./classify";
import { hex, type Rgba } from "./color";

/** DADS の Orange の 100、300、500、700、900、1100。高齢化率の6階級に低い順で使う */
export const DADS_ORANGE_6: readonly Rgba[] = [
  hex("#ffdfca"),
  hex("#ffa66d"),
  hex("#ff7628"),
  hex("#e25100"),
  hex("#ac3e00"),
  hex("#6d2700"),
];

// TODO(トラック C): 人数の指標の配色。仮に ColorBrewer の YlGnBu（6階級）を置いている
const SEQUENTIAL_6: readonly Rgba[] = [
  hex("#ffffcc"),
  hex("#c7e9b4"),
  hex("#7fcdbb"),
  hex("#41b6c4"),
  hex("#2c7fb8"),
  hex("#253494"),
];

// TODO(トラック C): 増減率の2方向の配色。仮に ColorBrewer の RdBu を、減少を青、増加を赤にして置いている
const DECREASE_4: readonly Rgba[] = [
  hex("#2166ac"),
  hex("#4393c3"),
  hex("#92c5de"),
  hex("#d1e5f0"),
];
const INCREASE_4: readonly Rgba[] = [
  hex("#fddbc7"),
  hex("#f4a582"),
  hex("#d6604d"),
  hex("#b2182b"),
];

const fixed = (breaks: readonly number[], colors: readonly Rgba[]): Classification => ({
  breaks,
  colors,
  tentative: false,
});

const tentative = (breaks: readonly number[], colors: readonly Rgba[]): Classification => ({
  breaks,
  colors,
  tentative: true,
});

const sameForBothUnits = (c: Classification): Readonly<Record<Unit, Classification>> => ({
  mesh: c,
  municipality: c,
});

/**
 * 人数の指標の仮の区切り。1km メッシュと市区町村では人数の桁が違うので、単位ごとに持つ。
 * TODO(トラック C): 前処理（トラック A）の生成物の分布を見て決める
 */
const countScale = (
  mesh: readonly number[],
  municipality: readonly number[],
): Readonly<Record<Unit, Classification>> => ({
  mesh: tentative(mesh, SEQUENTIAL_6),
  municipality: tentative(municipality, SEQUENTIAL_6),
});

/**
 * 指標と単位から、階級区分と配色を引く表。値は比（0.3 が 30%）か人数。
 * 区切りを差し替えるときは、この表の値だけを変える。
 */
export const CLASSIFICATIONS: Readonly<
  Record<IndicatorId, Readonly<Record<Unit, Classification>>>
> = {
  aging_rate: sameForBothUnits(fixed([0.3, 0.4, 0.5, 0.6, 0.7], DADS_ORANGE_6)),
  // TODO(トラック C): 0 を中心にした2方向。減少の側を細かく区切る仮の値
  pop_change: sameForBothUnits(
    tentative([-0.5, -0.3, -0.1, 0, 0.1, 0.3], [...DECREASE_4, ...INCREASE_4.slice(0, 3)]),
  ),
  // TODO(トラック C): 0 を中心にした2方向。増加の側を細かく区切る仮の値
  elderly_change: sameForBothUnits(
    tentative([-0.3, -0.1, 0, 0.1, 0.3, 0.5], [...DECREASE_4.slice(1), ...INCREASE_4]),
  ),
  pop: countScale([10, 100, 500, 1000, 5000], [5000, 10000, 30000, 100000, 300000]),
  p0_14: countScale([1, 10, 50, 100, 500], [500, 1000, 3000, 10000, 30000]),
  p15_64: countScale([5, 50, 300, 600, 3000], [3000, 6000, 20000, 60000, 200000]),
  p65: countScale([5, 30, 150, 300, 1500], [2000, 4000, 10000, 30000, 80000]),
  p75: countScale([3, 20, 100, 200, 1000], [1000, 2000, 6000, 15000, 50000]),
};

export const classificationOf = (id: IndicatorId, unit: Unit): Classification =>
  CLASSIFICATIONS[id][unit];

/**
 * 自前データを結合した指標（件数、合計、人口あたりの値）の配色。
 * 値の範囲が前もって分からないので、区切りは quantileBreaks で値から作る。
 * TODO(トラック C): 結合した指標の配色と、区切りの決め方（分位にするか、どの年の値で決めるか）
 */
export const JOINED_COLORS: readonly Rgba[] = SEQUENTIAL_6;

/**
 * 値の分位で区切りを作る。NaN は除く。重なった区切りは1つにまとめるので、区切りの数は classes - 1 以下になる。
 * 値が1つもなければ空の配列を返す（すべての値が最初の階級になる）。
 */
export const quantileBreaks = (values: ArrayLike<number>, classes: number): readonly number[] => {
  const sorted = Float64Array.from(Array.from(values).filter((v) => !Number.isNaN(v))).sort();
  if (sorted.length === 0 || classes < 2) {
    return [];
  }
  const breaks: number[] = [];
  for (let k = 1; k < classes; k++) {
    const b = sorted[Math.floor((k * sorted.length) / classes)] ?? Number.NaN;
    if (breaks.length === 0 || (breaks[breaks.length - 1] ?? b) < b) {
      breaks.push(b);
    }
  }
  return breaks;
};

/** 分位の区切りで、結合した指標の階級区分を作る。色は区切りの数に合わせて先頭から使う */
export const joinedClassification = (values: ArrayLike<number>): Classification => {
  const breaks = quantileBreaks(values, JOINED_COLORS.length);
  return tentative(breaks, JOINED_COLORS.slice(0, breaks.length + 1));
};
