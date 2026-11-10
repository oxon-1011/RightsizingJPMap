// ホバーのカードの文言と置き場所（docs/design/implementation-plan.md の段階 7.5 の 3.）。
// 中身は core の hoverContent が決め、ここでは見出しと行の文字にする。
// 指標の値は凡例と同じ書き方にし、2行目の人数（総人口か、人口あたりの値の分母）は整数に丸めて全部の桁を出す。

import { classificationOf } from "../core/classify/scales";
import type { HoverContent, HoverValue } from "../core/hover/hover";
import { INDICATORS } from "../core/indicators/definitions";
import type { IndicatorSelection } from "../core/state/state";
import { DENOMINATOR_OPTIONS, measureLabel } from "./indicator-options";
import { formatLegendValue, isSigned, type LegendScale, RANGE_UNIT } from "./legend-format";

/** カードの1行。note は名前の下に薄く添える文字（人口あたりの値の分母） */
export type HoverRow = {
  readonly label: string;
  readonly note: string | null;
  readonly value: string;
};

export type HoverCardText = {
  /** 見出し。メッシュコード、区域の名前、レイヤーの名前 */
  readonly title: string;
  /** 見出しの前に薄く添える文字（区域の都道府県）。なければ null */
  readonly titlePrefix: string | null;
  /** 見出しの右に添える年（「2050年」）。自前データの地物では null */
  readonly year: string | null;
  readonly rows: readonly HoverRow[];
  /** 出さなかった属性の数（「ほか 2 項目」）。なければ null */
  readonly more: string | null;
};

/** 秘匿と値なしの書き方。凡例の値なしの四角に添える「なし」とそろえる */
export const MASKED_TEXT = "秘匿";
export const NO_VALUE_LABEL = "なし";

const valueText = (value: HoverValue, format: (n: number) => string): string => {
  switch (value.kind) {
    case "masked":
      return MASKED_TEXT;
    case "none":
      return NO_VALUE_LABEL;
    case "number":
      return format(value.value);
    default: {
      const unreachable: never = value;
      return unreachable;
    }
  }
};

/** 指標の値の書き方。凡例の目盛りと同じ数字に、範囲の文と同じ単位（「人」「%」）を付ける */
const legendStyle =
  (scale: LegendScale, signed: boolean) =>
  (n: number): string =>
    `${formatLegendValue(n, scale, signed)}${RANGE_UNIT[scale].unit}`;

const headcountFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

/**
 * 2行目の人数の書き方。整数に丸め、桁区切りで全部の桁を出す（「1,283 人」、「60,000 人」）。
 * 凡例と違って有効数字で丸めず、「万」も使わない。人口の少ないメッシュを見分けられるようにするため（持ち主の決定、2026-11-10）
 */
export const formatHeadcount = (n: number): string => `${headcountFormat.format(n)} 人`;

/** 指標の名前と、値の書き方 */
const indicatorText = (
  indicator: IndicatorSelection,
  datasetName: string | null,
  unit: "mesh" | "municipality",
): {
  readonly label: string;
  readonly note: string | null;
  readonly format: (n: number) => string;
} => {
  switch (indicator.kind) {
    case "base":
      return {
        label: INDICATORS[indicator.id].label,
        note: null,
        // 総人口の指標では、総人口の行を兼ねるので、2行目の人数と同じ書き方にする
        format:
          indicator.id === "pop"
            ? formatHeadcount
            : legendStyle(
                INDICATORS[indicator.id].scale,
                isSigned(classificationOf(indicator.id, unit).breaks),
              ),
      };
    case "joined": {
      const { perPopulation } = indicator;
      const denominator =
        perPopulation === null
          ? null
          : (DENOMINATOR_OPTIONS.find((o) => o.base === perPopulation.base)?.label ?? null);
      return {
        label: `${datasetName ?? ""} ${measureLabel(indicator.measure)}`.trim(),
        note: denominator,
        format: legendStyle("number", false),
      };
    }
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};

const attributeText = (value: string | number | boolean | null): string =>
  value === null ? NO_VALUE_LABEL : String(value);

export const hoverCardText = (content: HoverContent): HoverCardText => {
  if (content.kind === "feature") {
    return {
      title: content.layerName,
      titlePrefix: null,
      year: null,
      rows: content.attributes.map((a) => ({
        label: a.name,
        note: null,
        value: attributeText(a.value),
      })),
      more: content.omitted > 0 ? `ほか ${content.omitted} 項目` : null,
    };
  }
  const indicator = indicatorText(content.indicator, content.datasetName, content.kind);
  const rows: HoverRow[] = [
    {
      label: indicator.label,
      note: indicator.note,
      value: valueText(content.value, indicator.format),
    },
  ];
  if (content.population !== null) {
    rows.push({
      label: INDICATORS[content.population.indicator].label,
      note: null,
      value: valueText(content.population.value, formatHeadcount),
    });
  }
  return {
    title: content.kind === "mesh" ? String(content.code) : content.name,
    titlePrefix: content.kind === "municipality" ? content.prefecture : null,
    year: `${content.year}年`,
    rows,
    more: null,
  };
};

/** ポインタとカードのあいだ（px） */
export const HOVER_CARD_OFFSET = 16;
/** カードの最大の幅（px）。部品の max-w-72（18rem）と同じ */
export const HOVER_CARD_MAX_WIDTH = 288;
/** カードの高さの見込み（px）。属性を5つと「ほか」の行を出したときに収まる高さ */
export const HOVER_CARD_MAX_HEIGHT = 200;

/**
 * カードの置き場所。ふだんはポインタの右下に置き、地図の右端か下端からはみ出すときは、
 * ポインタの左か上に置く。left と top はカードのどの角をポインタに向けるかで、translate と組で使う。
 */
export const hoverCardPlacement = (pointer: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): {
  readonly left: number;
  readonly top: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
} => {
  const flipX = pointer.x + HOVER_CARD_OFFSET + HOVER_CARD_MAX_WIDTH > pointer.width;
  const flipY = pointer.y + HOVER_CARD_OFFSET + HOVER_CARD_MAX_HEIGHT > pointer.height;
  return {
    left: flipX ? pointer.x - HOVER_CARD_OFFSET : pointer.x + HOVER_CARD_OFFSET,
    top: flipY ? pointer.y - HOVER_CARD_OFFSET : pointer.y + HOVER_CARD_OFFSET,
    flipX,
    flipY,
  };
};
