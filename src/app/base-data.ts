// ベースデータ（生成物）の読み込みと、読んだものの持ち回り（docs/design/map-and-hosting.md の「描画の流れ」）。
// mesh 列と形は一度だけ作り、指標の列は最近使ったものを持っておく。
// どれも読み込み中の Promise を持つので、同じものを同時に求められても1回しか読まない。

import type { ColumnArray } from "../core/data/schema";
import {
  type AdminGeomIndex,
  AGE_GROUPS,
  DATA_FILES,
  MUNICIPAL_COLUMNS,
  meshColumn,
} from "../core/data/schema";
import type { DataFile } from "../core/data/url";
import type { Columns } from "../core/indicators/columns";
import {
  type MunicipalTable,
  paintedMunicipalCodes,
  parseMunicipalTable,
} from "../core/indicators/municipal";
import { parseAdminGeomIndex } from "../core/join/admin";
import { indexMeshes, type MeshLookup } from "../core/join/per-population";
import { buildMeshGeometry, type MeshGeometry } from "../core/mesh/geometry";
import { err, ok, type Result } from "../core/result";
import { type ParquetError, type ParquetFile, readParquetColumns } from "../io/parquet";
import type { AppError, AppPorts } from "./ports";

/** 全国のメッシュ。codes は mesh_indicators.parquet の行の順 */
export type MeshBase = {
  readonly codes: Uint32Array;
  readonly geometry: MeshGeometry;
  readonly lookup: MeshLookup;
};

export type MunicipalBase = {
  readonly table: MunicipalTable;
  /** 地図で塗る単位の団体コード。自前データの code 列の検査と、値のない地域を埋めるのに使う */
  readonly paintedCodes: ReadonlySet<string>;
};

export type BaseData = {
  readonly mesh: () => Promise<Result<MeshBase, AppError>>;
  /** mesh_indicators.parquet の列（mesh 列を除く）。行の順は MeshBase.codes と同じ */
  readonly meshColumns: (names: readonly string[]) => Promise<Result<Columns, AppError>>;
  readonly municipal: () => Promise<Result<MunicipalBase, AppError>>;
  readonly adminGeomIndex: () => Promise<Result<AdminGeomIndex, AppError>>;
};

/** 持っておく指標の列の数。1列は約 0.7MB（17.7万メッシュの FLOAT）なので、16 列で約 11MB */
export const MESH_COLUMN_CACHE_SIZE = 16;

const parquetMessage = (error: ParquetError): string =>
  "message" in error ? `${error.kind}: ${error.message}` : JSON.stringify(error);

const baseError = (file: DataFile, message: string): AppError => ({
  kind: "base-data",
  file,
  message,
});

/** 結果が失敗なら、次に求められたときに読み直せるよう、持っている Promise を捨てる */
const memo = <T>(load: () => Promise<Result<T, AppError>>) => {
  let pending: Promise<Result<T, AppError>> | null = null;
  return (): Promise<Result<T, AppError>> => {
    if (pending === null) {
      const started = load();
      pending = started;
      void started.then((result) => {
        if (!result.ok && pending === started) {
          pending = null;
        }
      });
    }
    return pending;
  };
};

const MUNICIPAL_TABLE_COLUMNS: readonly string[] = [
  MUNICIPAL_COLUMNS.code,
  MUNICIPAL_COLUMNS.areaType,
  MUNICIPAL_COLUMNS.year,
  MUNICIPAL_COLUMNS.pop,
  ...AGE_GROUPS.map(MUNICIPAL_COLUMNS.age),
];

export const createBaseData = (
  ports: Pick<AppPorts<unknown>, "openBaseParquet" | "fetchBaseJson">,
): BaseData => {
  const meshFile = memo(async (): Promise<Result<ParquetFile, AppError>> => {
    const opened = await ports.openBaseParquet(DATA_FILES.meshIndicators);
    return opened.ok
      ? opened
      : err(baseError(DATA_FILES.meshIndicators, parquetMessage(opened.error)));
  });

  const readMeshColumns = async (
    names: readonly string[],
  ): Promise<Result<ReadonlyMap<string, ColumnArray>, AppError>> => {
    const file = await meshFile();
    if (!file.ok) {
      return file;
    }
    const read = await readParquetColumns(file.value, names);
    return read.ok
      ? ok(read.value.columns)
      : err(baseError(DATA_FILES.meshIndicators, parquetMessage(read.error)));
  };

  const mesh = memo(async (): Promise<Result<MeshBase, AppError>> => {
    const read = await readMeshColumns([meshColumn.mesh]);
    if (!read.ok) {
      return read;
    }
    const codes = read.value.get(meshColumn.mesh);
    if (!(codes instanceof Uint32Array)) {
      return err(baseError(DATA_FILES.meshIndicators, "mesh 列が UINTEGER でない"));
    }
    return ok({ codes, geometry: buildMeshGeometry(codes), lookup: indexMeshes(codes) });
  });

  /** 列の名前から、読み込み中か読み終えた列への対応。Map の順を使った順にして、古いものから捨てる */
  const columnCache = new Map<string, Promise<Result<ColumnArray, AppError>>>();

  const touch = (name: string, column: Promise<Result<ColumnArray, AppError>>): void => {
    columnCache.delete(name);
    columnCache.set(name, column);
    while (columnCache.size > MESH_COLUMN_CACHE_SIZE) {
      const oldest = columnCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      columnCache.delete(oldest);
    }
  };

  const meshColumns = async (names: readonly string[]): Promise<Result<Columns, AppError>> => {
    const missing = names.filter((n) => !columnCache.has(n));
    // 足りない列はまとめて1回で読む
    const read = missing.length > 0 ? readMeshColumns(missing) : null;
    const pending = names.map((name): [string, Promise<Result<ColumnArray, AppError>>] => {
      const cached = columnCache.get(name);
      if (cached !== undefined || read === null) {
        return [name, cached ?? Promise.resolve(err(baseError(DATA_FILES.meshIndicators, name)))];
      }
      const column = read.then((r): Result<ColumnArray, AppError> => {
        if (!r.ok) {
          return r;
        }
        const value = r.value.get(name);
        return value === undefined
          ? err(baseError(DATA_FILES.meshIndicators, `列 ${name} を読めなかった`))
          : ok(value);
      });
      void column.then((r) => {
        if (!r.ok && columnCache.get(name) === column) {
          columnCache.delete(name);
        }
      });
      return [name, column];
    });
    for (const [name, column] of pending) {
      touch(name, column);
    }
    const entries: [string, ColumnArray][] = [];
    for (const [name, column] of pending) {
      const result = await column;
      if (!result.ok) {
        return result;
      }
      entries.push([name, result.value]);
    }
    return ok(Object.fromEntries(entries));
  };

  const municipal = memo(async (): Promise<Result<MunicipalBase, AppError>> => {
    const file = DATA_FILES.municipalIndicators;
    const opened = await ports.openBaseParquet(file);
    if (!opened.ok) {
      return err(baseError(file, parquetMessage(opened.error)));
    }
    const read = await readParquetColumns(opened.value, MUNICIPAL_TABLE_COLUMNS);
    if (!read.ok) {
      return err(baseError(file, parquetMessage(read.error)));
    }
    const table = parseMunicipalTable(Object.fromEntries(read.value.columns));
    return table.ok
      ? ok({ table: table.value, paintedCodes: paintedMunicipalCodes(table.value) })
      : err(baseError(file, JSON.stringify(table.error)));
  });

  const adminGeomIndex = memo(async (): Promise<Result<AdminGeomIndex, AppError>> => {
    const file = DATA_FILES.adminGeomIndex;
    const fetched = await ports.fetchBaseJson(file);
    if (!fetched.ok) {
      return err(baseError(file, fetched.error.message));
    }
    const parsed = parseAdminGeomIndex(fetched.value);
    return parsed.ok ? parsed : err(baseError(file, JSON.stringify(parsed.error)));
  });

  return { mesh, meshColumns, municipal, adminGeomIndex };
};
