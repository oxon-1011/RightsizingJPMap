// DuckDB-WASM で表を読み、正規化した Parquet を書き、点を行政区域に割り当てる（TableEngine の実装）。
// DuckDB は初めて使うときに起動し（D4）、spatial 拡張は初めて点を割り当てるときに読み込む。
// SQL は sql.ts で組み立て、受け入れの判断は呼び出し側が core の関数で行う。

import type { ColumnSchema, ColumnValues, TableFormat, TableJoinPlan } from "../core/accept/table";
import { err, ok, type Result } from "../core/result";
import {
  type DuckDb,
  type DuckDbError,
  dropFile,
  loadSpatial,
  type QueryResult,
  query,
  readFileBytes,
  registerFile,
  startDuckDb,
  stopDuckDb,
} from "../io/duckdb";
import type { TableEngine, TableEngineError, TableSource } from "./ports";
import {
  assignPointsSql,
  columnTypeOfDuckDb,
  csvHeaderSql,
  csvJoinColumnNames,
  csvNamesSource,
  csvSource,
  describeSql,
  joinValuesSql,
  normalizeSql,
  parquetSource,
  pointsCsv,
  type SqlColumn,
} from "./sql";

const messageOf = (error: DuckDbError): string =>
  "message" in error ? error.message : `${error.kind}: ${error.name}`;

const readFailed = (error: DuckDbError): TableEngineError => ({
  kind: "read-failed",
  message: messageOf(error),
});

const engineFailed = (error: DuckDbError): TableEngineError => ({
  kind: "engine-failed",
  message: messageOf(error),
});

const columnValues = (result: QueryResult, name: string): readonly unknown[] | null =>
  result.columns.find((c) => c.name === name)?.values ?? null;

/** DESCRIBE の結果を、列の名前と受け入れ検査の型にする */
const describedColumns = (
  result: QueryResult,
): Result<readonly ColumnSchema[], TableEngineError> => {
  const names = columnValues(result, "column_name");
  const types = columnValues(result, "column_type");
  if (names === null || types === null) {
    return err({ kind: "read-failed", message: "DESCRIBE の結果に列名か型がない" });
  }
  const columns: ColumnSchema[] = [];
  for (const [i, name] of names.entries()) {
    const type = types[i];
    if (typeof name !== "string" || typeof type !== "string") {
      return err({ kind: "read-failed", message: "DESCRIBE の結果の列名か型が文字列でない" });
    }
    columns.push({ name, type: columnTypeOfDuckDb(type) });
  }
  return ok(columns);
};

const describe = async (
  duck: DuckDb,
  source: string,
): Promise<Result<readonly ColumnSchema[], TableEngineError>> => {
  const result = await query(duck, describeSql(source));
  return result.ok ? describedColumns(result.value) : err(readFailed(result.error));
};

const hasDuplicates = (names: readonly string[]): boolean => new Set(names).size !== names.length;

type DescribedTable = { readonly source: string; readonly columns: readonly SqlColumn[] };

/**
 * CSV の列。列名は1行目をそのまま読んだものにする。
 * DuckDB は列名の前後の空白を除き、重なった列名を付け替えるので、DuckDB の列名は SQL で列を指すのにだけ使う。
 * 重なった列名があれば、その名前のまま返す（core の planTableJoin が拒否する）。
 * 重なっていなければ、結合用の列を文字列として読む指定で DESCRIBE し直して、型を得る。
 */
const csvColumns = async (
  duck: DuckDb,
  fileName: string,
): Promise<Result<DescribedTable, TableEngineError>> => {
  const header = await query(duck, csvHeaderSql(fileName));
  if (!header.ok) {
    return err(readFailed(header.error));
  }
  const rawNames: string[] = [];
  for (const column of header.value.columns) {
    const value = column.values[0];
    // 空の列名は SQL で名前として書けない（DuckDB は column1 などに付け替える）
    if (typeof value !== "string" || value === "") {
      return err({ kind: "read-failed", message: "列名が空の列がある" });
    }
    rawNames.push(value);
  }
  if (hasDuplicates(rawNames)) {
    return ok({
      source: csvSource(fileName, []),
      columns: rawNames.map((name) => ({ name, sqlName: name, type: "other" })),
    });
  }
  const named = await describe(duck, csvNamesSource(fileName));
  if (!named.ok) {
    return named;
  }
  const sqlNames = named.value.map((c) => c.name);
  if (sqlNames.length !== rawNames.length) {
    return err({ kind: "read-failed", message: "1行目と DuckDB の列の数が違う" });
  }
  const joinNames = new Set(csvJoinColumnNames(rawNames));
  const source = csvSource(
    fileName,
    sqlNames.filter((_, i) => joinNames.has(rawNames[i] ?? "")),
  );
  const typed = await describe(duck, source);
  if (!typed.ok) {
    return typed;
  }
  const columns: SqlColumn[] = [];
  for (const [i, name] of rawNames.entries()) {
    const column = typed.value[i];
    if (column === undefined) {
      return err({ kind: "read-failed", message: "1行目と DuckDB の列の数が違う" });
    }
    columns.push({ name, sqlName: column.name, type: column.type });
  }
  return ok({ source, columns });
};

/** Parquet の列。列名は Parquet のものをそのまま使う */
const parquetColumns = async (
  duck: DuckDb,
  fileName: string,
): Promise<Result<DescribedTable, TableEngineError>> => {
  const source = parquetSource(fileName);
  const described = await describe(duck, source);
  return described.ok
    ? ok({ source, columns: described.value.map((c) => ({ ...c, sqlName: c.name })) })
    : described;
};

/** query の結果の列を、受け入れ検査に渡す値にする。型が計画と違えば失敗にする */
const toColumnValues = (
  values: readonly unknown[],
  column: ColumnSchema,
): Result<ColumnValues, TableEngineError> => {
  if (column.type === "string") {
    const strings: (string | null)[] = [];
    for (const v of values) {
      if (v !== null && typeof v !== "string") {
        return err({ kind: "read-failed", message: `列 ${column.name} に文字列でない値がある` });
      }
      strings.push(v);
    }
    return ok({ type: "string", values: strings });
  }
  if (column.type === "integer" || column.type === "float") {
    const numbers = new Float64Array(values.length);
    for (const [i, v] of values.entries()) {
      if (v !== null && typeof v !== "number") {
        return err({ kind: "read-failed", message: `列 ${column.name} に数でない値がある` });
      }
      numbers[i] = v ?? Number.NaN;
    }
    return ok({ type: column.type, values: numbers });
  }
  return err({ kind: "read-failed", message: `列 ${column.name} の型を結合に使えない` });
};

export const createDuckDbEngine = (): TableEngine => {
  let started: Promise<Result<DuckDb, DuckDbError>> | null = null;
  let spatial: Promise<Result<void, DuckDbError>> | null = null;
  const registeredGeometries = new Set<string>();
  let fileCounter = 0;
  const nextName = (prefix: string, extension: string): string =>
    `rjm-${prefix}-${++fileCounter}.${extension}`;

  /** 起動に失敗したら、次に呼んだときに起動し直す */
  const duckDb = async (): Promise<Result<DuckDb, TableEngineError>> => {
    started ??= startDuckDb();
    const result = await started;
    if (!result.ok) {
      started = null;
      return err(engineFailed(result.error));
    }
    return result;
  };

  const openTable = async (
    file: Blob,
    format: TableFormat,
  ): Promise<Result<TableSource, TableEngineError>> => {
    const d = await duckDb();
    if (!d.ok) {
      return d;
    }
    const duck = d.value;
    const fileName = nextName("import", format);
    const registered = await registerFile(duck, fileName, file);
    if (!registered.ok) {
      return err(readFailed(registered.error));
    }
    const close = async (): Promise<void> => {
      await dropFile(duck, fileName);
    };
    const described =
      format === "csv" ? await csvColumns(duck, fileName) : await parquetColumns(duck, fileName);
    if (!described.ok) {
      await close();
      return described;
    }
    const { source, columns } = described.value;
    const sqlNameOf = new Map(columns.map((c) => [c.name, c.sqlName]));
    /** 計画の列（利用者の列名）を、DuckDB の列名つきにする */
    const sqlColumns = (planned: readonly ColumnSchema[]): readonly SqlColumn[] =>
      planned.map((c) => ({ ...c, sqlName: sqlNameOf.get(c.name) ?? c.name }));

    const readJoinValues = async (
      plan: TableJoinPlan,
    ): Promise<Result<Readonly<Record<string, ColumnValues>>, TableEngineError>> => {
      const result = await query(duck, joinValuesSql(source, sqlColumns(plan.joinColumns)));
      if (!result.ok) {
        return err(readFailed(result.error));
      }
      const values: Record<string, ColumnValues> = {};
      for (const column of plan.joinColumns) {
        const raw = columnValues(result.value, column.name);
        if (raw === null) {
          return err({ kind: "read-failed", message: `列 ${column.name} を読めない` });
        }
        const converted = toColumnValues(raw, column);
        if (!converted.ok) {
          return converted;
        }
        values[column.name] = converted.value;
      }
      return ok(values);
    };

    const writeNormalized = async (
      plan: TableJoinPlan,
    ): Promise<Result<Uint8Array, TableEngineError>> => {
      const outName = nextName("normalized", "parquet");
      const written = await query(
        duck,
        normalizeSql({
          source,
          joinColumns: sqlColumns(plan.joinColumns),
          attributes: sqlColumns(plan.attributes),
          outFile: outName,
        }),
      );
      if (!written.ok) {
        return err(readFailed(written.error));
      }
      const bytes = await readFileBytes(duck, outName);
      await dropFile(duck, outName);
      return bytes.ok ? bytes : err(engineFailed(bytes.error));
    };

    return ok({
      columns: columns.map(({ name, type }) => ({ name, type })),
      readJoinValues,
      writeNormalized,
      close,
    });
  };

  const assignPoints: TableEngine["assignPoints"] = async (points, geometries) => {
    const n = points.lat.length;
    const codes: (string | null)[] = new Array<string | null>(n).fill(null);
    if (geometries.length === 0 || n === 0) {
      return ok({ codes });
    }
    const d = await duckDb();
    if (!d.ok) {
      return d;
    }
    const duck = d.value;
    spatial ??= loadSpatial(duck);
    const loaded = await spatial;
    if (!loaded.ok) {
      spatial = null;
      return err(engineFailed(loaded.error));
    }
    const geometryFiles: string[] = [];
    for (const { prefCode, bytes } of geometries) {
      const name = `rjm-admin-geom-${prefCode}.parquet`;
      if (!registeredGeometries.has(name)) {
        const registered = await registerFile(duck, name, bytes);
        if (!registered.ok) {
          return err(engineFailed(registered.error));
        }
        registeredGeometries.add(name);
      }
      geometryFiles.push(name);
    }
    const pointsName = nextName("points", "csv");
    const registered = await registerFile(
      duck,
      pointsName,
      new TextEncoder().encode(pointsCsv(points.lat, points.lon)),
    );
    if (!registered.ok) {
      return err(engineFailed(registered.error));
    }
    const result = await query(duck, assignPointsSql(pointsName, geometryFiles));
    await dropFile(duck, pointsName);
    if (!result.ok) {
      return err(engineFailed(result.error));
    }
    const indices = columnValues(result.value, "i") ?? [];
    const found = columnValues(result.value, "code") ?? [];
    for (const [row, i] of indices.entries()) {
      const code = found[row];
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= n) {
        return err({ kind: "engine-failed", message: "割り当ての結果の点の番号が範囲の外" });
      }
      if (typeof code !== "string") {
        return err({ kind: "engine-failed", message: "割り当ての結果の団体コードが文字列でない" });
      }
      codes[i] = code;
    }
    return ok({ codes });
  };

  const stop = async (): Promise<void> => {
    const current = started;
    started = null;
    spatial = null;
    registeredGeometries.clear();
    const result = await current;
    if (result?.ok) {
      await stopDuckDb(result.value);
    }
  };

  return { openTable, assignPoints, stop };
};
