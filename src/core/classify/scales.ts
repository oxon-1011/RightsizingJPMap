// 指標ごとの階級区分と配色の表。年をまたいで固定する（docs/design/map-and-hosting.md）。
// 区切りと配色は持ち主が 2026-11-08 に決めた（D23、docs/design/ui.md の「塗り分けの階級と配色」）。
// 色は DADS のプリミティブカラー（Figma の Digital Agency Design Data 2.18.2 の変数）の値である。

import { BASE_YEAR } from "../data/schema";
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

/** DADS の Purple の 100、300、500、700、900、1100。人数の指標の6階級に少ない順で使う */
const DADS_PURPLE_6: readonly Rgba[] = [
  hex("#ecddff"),
  hex("#cda6ff"),
  hex("#a565f8"),
  hex("#6f23d0"),
  hex("#5109ad"),
  hex("#30016c"),
];

/**
 * 人口増減率の7階級。減少の大きい順に DADS の Red の 1100、900、700、500、300、100 を使い、
 * 最後の「増加」の階級は Blue の 500 にする。暖色を人口が減る向きにそろえる。
 */
const POP_CHANGE_7: readonly Rgba[] = [
  hex("#850000"),
  hex("#ce0000"),
  hex("#fa0000"),
  hex("#ff5454"),
  hex("#ff9696"),
  hex("#ffdada"),
  hex("#4979f5"),
];

/**
 * 高齢者増加率の6階級。減少の側は DADS の Blue の 900、600、300、増加の側は Orange の 300、600、900。
 * 暖色を高齢者が増える向きにそろえる（高齢化率と同じ Orange）。
 */
const ELDERLY_CHANGE_6: readonly Rgba[] = [
  hex("#0017c1"),
  hex("#3460fb"),
  hex("#9db7f9"),
  hex("#ffa66d"),
  hex("#fb5b01"),
  hex("#ac3e00"),
];

/** DADS の Green の 100、300、500、700、900、1100。自前データを結合した指標に、小さい順で使う */
export const JOINED_COLORS: readonly Rgba[] = [
  hex("#c2e5d1"),
  hex("#71c598"),
  hex("#2cac6e"),
  hex("#1d8b56"),
  hex("#115a36"),
  hex("#08351f"),
];

const sameForBothUnits = (c: Classification): Readonly<Record<Unit, Classification>> => ({
  mesh: c,
  municipality: c,
});

/** 人数の指標の区切り。1km メッシュと市区町村では人数の桁が違うので、単位ごとに持つ */
const countScale = (
  mesh: readonly number[],
  municipality: readonly number[],
): Readonly<Record<Unit, Classification>> => ({
  mesh: { breaks: mesh, colors: DADS_PURPLE_6 },
  municipality: { breaks: municipality, colors: DADS_PURPLE_6 },
});

/** 総人口。1、3、10 の刻み */
const POP_SCALE = countScale([10, 30, 100, 300, 1000], [3000, 10000, 30000, 100000, 300000]);

/** 年齢別の4指標。年齢層どうしを同じ凡例で見比べられるよう、同じ区切りにする */
const AGE_GROUP_SCALE = countScale([3, 10, 30, 100, 300], [1000, 3000, 10000, 30000, 100000]);

/**
 * 指標と単位から、階級区分と配色を引く表。値は比（0.3 が 30%）か人数。
 * 比率と増減率は、メッシュと市区町村で同じ区切りにする。
 */
export const CLASSIFICATIONS: Readonly<
  Record<IndicatorId, Readonly<Record<Unit, Classification>>>
> = {
  aging_rate: sameForBothUnits({ breaks: [0.3, 0.4, 0.5, 0.6, 0.7], colors: DADS_ORANGE_6 }),
  // −75% は、2050 年以降に人がいなくなるメッシュ（2070 年は約 2 割）を、半減のメッシュと見分けるために置く。
  // −20% と −10% は、2030 年の5年間の変化を見分けるために残す（2026-11-10 に見直した）。
  pop_change: sameForBothUnits({
    breaks: [-0.75, -0.5, -0.35, -0.2, -0.1, 0],
    colors: POP_CHANGE_7,
  }),
  elderly_change: sameForBothUnits({
    breaks: [-0.5, -0.25, 0, 0.25, 0.5],
    colors: ELDERLY_CHANGE_6,
  }),
  pop: POP_SCALE,
  p0_14: AGE_GROUP_SCALE,
  p15_64: AGE_GROUP_SCALE,
  p65: AGE_GROUP_SCALE,
  p75: AGE_GROUP_SCALE,
};

export const classificationOf = (id: IndicatorId, unit: Unit): Classification =>
  CLASSIFICATIONS[id][unit];

/**
 * 人口あたりの値の区切りを決めるときに使う分母の年。
 * 結合した指標の区切りは、年次のスライダーを動かしても変えない。
 */
export const JOINED_CLASSIFICATION_YEAR = BASE_YEAR;

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

/**
 * 自前データを結合した指標（件数、合計、人口あたりの値）の階級区分。
 * 値の範囲が前もって分からないので、取り込んだデータの値から分位で区切りを作る。
 * 値がすべて 0 以上で 0 を含むときは、0 だけの階級を最初に置き、正の値を残りの階級に分位で分ける。
 * 点が1つもない市区町村の件数（0）を、件数の少ない市区町村と見分けられるようにするためである。
 * 色は区切りの数に合わせて先頭から使う。
 * 人口あたりの値には、JOINED_CLASSIFICATION_YEAR の分母で計算した値を渡す。
 */
export const joinedClassification = (values: ArrayLike<number>): Classification => {
  const valid = Array.from(values).filter((v) => !Number.isNaN(v));
  const zeroClass = valid.some((v) => v === 0) && valid.every((v) => v >= 0);
  if (!zeroClass) {
    const breaks = quantileBreaks(valid, JOINED_COLORS.length);
    return { breaks, colors: JOINED_COLORS.slice(0, breaks.length + 1) };
  }
  const positives = valid.filter((v) => v > 0);
  if (positives.length === 0) {
    return { breaks: [], colors: JOINED_COLORS.slice(0, 1) };
  }
  // 区切りと同じ値は上の階級に入るので、最小の正の値を区切りにすれば 0 だけが最初の階級に残る
  const smallest = positives.reduce((a, b) => Math.min(a, b));
  const rest = quantileBreaks(positives, JOINED_COLORS.length - 1).filter((b) => b > smallest);
  const breaks = [smallest, ...rest];
  return { breaks, colors: JOINED_COLORS.slice(0, breaks.length + 1) };
};
