// 指標と分母のセレクトボックスの選択肢（docs/design/ui.md の「アップロードとレイヤーの作成」、D24）。
// 選択肢の値は文字列のキーにし、選んだキーから core の IndicatorSelection を引く。

import {
  INDICATOR_IDS,
  INDICATORS,
  POPULATION_INDICATOR_IDS,
  type PopulationIndicatorId,
  type Unit,
} from "../core/indicators/definitions";
import type { JoinMeasure } from "../core/join/aggregate";
import { type IndicatorSelection, isIndicatorAvailable } from "../core/state/state";
import { type DatasetEntry, STORED_JOIN_COLUMNS } from "../core/storage/manifest";

export type IndicatorOption = {
  readonly key: string;
  readonly label: string;
  readonly selection: IndicatorSelection;
};

/** 選択肢のまとまり。label が null のまとまりは見出しを付けずに並べる（ベースデータの指標） */
export type IndicatorOptionGroup = {
  readonly label: string | null;
  readonly options: readonly IndicatorOption[];
};

/** 選択肢のキー。結合した指標は分母を含めない（分母は別のセレクトボックスで選ぶ） */
export const selectionKey = (selection: IndicatorSelection): string => {
  switch (selection.kind) {
    case "base":
      return `base:${selection.id}`;
    case "joined":
      return selection.measure.kind === "count"
        ? `joined:${selection.datasetId}:count`
        : `joined:${selection.datasetId}:sum:${selection.measure.column}`;
    default: {
      const unreachable: never = selection;
      return unreachable;
    }
  }
};

/**
 * 結合用の列の名前。表（CSV と Parquet）は結合用の列も columns に持つので、合計の選択肢から除く。
 * GeoJSON の columns は properties だけなので、何も除かない。
 */
const joinColumnNames = (dataset: DatasetEntry): ReadonlySet<string> => {
  if (dataset.stored_format !== "parquet") {
    return new Set();
  }
  const kind = dataset.kind === "point" ? "point" : dataset.join.includes("mesh") ? "mesh" : "code";
  return new Set(STORED_JOIN_COLUMNS[kind].map((c) => c.name));
};

/** 合計できる列。数値の列から結合用の列を除いたもの */
export const summableColumns = (dataset: DatasetEntry): readonly string[] => {
  const joinColumns = joinColumnNames(dataset);
  return dataset.columns
    .filter((c) => (c.type === "integer" || c.type === "float") && !joinColumns.has(c.name))
    .map((c) => c.name);
};

const measureLabel = (measure: JoinMeasure): string =>
  measure.kind === "count" ? "件数" : `${measure.column} の合計`;

/**
 * 指標のセレクトボックスの選択肢。ベースデータの8指標のあとに、その単位に結合できるデータごとに
 * 「件数」と数値の列の「合計」を並べる。
 * 結合した指標を選んでいるときは、その分母を引き継ぐ（指標を替えても分母を選び直さずに済むように）。
 */
export const indicatorOptionGroups = (
  unit: Unit,
  datasets: readonly DatasetEntry[],
  current: IndicatorSelection,
): readonly IndicatorOptionGroup[] => {
  const base: IndicatorOptionGroup = {
    label: null,
    options: INDICATOR_IDS.map((id) => {
      const selection: IndicatorSelection = { kind: "base", id };
      return { key: selectionKey(selection), label: INDICATORS[id].label, selection };
    }),
  };
  const perPopulation = current.kind === "joined" ? current.perPopulation : null;
  const joined = datasets.flatMap((dataset): readonly IndicatorOptionGroup[] => {
    const measures: readonly JoinMeasure[] = [
      { kind: "count" },
      ...summableColumns(dataset).map((column) => ({ kind: "sum", column }) as const),
    ];
    const options = measures.flatMap((measure): readonly IndicatorOption[] => {
      const selection: IndicatorSelection = {
        kind: "joined",
        datasetId: dataset.id,
        measure,
        perPopulation,
      };
      return isIndicatorAvailable(unit, selection, datasets)
        ? [{ key: selectionKey(selection), label: measureLabel(measure), selection }]
        : [];
    });
    return options.length === 0 ? [] : [{ label: dataset.name, options }];
  });
  return [base, ...joined];
};

/** 人口あたりの値の分母の選択肢。base が null の選択肢は「分母なし」（既定） */
export type DenominatorOption = {
  readonly key: string;
  readonly label: string;
  readonly base: PopulationIndicatorId | null;
};

/** 何人あたりの値にするか。1,000 人あたりに固定する（D24） */
export const PER_POPULATION = 1000;

export const DENOMINATOR_OPTIONS: readonly DenominatorOption[] = [
  { key: "none", label: "分母なし", base: null },
  ...POPULATION_INDICATOR_IDS.map((id) => ({
    key: id,
    label: `${INDICATORS[id].label} 1,000 人あたり`,
    base: id,
  })),
];

/** 選んでいる分母のキー */
export const denominatorKey = (selection: IndicatorSelection): string =>
  selection.kind === "joined" && selection.perPopulation !== null
    ? selection.perPopulation.base
    : "none";

/** 結合した指標の分母を替える。ベースデータの指標はそのまま返す */
export const withDenominator = (
  selection: IndicatorSelection,
  base: PopulationIndicatorId | null,
): IndicatorSelection =>
  selection.kind === "joined"
    ? { ...selection, perPopulation: base === null ? null : { base, per: PER_POPULATION } }
    : selection;
