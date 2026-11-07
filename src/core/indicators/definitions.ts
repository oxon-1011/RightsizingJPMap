// ベースデータの指標の定義（docs/design/base-data.md の「指標の定義」）。
// 指標ごとに、計算の種類、使える年、必要な列を持つ。

import {
  type AgeGroup,
  BASE_YEAR,
  MESH_AGE_YEARS,
  MESH_YEARS,
  type MeshAgeYear,
  type MeshYear,
  MUNICIPAL_YEARS,
  meshColumn,
} from "../data/schema";

export const INDICATOR_IDS = [
  "pop",
  "pop_change",
  "p0_14",
  "p15_64",
  "p65",
  "p75",
  "aging_rate",
  "elderly_change",
] as const;
export type IndicatorId = (typeof INDICATOR_IDS)[number];

/** 地図で塗る単位 */
export type Unit = "mesh" | "municipality";

/**
 * 指標の計算の形。
 * - count：1時点の人数（総数または年齢別）
 * - ratio：同じ時点の2つの人数の比
 * - change：2時点の比から1を引いた増減率。基準年は BASE_YEAR
 */
export type IndicatorFormula =
  | { readonly kind: "count"; readonly source: Source }
  | { readonly kind: "ratio"; readonly numerator: Source; readonly denominator: Source }
  | { readonly kind: "change"; readonly source: Source };

/** 計算に使う人数。total は総人口、それ以外は年齢別の人口 */
export type Source = "total" | AgeGroup;

export type IndicatorDefinition = {
  readonly id: IndicatorId;
  readonly label: string;
  readonly formula: IndicatorFormula;
  /** 値が比（0.3 が 30%）か人数か。凡例の目盛りの書き方に使う */
  readonly scale: "persons" | "fraction";
};

export const INDICATORS: Readonly<Record<IndicatorId, IndicatorDefinition>> = {
  pop: {
    id: "pop",
    label: "総人口",
    formula: { kind: "count", source: "total" },
    scale: "persons",
  },
  pop_change: {
    id: "pop_change",
    label: "人口増減率（2025年比）",
    formula: { kind: "change", source: "total" },
    scale: "fraction",
  },
  p0_14: {
    id: "p0_14",
    label: "年少人口（0〜14歳）",
    formula: { kind: "count", source: "p0_14" },
    scale: "persons",
  },
  p15_64: {
    id: "p15_64",
    label: "生産年齢人口（15〜64歳）",
    formula: { kind: "count", source: "p15_64" },
    scale: "persons",
  },
  p65: {
    id: "p65",
    label: "65歳以上人口",
    formula: { kind: "count", source: "p65" },
    scale: "persons",
  },
  p75: {
    id: "p75",
    label: "75歳以上人口",
    formula: { kind: "count", source: "p75" },
    scale: "persons",
  },
  aging_rate: {
    id: "aging_rate",
    label: "高齢化率",
    formula: { kind: "ratio", numerator: "p65", denominator: "total" },
    scale: "fraction",
  },
  elderly_change: {
    id: "elderly_change",
    label: "高齢者増加率（2025年比）",
    formula: { kind: "change", source: "p65" },
    scale: "fraction",
  },
};

/** 指標が年齢別の値を使うか。使うなら、メッシュでは秘匿の扱い（D7）と年の制約がかかる */
export const usesAgeGroups = (id: IndicatorId): boolean => {
  const formula = INDICATORS[id].formula;
  switch (formula.kind) {
    case "count":
    case "change":
      return formula.source !== "total";
    case "ratio":
      return formula.numerator !== "total" || formula.denominator !== "total";
    default: {
      const unreachable: never = formula;
      return unreachable;
    }
  }
};

/**
 * 単位と指標の組で選べる年（D8）。
 * メッシュの年齢別の指標は、2020 年に年齢別の値がないので 2025 年からになる。
 */
export const availableYears = (unit: Unit, id: IndicatorId): readonly number[] => {
  switch (unit) {
    case "municipality":
      return MUNICIPAL_YEARS;
    case "mesh":
      return usesAgeGroups(id) ? MESH_AGE_YEARS : MESH_YEARS;
    default: {
      const unreachable: never = unit;
      return unreachable;
    }
  }
};

const isMeshYear = (year: number): year is MeshYear =>
  (MESH_YEARS as readonly number[]).includes(year);

const isMeshAgeYear = (year: number): year is MeshAgeYear =>
  (MESH_AGE_YEARS as readonly number[]).includes(year);

/** メッシュで、ある年のある人数を表す列。秘匿の列は年齢別のときだけ付く */
type MeshSourceColumns = { readonly value: string; readonly masked: string | null };

const meshSourceColumns = (source: Source, year: number): MeshSourceColumns | null => {
  if (source === "total") {
    return isMeshYear(year) ? { value: meshColumn.pop(year), masked: null } : null;
  }
  return isMeshAgeYear(year)
    ? { value: meshColumn.age(year, source), masked: meshColumn.masked(year) }
    : null;
};

/** メッシュで指標を計算するときに使う列の組。計算は indicators/mesh.ts が行う */
export type MeshIndicatorColumns =
  | { readonly kind: "count"; readonly value: MeshSourceColumns }
  | {
      readonly kind: "ratio";
      readonly numerator: MeshSourceColumns;
      readonly denominator: MeshSourceColumns;
    }
  | {
      readonly kind: "change";
      readonly current: MeshSourceColumns;
      readonly base: MeshSourceColumns;
    };

/** メッシュで、指標と年から使う列の組を求める。その年に選べない指標なら null */
export const meshIndicatorColumns = (
  id: IndicatorId,
  year: number,
): MeshIndicatorColumns | null => {
  if (!availableYears("mesh", id).includes(year)) {
    return null;
  }
  const formula = INDICATORS[id].formula;
  switch (formula.kind) {
    case "count": {
      const value = meshSourceColumns(formula.source, year);
      return value === null ? null : { kind: "count", value };
    }
    case "ratio": {
      const numerator = meshSourceColumns(formula.numerator, year);
      const denominator = meshSourceColumns(formula.denominator, year);
      return numerator === null || denominator === null
        ? null
        : { kind: "ratio", numerator, denominator };
    }
    case "change": {
      const current = meshSourceColumns(formula.source, year);
      const base = meshSourceColumns(formula.source, BASE_YEAR);
      return current === null || base === null ? null : { kind: "change", current, base };
    }
    default: {
      const unreachable: never = formula;
      return unreachable;
    }
  }
};

const sourceColumnNames = ({ value, masked }: MeshSourceColumns): readonly string[] =>
  masked === null ? [value] : [value, masked];

/**
 * mesh_indicators.parquet から読む列の名前（mesh 列を除く）。io はこの列だけを読む。
 * 同じ列は1度だけ並べる。その年に選べない指標なら空の配列を返す。
 */
export const meshColumnsToRead = (id: IndicatorId, year: number): readonly string[] => {
  const columns = meshIndicatorColumns(id, year);
  if (columns === null) {
    return [];
  }
  const names = ((): readonly string[] => {
    switch (columns.kind) {
      case "count":
        return sourceColumnNames(columns.value);
      case "ratio":
        return [...sourceColumnNames(columns.numerator), ...sourceColumnNames(columns.denominator)];
      case "change":
        return [...sourceColumnNames(columns.current), ...sourceColumnNames(columns.base)];
      default: {
        const unreachable: never = columns;
        return unreachable;
      }
    }
  })();
  return [...new Set(names)];
};
