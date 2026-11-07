// 行政区域の指標の計算。municipal_indicators.parquet（1行が1地域の1年）の列から、
// 団体コードから値への対応を作る。値なし（分母 0、NULL）は NaN にする。

import {
  type AgeGroup,
  AREA_TYPES,
  type AreaType,
  BASE_YEAR,
  MUNICIPAL_COLUMNS,
} from "../data/schema";
import { err, ok, type Result } from "../result";
import {
  type ColumnError,
  type Columns,
  type NumericColumn,
  numericColumn,
  safeRatio,
  stringColumn,
} from "./columns";
import { availableYears, INDICATORS, type IndicatorId, type Source } from "./definitions";

/** 検査済みの municipal_indicators.parquet の列 */
export type MunicipalTable = {
  readonly length: number;
  readonly codes: readonly string[];
  readonly areaTypes: readonly string[];
  readonly years: NumericColumn;
  readonly pop: NumericColumn;
  readonly ages: Readonly<Record<AgeGroup, NumericColumn>>;
};

export type MunicipalTableError =
  | ColumnError
  | { readonly kind: "duplicate-row"; readonly code: string; readonly year: number };

/**
 * 地図で塗る単位の area_type（docs/design/base-data.md の「行政区域と団体コード」）。
 * 政令指定都市の区と東京都の特別区、市、町村、浜通り地域。都道府県と政令指定都市そのものは塗らない。
 */
export const PAINTED_AREA_TYPES: readonly AreaType[] = [
  AREA_TYPES.ward,
  AREA_TYPES.city,
  AREA_TYPES.townVillage,
  AREA_TYPES.hamadoori,
];

const paintedAreaTypes: readonly string[] = PAINTED_AREA_TYPES;

const isPainted = (areaType: string): boolean => paintedAreaTypes.includes(areaType);

/** io が読んだ列を検査して、MunicipalTable にする。同じ団体コードと年の行が2つあれば拒否する */
export const parseMunicipalTable = (
  columns: Columns,
): Result<MunicipalTable, MunicipalTableError> => {
  const codes = stringColumn(columns, MUNICIPAL_COLUMNS.code, null);
  if (!codes.ok) {
    return codes;
  }
  const length = codes.value.length;
  const areaTypes = stringColumn(columns, MUNICIPAL_COLUMNS.areaType, length);
  if (!areaTypes.ok) {
    return areaTypes;
  }
  const years = numericColumn(columns, MUNICIPAL_COLUMNS.year, length);
  if (!years.ok) {
    return years;
  }
  const pop = numericColumn(columns, MUNICIPAL_COLUMNS.pop, length);
  if (!pop.ok) {
    return pop;
  }
  const age = (group: AgeGroup) => numericColumn(columns, MUNICIPAL_COLUMNS.age(group), length);
  const p0_14 = age("p0_14");
  if (!p0_14.ok) {
    return p0_14;
  }
  const p15_64 = age("p15_64");
  if (!p15_64.ok) {
    return p15_64;
  }
  const p65 = age("p65");
  if (!p65.ok) {
    return p65;
  }
  const p75 = age("p75");
  if (!p75.ok) {
    return p75;
  }
  const seen = new Set<string>();
  for (let i = 0; i < length; i++) {
    const code = codes.value[i] ?? "";
    const year = years.value[i] ?? Number.NaN;
    const key = `${code}/${year}`;
    if (seen.has(key)) {
      return err({ kind: "duplicate-row", code, year });
    }
    seen.add(key);
  }
  return ok({
    length,
    codes: codes.value,
    areaTypes: areaTypes.value,
    years: years.value,
    pop: pop.value,
    ages: { p0_14: p0_14.value, p15_64: p15_64.value, p65: p65.value, p75: p75.value },
  });
};

/** 地図で塗る単位の団体コードの集合。自前データの code 列の受け入れ検査に渡す */
export const paintedMunicipalCodes = (table: MunicipalTable): ReadonlySet<string> => {
  const codes = new Set<string>();
  for (let i = 0; i < table.length; i++) {
    const code = table.codes[i];
    if (code !== undefined && isPainted(table.areaTypes[i] ?? "")) {
      codes.add(code);
    }
  }
  return codes;
};

const sourceColumn = (table: MunicipalTable, source: Source): NumericColumn =>
  source === "total" ? table.pop : table.ages[source];

/** ある年の、地図で塗る単位の行の番号を、団体コードから引けるようにする */
const rowsOfYear = (table: MunicipalTable, year: number): ReadonlyMap<string, number> => {
  const rows = new Map<string, number>();
  for (let i = 0; i < table.length; i++) {
    const code = table.codes[i];
    if (code !== undefined && table.years[i] === year && isPainted(table.areaTypes[i] ?? "")) {
      rows.set(code, i);
    }
  }
  return rows;
};

export type MunicipalIndicatorError = {
  readonly kind: "unavailable-year";
  readonly id: IndicatorId;
  readonly year: number;
};

/**
 * 地図で塗る単位ごとの指標の値。キーは団体コードで、値なしは NaN。
 * 増減率の基準年の行がない地域も NaN にする。
 */
export const computeMunicipalIndicator = (
  table: MunicipalTable,
  id: IndicatorId,
  year: number,
): Result<ReadonlyMap<string, number>, MunicipalIndicatorError> => {
  if (!availableYears("municipality", id).includes(year)) {
    return err({ kind: "unavailable-year", id, year });
  }
  const rows = rowsOfYear(table, year);
  const formula = INDICATORS[id].formula;
  const values = new Map<string, number>();
  switch (formula.kind) {
    case "count": {
      const column = sourceColumn(table, formula.source);
      for (const [code, i] of rows) {
        values.set(code, column[i] ?? Number.NaN);
      }
      return ok(values);
    }
    case "ratio": {
      const numerator = sourceColumn(table, formula.numerator);
      const denominator = sourceColumn(table, formula.denominator);
      for (const [code, i] of rows) {
        values.set(code, safeRatio(numerator[i] ?? Number.NaN, denominator[i] ?? Number.NaN));
      }
      return ok(values);
    }
    case "change": {
      const column = sourceColumn(table, formula.source);
      const baseRows = rowsOfYear(table, BASE_YEAR);
      for (const [code, i] of rows) {
        const b = baseRows.get(code);
        const base = b === undefined ? Number.NaN : (column[b] ?? Number.NaN);
        values.set(code, safeRatio(column[i] ?? Number.NaN, base) - 1);
      }
      return ok(values);
    }
    default: {
      const unreachable: never = formula;
      return unreachable;
    }
  }
};
