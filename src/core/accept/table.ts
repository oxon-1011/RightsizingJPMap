// CSV と Parquet の受け入れ検査（docs/design/user-data.md の「CSV と Parquet の受け入れ条件」）。
// 条件を満たさない値は拒否し、推測で直さない（D12）。
//
// 検査は2段に分ける。
// 1. planTableJoin：列の名前と型だけから、結合に使う列の組を決める。io はこの結果を見て結合用の列の値を読む。
// 2. checkTableValues：結合用の列の値を全件検査し、型の付いた値にして返す。
//
// CSV の結合用の列は、先頭の 0 を落とさないよう io が文字列として読む。Parquet は元の型のまま渡す。

import { err, ok, type Result } from "../result";
import { type Violation, violationCollector } from "./violation";

/** io が渡す列の型。DuckDB の型を、文字列、整数、浮動小数点数、その他の4つにまとめたもの */
export type ColumnType = "string" | "integer" | "float" | "other";

export type ColumnSchema = { readonly name: string; readonly type: ColumnType };

export type TableFormat = "csv" | "parquet";

/** 結合に使う列の組。code は行政区域、mesh はメッシュ、point は lat と lon の組 */
export type TableJoinKind = "code" | "mesh" | "point";

export const JOIN_COLUMN_NAMES = {
  code: ["code"],
  mesh: ["mesh"],
  point: ["lat", "lon"],
} as const satisfies Record<TableJoinKind, readonly string[]>;

const JOIN_KINDS: readonly TableJoinKind[] = ["code", "mesh", "point"];

/** 北緯と東経の範囲（両端を含む）。GeoJSON の座標にも同じ範囲を使う */
export const LAT_RANGE = { min: 20, max: 46 } as const;
export const LON_RANGE = { min: 122, max: 154 } as const;

export type TableJoinPlan = {
  readonly kind: TableJoinKind;
  /** 結合に使う列。code と mesh は1列、point は lat、lon の順の2列 */
  readonly joinColumns: readonly ColumnSchema[];
  /** 結合に使う列のほかの列。数値の列は結合後に合計できる */
  readonly attributes: readonly ColumnSchema[];
};

export type TableValueCondition = "code" | "mesh" | "lat-lon";

export type TableRejection =
  | { readonly kind: "duplicate-column-names"; readonly names: readonly string[] }
  | { readonly kind: "no-join-columns" }
  | { readonly kind: "multiple-join-columns"; readonly found: readonly TableJoinKind[] }
  /** lat と lon の片方だけがある */
  | { readonly kind: "incomplete-lat-lon"; readonly present: "lat" | "lon" }
  /** 整数型の code 列。先頭の 0 が落ちているおそれがあるので拒否する（持ち主の決定、2026-11-07） */
  | { readonly kind: "code-not-string"; readonly type: ColumnType }
  | {
      readonly kind: "unsupported-join-column-type";
      readonly column: string;
      readonly type: ColumnType;
    }
  | { readonly kind: "no-rows" }
  | { readonly kind: "invalid-values"; readonly violation: Violation<TableValueCondition> };

const findDuplicates = (names: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return [...duplicates];
};

/** 結合に使う列の型として受け付けるもの */
const ACCEPTED_TYPES: Readonly<Record<string, readonly ColumnType[]>> = {
  code: ["string"],
  mesh: ["string", "integer"],
  lat: ["string", "integer", "float"],
  lon: ["string", "integer", "float"],
};

/** 列の名前と型から、結合に使う列の組を決める。組が0個か2個以上なら拒否する */
export const planTableJoin = (
  columns: readonly ColumnSchema[],
): Result<TableJoinPlan, TableRejection> => {
  const duplicates = findDuplicates(columns.map((c) => c.name));
  if (duplicates.length > 0) {
    return err({ kind: "duplicate-column-names", names: duplicates });
  }
  const byName = new Map(columns.map((c) => [c.name, c]));
  const hasLat = byName.has("lat");
  const hasLon = byName.has("lon");
  if (hasLat !== hasLon) {
    return err({ kind: "incomplete-lat-lon", present: hasLat ? "lat" : "lon" });
  }
  const found = JOIN_KINDS.filter((kind) => JOIN_COLUMN_NAMES[kind].every((n) => byName.has(n)));
  const [kind, ...rest] = found;
  if (kind === undefined) {
    return err({ kind: "no-join-columns" });
  }
  if (rest.length > 0) {
    return err({ kind: "multiple-join-columns", found });
  }
  const joinNames: readonly string[] = JOIN_COLUMN_NAMES[kind];
  const joinColumns = columns
    .filter((c) => joinNames.includes(c.name))
    .sort((a, b) => joinNames.indexOf(a.name) - joinNames.indexOf(b.name));
  for (const column of joinColumns) {
    if (!(ACCEPTED_TYPES[column.name] ?? []).includes(column.type)) {
      return err(
        column.name === "code" && column.type === "integer"
          ? { kind: "code-not-string", type: column.type }
          : { kind: "unsupported-join-column-type", column: column.name, type: column.type },
      );
    }
  }
  return ok({
    kind,
    joinColumns,
    attributes: columns.filter((c) => !joinNames.includes(c.name)),
  });
};

/** io が読んだ結合用の列の値。文字列の NULL は null、数値の NULL は NaN */
export type ColumnValues =
  | { readonly type: "string"; readonly values: readonly (string | null)[] }
  | { readonly type: "integer" | "float"; readonly values: Float64Array };

/** 検査を通った表。結合用の列は型の付いた値にしてある */
export type AcceptedTable = {
  readonly format: TableFormat;
  readonly rowCount: number;
  readonly join:
    | { readonly kind: "code"; readonly codes: readonly string[] }
    | { readonly kind: "mesh"; readonly meshes: Uint32Array }
    | { readonly kind: "point"; readonly lat: Float64Array; readonly lon: Float64Array };
  readonly attributes: readonly ColumnSchema[];
};

const CODE_PATTERN = /^\d{5}$/;
const MESH_PATTERN = /^\d{8}$/;
/** 十進数の表記。符号は負だけを許し、指数の表記と前後の空白は許さない */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * 3次メッシュコードとして形が正しいか。8桁で、5桁めと6桁め（2次メッシュの番号）が 0〜7。
 * ベースデータにあるかどうかは問わない（docs/design/user-data.md の「検査と拒否」）。
 */
export const isMeshCode = (code: number): boolean =>
  Number.isInteger(code) &&
  code >= 10_000_000 &&
  code <= 99_999_999 &&
  Math.floor(code / 1_000) % 10 <= 7 &&
  Math.floor(code / 100) % 10 <= 7;

const inRange = (value: number, range: { readonly min: number; readonly max: number }): boolean =>
  value >= range.min && value <= range.max;

/** 緯度か経度の値を数にする。文字列は十進数の表記に限る。読めなければ NaN */
const coordinateValue = (column: ColumnValues, i: number): number => {
  if (column.type === "string") {
    const text = column.values[i] ?? null;
    return text !== null && DECIMAL_PATTERN.test(text) ? Number(text) : Number.NaN;
  }
  return column.values[i] ?? Number.NaN;
};

const columnFor = (
  values: Readonly<Record<string, ColumnValues>>,
  column: ColumnSchema,
): ColumnValues => {
  const found = values[column.name];
  if (found === undefined || found.type !== column.type) {
    throw new Error(`結合用の列 ${column.name} の値が、計画と違う型で渡された`);
  }
  return found;
};

const lengthOf = (column: ColumnValues): number => column.values.length;

/**
 * 結合用の列の値を全件検査する。1行でも条件を満たさなければ拒否し、満たさなかった行を先頭から示す。
 * validCodes は地図で塗る単位の団体コードの集合（indicators/municipal.ts の paintedMunicipalCodes）。
 * values のキーは列の名前で、plan.joinColumns の列をすべて含めて渡す。
 */
export const checkTableValues = (
  format: TableFormat,
  plan: TableJoinPlan,
  values: Readonly<Record<string, ColumnValues>>,
  validCodes: ReadonlySet<string>,
): Result<AcceptedTable, TableRejection> => {
  const columns = plan.joinColumns.map((c) => columnFor(values, c));
  const rowCount = columns[0] === undefined ? 0 : lengthOf(columns[0]);
  if (columns.some((c) => lengthOf(c) !== rowCount)) {
    throw new Error("結合用の列の長さがそろっていない");
  }
  if (rowCount === 0) {
    return err({ kind: "no-rows" });
  }
  const finish = (
    violation: Violation<TableValueCondition> | null,
    join: AcceptedTable["join"],
  ): Result<AcceptedTable, TableRejection> =>
    violation === null
      ? ok({ format, rowCount, join, attributes: plan.attributes })
      : err({ kind: "invalid-values", violation });

  switch (plan.kind) {
    case "code": {
      const [column] = columns;
      if (column?.type !== "string") {
        throw new Error("code 列は文字列で渡す");
      }
      const collector = violationCollector("code" as const);
      const codes: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        const code = column.values[i] ?? null;
        if (code !== null && CODE_PATTERN.test(code) && validCodes.has(code)) {
          codes.push(code);
        } else {
          collector.add(i);
        }
      }
      return finish(collector.result(), { kind: "code", codes });
    }
    case "mesh": {
      const [column] = columns;
      if (column === undefined) {
        throw new Error("mesh 列がない");
      }
      const collector = violationCollector("mesh" as const);
      const meshes = new Uint32Array(rowCount);
      for (let i = 0; i < rowCount; i++) {
        const code = ((): number => {
          if (column.type === "string") {
            const text = column.values[i] ?? null;
            return text !== null && MESH_PATTERN.test(text) ? Number(text) : Number.NaN;
          }
          return column.values[i] ?? Number.NaN;
        })();
        if (isMeshCode(code)) {
          meshes[i] = code;
        } else {
          collector.add(i);
        }
      }
      return finish(collector.result(), { kind: "mesh", meshes });
    }
    case "point": {
      const [latColumn, lonColumn] = columns;
      if (latColumn === undefined || lonColumn === undefined) {
        throw new Error("lat 列か lon 列がない");
      }
      const collector = violationCollector("lat-lon" as const);
      const lat = new Float64Array(rowCount);
      const lon = new Float64Array(rowCount);
      for (let i = 0; i < rowCount; i++) {
        const y = coordinateValue(latColumn, i);
        const x = coordinateValue(lonColumn, i);
        // NaN は範囲の比較で必ず偽になるので、ここで拒否される
        if (inRange(y, LAT_RANGE) && inRange(x, LON_RANGE)) {
          lat[i] = y;
          lon[i] = x;
        } else {
          collector.add(i);
        }
      }
      return finish(collector.result(), { kind: "point", lat, lon });
    }
    default: {
      const unreachable: never = plan.kind;
      return unreachable;
    }
  }
};

/** 結合後に合計できる属性の列（整数と浮動小数点数） */
export const numericAttributes = (attributes: readonly ColumnSchema[]): readonly string[] =>
  attributes.filter((c) => c.type === "integer" || c.type === "float").map((c) => c.name);
