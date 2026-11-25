// ベースデータ（生成物）の読み込みと、読んだものの持ち回り（docs/design/map-and-hosting.md の「描画の流れ」）。
// mesh 列と形は地域ごとに一度だけ作り、指標の列は最近使ったものを持っておく。
// 地域モード（docs/design/map-and-hosting.md）では、都道府県ごとのファイルだけを読み、全国のファイルは読まない。
// どれも読み込み中の Promise を持つので、同じものを同時に求められても1回しか読まない。

import type { ColumnArray } from "../core/data/schema";
import {
  type AdminGeomIndex,
  AGE_GROUPS,
  DATA_FILES,
  MUNICIPAL_COLUMNS,
  meshColumn,
  meshPrefFile,
} from "../core/data/schema";
import type { DataFile } from "../core/data/url";
import type { Columns } from "../core/indicators/columns";
import {
  type MunicipalNames,
  type MunicipalTable,
  paintedMunicipalCodes,
  parseMunicipalNames,
  parseMunicipalTable,
} from "../core/indicators/municipal";
import { parseAdminGeomIndex } from "../core/join/admin";
import { indexMeshes, type MeshLookup } from "../core/join/per-population";
import { buildMeshGeometry, type MeshGeometry } from "../core/mesh/geometry";
import { type MeshMerge, mergeColumn, mergeMeshCodes } from "../core/mesh/merge";
import { isWholeCountry, type Region, regionKey } from "../core/region/region";
import { err, ok, type Result } from "../core/result";
import { type ParquetError, type ParquetFile, readParquetColumns } from "../io/parquet";
import type { AppError, AppPorts } from "./ports";

/** 全国か、地域のメッシュ。codes はメッシュコードの昇順（全国では mesh_indicators.parquet の行の順） */
export type MeshBase = {
  readonly codes: Uint32Array;
  readonly geometry: MeshGeometry;
  readonly lookup: MeshLookup;
};

export type MunicipalBase = {
  readonly table: MunicipalTable;
  /** 地図で塗る単位の団体コード。自前データの code 列の検査と、値のない地域を埋めるのに使う */
  readonly paintedCodes: ReadonlySet<string>;
  /** 地域と都道府県の名前。ホバーのカードに出す */
  readonly names: MunicipalNames;
};

export type BaseData = {
  /** 地域のメッシュ。全国なら mesh_indicators.parquet、地域なら都道府県ごとのファイルだけを読む */
  readonly mesh: (region: Region) => Promise<Result<MeshBase, AppError>>;
  /** メッシュの指標の列（mesh 列を除く）。行の順は、同じ地域の MeshBase.codes と同じ */
  readonly meshColumns: (
    region: Region,
    names: readonly string[],
  ) => Promise<Result<Columns, AppError>>;
  readonly municipal: () => Promise<Result<MunicipalBase, AppError>>;
  readonly adminGeomIndex: () => Promise<Result<AdminGeomIndex, AppError>>;
};

/**
 * ファイルごと（と、複数の都道府県を合わせた地域ごと）に持っておく指標の列の数。
 * 全国の1列は約 0.7MB（17.7万メッシュの FLOAT）なので、16 列で約 11MB
 */
export const MESH_COLUMN_CACHE_SIZE = 16;

/**
 * 持っておくメッシュの読み口（地域）の数。地域を切り替えた直後は、前の地域の塗り分けのホバーが
 * まだ前の地域を引くので、いまの地域と前の地域の2つを持つ
 */
export const MESH_SOURCE_CACHE_SIZE = 2;

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
  MUNICIPAL_COLUMNS.name,
  MUNICIPAL_COLUMNS.areaType,
  MUNICIPAL_COLUMNS.year,
  MUNICIPAL_COLUMNS.pop,
  ...AGE_GROUPS.map(MUNICIPAL_COLUMNS.age),
];

type ColumnResult = Result<ColumnArray, AppError>;

/**
 * 列を名前ごとに持ち回る読み口を作る。足りない列はまとめて1回で read に求め、最近使った
 * MESH_COLUMN_CACHE_SIZE 個を持つ。読み込み中の Promise を持つので、同じ列を同時に求められても1回しか読まない
 */
const cachedColumns = (
  read: (names: readonly string[]) => Promise<Result<Columns, AppError>>,
  file: DataFile,
): ((names: readonly string[]) => Promise<Result<Columns, AppError>>) => {
  /** 列の名前から、読み込み中か読み終えた列への対応。Map の順を使った順にして、古いものから捨てる */
  const cache = new Map<string, Promise<ColumnResult>>();

  const touch = (name: string, column: Promise<ColumnResult>): void => {
    cache.delete(name);
    cache.set(name, column);
    while (cache.size > MESH_COLUMN_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  };

  return async (names) => {
    const missing = names.filter((n) => !cache.has(n));
    const loading = missing.length > 0 ? read(missing) : null;
    const pending = names.map((name): [string, Promise<ColumnResult>] => {
      const cached = cache.get(name);
      if (cached !== undefined || loading === null) {
        return [name, cached ?? Promise.resolve(err(baseError(file, name)))];
      }
      const column = loading.then((r): ColumnResult => {
        if (!r.ok) {
          return r;
        }
        const value = r.value[name];
        return value === undefined ? err(baseError(file, `列 ${name} を読めなかった`)) : ok(value);
      });
      void column.then((r) => {
        if (!r.ok && cache.get(name) === column) {
          cache.delete(name);
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
};

/** メッシュのファイル1つの読み口。全国のファイルか、都道府県ごとのファイル */
type MeshFile = {
  readonly file: DataFile;
  /** mesh 列。ファイルの行の順 */
  readonly codes: () => Promise<Result<Uint32Array, AppError>>;
  /** 指標の列（mesh 列を除く）。ファイルの行の順 */
  readonly columns: (names: readonly string[]) => Promise<Result<Columns, AppError>>;
};

type MeshPorts = Pick<AppPorts<unknown>, "openBaseParquet">;

const createMeshFile = (ports: MeshPorts, file: DataFile): MeshFile => {
  const opened = memo(async (): Promise<Result<ParquetFile, AppError>> => {
    const result = await ports.openBaseParquet(file);
    return result.ok ? result : err(baseError(file, parquetMessage(result.error)));
  });

  const read = async (names: readonly string[]): Promise<Result<Columns, AppError>> => {
    const parquet = await opened();
    if (!parquet.ok) {
      return parquet;
    }
    const columns = await readParquetColumns(parquet.value, names);
    return columns.ok
      ? ok(Object.fromEntries(columns.value.columns))
      : err(baseError(file, parquetMessage(columns.error)));
  };

  const codes = memo(async (): Promise<Result<Uint32Array, AppError>> => {
    const columns = await read([meshColumn.mesh]);
    if (!columns.ok) {
      return columns;
    }
    const mesh = columns.value[meshColumn.mesh];
    return mesh instanceof Uint32Array
      ? ok(mesh)
      : err(baseError(file, "mesh 列が UINTEGER でない"));
  });

  return { file, codes, columns: cachedColumns(read, file) };
};

/** メッシュの読み口。全国か、地域（都道府県の組）のどちらか1つのメッシュの並びを持つ */
type MeshSource = {
  readonly mesh: () => Promise<Result<MeshBase, AppError>>;
  readonly meshColumns: (names: readonly string[]) => Promise<Result<Columns, AppError>>;
};

/** 結果を、失敗があれば最初の失敗に、なければ値の配列にまとめる */
const collect = <T>(results: readonly Result<T, AppError>[]): Result<T[], AppError> => {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    values.push(result.value);
  }
  return ok(values);
};

/**
 * メッシュのファイルの組から、メッシュの読み口を作る。
 * ファイルが1つ（全国か、都道府県が1つ）なら、ファイルの列をそのまま使う。
 * 2つ以上なら、mesh 列から合わせた並びを作り、列も同じ並びに合わせる（core の mesh/merge.ts）。
 * 列はファイルごとに持ち回るので、地域に都道府県を足したときに読むのは、足した都道府県のファイルだけである。
 */
const createMeshSource = (first: MeshFile, rest: readonly MeshFile[]): MeshSource => {
  if (rest.length === 0) {
    const mesh = memo(async (): Promise<Result<MeshBase, AppError>> => {
      const codes = await first.codes();
      return codes.ok
        ? ok({
            codes: codes.value,
            geometry: buildMeshGeometry(codes.value),
            lookup: indexMeshes(codes.value),
          })
        : codes;
    });
    return { mesh, meshColumns: first.columns };
  }
  const files = [first, ...rest];

  const merged = memo(async (): Promise<Result<{ base: MeshBase; merge: MeshMerge }, AppError>> => {
    const parts = collect(await Promise.all(files.map((f) => f.codes())));
    if (!parts.ok) {
      return parts;
    }
    const merge = mergeMeshCodes(parts.value);
    const { codes } = merge;
    return ok({
      base: { codes, geometry: buildMeshGeometry(codes), lookup: indexMeshes(codes) },
      merge,
    });
  });

  const mesh = async (): Promise<Result<MeshBase, AppError>> => {
    const result = await merged();
    return result.ok ? ok(result.value.base) : result;
  };

  /** すべてのファイルから列を読み、合わせた並びにする */
  const readMerged = async (names: readonly string[]): Promise<Result<Columns, AppError>> => {
    const order = await merged();
    if (!order.ok) {
      return order;
    }
    const parts = collect(await Promise.all(files.map((f) => f.columns(names))));
    if (!parts.ok) {
      return parts;
    }
    const entries: [string, ColumnArray][] = [];
    for (const name of names) {
      const columns: ColumnArray[] = [];
      for (const part of parts.value) {
        const column = part[name];
        if (column === undefined) {
          return err(baseError(first.file, `列 ${name} を読めなかった`));
        }
        columns.push(column);
      }
      const column = mergeColumn(columns, order.value.merge);
      if (!column.ok) {
        return err(baseError(first.file, `列 ${name}: ${JSON.stringify(column.error)}`));
      }
      entries.push([name, column.value]);
    }
    return ok(Object.fromEntries(entries));
  };

  return { mesh, meshColumns: cachedColumns(readMerged, first.file) };
};

/** 地域のメッシュのファイル。全国は1つのファイル、地域は都道府県ごとのファイル */
const meshFilesOf = (region: Region): readonly DataFile[] =>
  isWholeCountry(region) ? [DATA_FILES.meshIndicators] : region.map(meshPrefFile);

export const createBaseData = (
  ports: Pick<AppPorts<unknown>, "openBaseParquet" | "fetchBaseJson">,
): BaseData => {
  /** ファイルの読み口。持っている地域のどれかが使うものだけを持つ */
  const meshFiles = new Map<DataFile, MeshFile>();
  /** 地域から、そのメッシュの読み口と、使うファイルへの対応。Map の順を使った順にして、古いものから捨てる */
  const meshSources = new Map<
    string,
    { readonly source: MeshSource; readonly files: readonly DataFile[] }
  >();

  const meshFileOf = (file: DataFile): MeshFile => {
    const existing = meshFiles.get(file);
    if (existing !== undefined) {
      return existing;
    }
    const created = createMeshFile(ports, file);
    meshFiles.set(file, created);
    return created;
  };

  const meshSourceOf = (region: Region): MeshSource => {
    const key = regionKey(region);
    const entry =
      meshSources.get(key) ??
      (() => {
        const files = meshFilesOf(region);
        const [first, ...rest] = files.map(meshFileOf);
        if (first === undefined) {
          throw new Error("メッシュのファイルが1つもない");
        }
        return { source: createMeshSource(first, rest), files };
      })();
    meshSources.delete(key);
    meshSources.set(key, entry);
    while (meshSources.size > MESH_SOURCE_CACHE_SIZE) {
      const oldest = meshSources.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      meshSources.delete(oldest);
    }
    // 持っている地域のどれも使わないファイルは、読んだ列ごと捨てる
    const used = new Set([...meshSources.values()].flatMap((e) => e.files));
    for (const file of meshFiles.keys()) {
      if (!used.has(file)) {
        meshFiles.delete(file);
      }
    }
    return entry.source;
  };

  const mesh = (region: Region): Promise<Result<MeshBase, AppError>> => meshSourceOf(region).mesh();

  const meshColumns = (
    region: Region,
    names: readonly string[],
  ): Promise<Result<Columns, AppError>> => meshSourceOf(region).meshColumns(names);

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
    const columns = Object.fromEntries(read.value.columns);
    const table = parseMunicipalTable(columns);
    if (!table.ok) {
      return err(baseError(file, JSON.stringify(table.error)));
    }
    const names = parseMunicipalNames(columns);
    return names.ok
      ? ok({
          table: table.value,
          paintedCodes: paintedMunicipalCodes(table.value),
          names: names.value,
        })
      : err(baseError(file, JSON.stringify(names.error)));
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
