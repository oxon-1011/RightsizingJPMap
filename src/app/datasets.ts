// 取り込んだデータを OPFS から読み直し、結合の集計を作って持っておく（docs/design/user-data.md の「永続化」「結合」）。
// 正規化した Parquet は DuckDB を使わずに hyparquet で読む。DuckDB-WASM は取り込むときだけ読み込む（D4）。
// データの中身は id ごとに変わらないので、id で持ち、目録から消えたものだけを捨てる。

import { checkGeoJson } from "../core/accept/geojson";
import type { ColumnArray } from "../core/data/schema";
import { type Columns, numericColumn, stringColumn } from "../core/indicators/columns";
import type { PointAdminAssignment } from "../core/join/admin";
import {
  aggregateByCode,
  aggregateByMesh,
  aggregatePointsByMesh,
  type CodeAggregate,
  type MeshAggregate,
  type NumericColumns,
} from "../core/join/aggregate";
import { buildMeshGeometry, type MeshGeometry } from "../core/mesh/geometry";
import { err, ok, type Result } from "../core/result";
import {
  type DatasetEntry,
  datasetFileName,
  STORED_JOIN_COLUMNS,
  summableColumns,
} from "../core/storage/manifest";
import { type OverlayGeoJson, parseOverlayGeoJson } from "../io/deck-layers";
import type { DatasetStorage } from "../io/opfs";
import { openParquetBuffer, readParquetColumns } from "../io/parquet";
import type { AppError } from "./ports";

/** OPFS から読み直したデータ。表と点は結合用の列と数値の列、線と面は地図に渡す GeoJSON */
export type LoadedDataset =
  | { readonly kind: "code"; readonly codes: readonly string[]; readonly numeric: NumericColumns }
  | { readonly kind: "mesh"; readonly meshes: Uint32Array; readonly numeric: NumericColumns }
  | {
      readonly kind: "point";
      readonly lat: Float64Array;
      readonly lon: Float64Array;
      readonly numeric: NumericColumns;
    }
  | { readonly kind: "shape"; readonly data: OverlayGeoJson };

/** メッシュに結合した集計と、集計したメッシュの形。ベースデータにないメッシュも描く */
export type MeshJoin = { readonly aggregate: MeshAggregate; readonly geometry: MeshGeometry };

/** UTF-8 のバイト列を JSON として読む。UTF-8 でないか、JSON でなければ失敗 */
export const decodeJson = (bytes: Uint8Array): Result<unknown, string> => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return err("UTF-8 として読めない");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
};

/** 正規化した Parquet の結合用の列の名前。表の目録の kind と join から決まる */
const storedJoinColumnNames = (entry: DatasetEntry): readonly string[] => {
  const kind = entry.kind === "point" ? "point" : entry.join.includes("mesh") ? "mesh" : "code";
  return STORED_JOIN_COLUMNS[kind].map((c) => c.name);
};

const columnNamed = (columns: Columns, name: string): ColumnArray | undefined => columns[name];

/** 数値の列を、行の数をそろえて取り出す */
const numericColumnsOf = (
  columns: Columns,
  names: readonly string[],
  rows: number,
): Result<NumericColumns, string> => {
  const entries: [string, ArrayLike<number>][] = [];
  for (const name of names) {
    const column = numericColumn(columns, name, rows);
    if (!column.ok) {
      return err(JSON.stringify(column.error));
    }
    entries.push([name, column.value]);
  }
  return ok(Object.fromEntries(entries));
};

const decodeParquet = async (
  entry: DatasetEntry,
  bytes: Uint8Array,
): Promise<Result<LoadedDataset, string>> => {
  const opened = await openParquetBuffer(bytes.slice().buffer);
  if (!opened.ok) {
    return err(JSON.stringify(opened.error));
  }
  const joinNames = storedJoinColumnNames(entry);
  const numericNames = summableColumns(entry);
  const read = await readParquetColumns(opened.value, [...joinNames, ...numericNames]);
  if (!read.ok) {
    return err(JSON.stringify(read.error));
  }
  const columns: Columns = Object.fromEntries(read.value.columns);
  const rows = read.value.numRows;
  const numeric = numericColumnsOf(columns, numericNames, rows);
  if (!numeric.ok) {
    return numeric;
  }
  if (entry.kind === "point") {
    const lat = columnNamed(columns, "lat");
    const lon = columnNamed(columns, "lon");
    return lat instanceof Float64Array && lon instanceof Float64Array
      ? ok({ kind: "point", lat, lon, numeric: numeric.value })
      : err("lat 列か lon 列が DOUBLE でない");
  }
  if (entry.join.includes("mesh")) {
    const meshes = columnNamed(columns, "mesh");
    return meshes instanceof Uint32Array
      ? ok({ kind: "mesh", meshes, numeric: numeric.value })
      : err("mesh 列が UINTEGER でない");
  }
  const codes = stringColumn(columns, "code", rows);
  return codes.ok
    ? ok({ kind: "code", codes: codes.value, numeric: numeric.value })
    : err(JSON.stringify(codes.error));
};

const decodeGeoJson = (entry: DatasetEntry, bytes: Uint8Array): Result<LoadedDataset, string> => {
  if (entry.kind !== "point") {
    const parsed = parseOverlayGeoJson(bytes);
    return parsed.ok ? ok({ kind: "shape", data: parsed.value }) : err(parsed.error.message);
  }
  // 点は CSV の点と同じ集計に通すので、座標と数値の属性を列にする。取り込んだときと同じ検査を通す
  const json = decodeJson(bytes);
  if (!json.ok) {
    return json;
  }
  const checked = checkGeoJson(json.value);
  if (!checked.ok) {
    return err(JSON.stringify(checked.error));
  }
  const { points } = checked.value;
  return points === null
    ? err("点の GeoJSON でない")
    : ok({ kind: "point", lat: points.lat, lon: points.lon, numeric: points.numeric });
};

/** OPFS のデータのファイルを、目録の項目に従って読む */
export const decodeDataset = (
  entry: DatasetEntry,
  bytes: Uint8Array,
): Promise<Result<LoadedDataset, string>> => {
  switch (entry.stored_format) {
    case "parquet":
      return decodeParquet(entry, bytes);
    case "geojson":
      return Promise.resolve(decodeGeoJson(entry, bytes));
    default: {
      const unreachable: never = entry.stored_format;
      return unreachable;
    }
  }
};

export type DatasetCache = {
  readonly load: (entry: DatasetEntry) => Promise<Result<LoadedDataset, AppError>>;
  readonly meshJoin: (entry: DatasetEntry) => Promise<Result<MeshJoin, AppError>>;
  readonly codeJoin: (entry: DatasetEntry) => Promise<Result<CodeAggregate, AppError>>;
  /** 目録にある id のものだけを残す */
  readonly retain: (ids: ReadonlySet<string>) => void;
};

/** id ごとの Promise を持つ。失敗した結果は捨て、次に求められたときに作り直す */
const keyed = <T>() => {
  const cache = new Map<string, Promise<Result<T, AppError>>>();
  return {
    get: (id: string, create: () => Promise<Result<T, AppError>>) => {
      const cached = cache.get(id);
      if (cached !== undefined) {
        return cached;
      }
      const created = create();
      cache.set(id, created);
      void created.then((r) => {
        if (!r.ok && cache.get(id) === created) {
          cache.delete(id);
        }
      });
      return created;
    },
    retain: (ids: ReadonlySet<string>) => {
      for (const id of cache.keys()) {
        if (!ids.has(id)) {
          cache.delete(id);
        }
      }
    },
  };
};

const datasetError = (entry: DatasetEntry, message: string): AppError => ({
  kind: "dataset",
  id: entry.id,
  message,
});

export const createDatasetCache = (deps: {
  /** いまの置き場所。起動する前は null */
  readonly storage: () => DatasetStorage | null;
  /** 点を行政区域に割り当てる（assign.ts） */
  readonly assignPoints: (
    lat: Float64Array,
    lon: Float64Array,
  ) => Promise<Result<PointAdminAssignment, AppError>>;
}): DatasetCache => {
  const loaded = keyed<LoadedDataset>();
  const meshJoins = keyed<MeshJoin>();
  const codeJoins = keyed<CodeAggregate>();

  const load = (entry: DatasetEntry) =>
    loaded.get(entry.id, async () => {
      const storage = deps.storage();
      if (storage === null) {
        return err(datasetError(entry, "置き場所を開いていない"));
      }
      const bytes = await storage.readDataset(datasetFileName(entry));
      if (!bytes.ok) {
        return err({ kind: "storage", error: bytes.error });
      }
      const decoded = await decodeDataset(entry, bytes.value);
      return decoded.ok ? decoded : err(datasetError(entry, decoded.error));
    });

  const meshJoin = (entry: DatasetEntry) =>
    meshJoins.get(entry.id, async () => {
      const data = await load(entry);
      if (!data.ok) {
        return data;
      }
      const d = data.value;
      const aggregate =
        d.kind === "mesh"
          ? aggregateByMesh(d.meshes, d.numeric)
          : d.kind === "point"
            ? aggregatePointsByMesh(d.lat, d.lon, d.numeric)
            : null;
      return aggregate === null
        ? err(datasetError(entry, "メッシュに結合できない"))
        : ok({ aggregate, geometry: buildMeshGeometry(aggregate.keys) });
    });

  const codeJoin = (entry: DatasetEntry) =>
    codeJoins.get(entry.id, async () => {
      const data = await load(entry);
      if (!data.ok) {
        return data;
      }
      const d = data.value;
      if (d.kind === "code") {
        return ok(aggregateByCode(d.codes, d.numeric));
      }
      if (d.kind !== "point") {
        return err(datasetError(entry, "行政区域に結合できない"));
      }
      const assigned = await deps.assignPoints(d.lat, d.lon);
      return assigned.ok ? ok(aggregateByCode(assigned.value.codes, d.numeric)) : assigned;
    });

  const retain = (ids: ReadonlySet<string>): void => {
    loaded.retain(ids);
    meshJoins.retain(ids);
    codeJoins.retain(ids);
  };

  return { load, meshJoin, codeJoin, retain };
};
