// OPFS に置く目録（manifest.json）の型、検査、操作（docs/design/user-data.md の「永続化」）。
// io は目録とデータを文字列とバイト列として読み書きするだけで、解釈はここで行う。

import type { AcceptedGeoJson, GeometryKind } from "../accept/geojson";
import type { AcceptedTable, ColumnSchema, ColumnType, TableJoinKind } from "../accept/table";
import { parseHexColor } from "../classify/color";
import { err, ok, type Result } from "../result";

/** 目録の形式の版。形式を変えたら上げ、parseManifest に古い版の読み替えを足す */
export const MANIFEST_SCHEMA_VERSION = 1;

/** OPFS の中の置き場所 */
export const OPFS_PATHS = {
  root: "rjm",
  manifest: "manifest.json",
  datasets: "datasets",
} as const;

/** データの種類。表（code か mesh で結合する）、点、線、面 */
export type DatasetKind = "table" | GeometryKind;

/** 結合先。点はメッシュと行政区域の両方に結合でき、線と面はどこにも結合しない（D9、D11） */
export type JoinTarget = "mesh" | "municipality";

/** datasets/ に置いたファイルの形式。CSV と Parquet は正規化した Parquet、GeoJSON はそのまま */
export type StoredFormat = "parquet" | "geojson";

/** レイヤーの表示設定。size は点の半径、線の幅、面の枠の幅（どれもピクセル） */
export type LayerStyle = {
  readonly color: string;
  readonly size: number;
  readonly visible: boolean;
};

export type DatasetEntry = {
  readonly id: string;
  /** 利用者が付けた名前 */
  readonly name: string;
  /** 元のファイルの名前と大きさ（バイト） */
  readonly source: { readonly name: string; readonly size: number };
  /** 取り込んだ日時（ISO 8601）。時刻は core で読まないので、app が渡す */
  readonly imported_at: string;
  readonly kind: DatasetKind;
  readonly join: readonly JoinTarget[];
  /** 列や属性の名前と型。結合用の列を含む */
  readonly columns: readonly ColumnSchema[];
  /** 行の数（表）か地物の数（GeoJSON）。受け入れの検査が空のデータを拒否するので 1 以上 */
  readonly count: number;
  readonly style: LayerStyle;
  readonly stored_format: StoredFormat;
};

export type Manifest = {
  readonly schema_version: typeof MANIFEST_SCHEMA_VERSION;
  readonly datasets: readonly DatasetEntry[];
};

export const EMPTY_MANIFEST: Manifest = { schema_version: MANIFEST_SCHEMA_VERSION, datasets: [] };

export type ManifestError =
  | { readonly kind: "unsupported-version"; readonly version: unknown }
  /** path は誤りのある場所（"datasets[2].style.color" など） */
  | { readonly kind: "invalid"; readonly path: string }
  | { readonly kind: "duplicate-id"; readonly id: string };

/** データの識別子。ファイル名に使うので、英数字、ハイフン、下線の 1〜64 文字に限る */
export const isDatasetId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id);

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const DATASET_KINDS: readonly string[] = ["table", "point", "line", "polygon"];
const JOIN_TARGETS: readonly string[] = ["mesh", "municipality"];
const STORED_FORMATS: readonly string[] = ["parquet", "geojson"];
const COLUMN_TYPES: readonly string[] = ["string", "integer", "float", "other"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const oneOf = <T extends string>(values: readonly string[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value);

/** 検査の途中で誤りを見つけたら、その場所を投げずに返すための型 */
type Check<T> = Result<T, ManifestError>;

const invalid = (path: string): Check<never> => err({ kind: "invalid", path });

const parseColumn = (value: unknown, path: string): Check<ColumnSchema> => {
  if (!isRecord(value)) {
    return invalid(path);
  }
  const { name, type } = value;
  if (typeof name !== "string") {
    return invalid(`${path}.name`);
  }
  if (!oneOf<ColumnType>(COLUMN_TYPES, type)) {
    return invalid(`${path}.type`);
  }
  return ok({ name, type });
};

const parseStyle = (value: unknown, path: string): Check<LayerStyle> => {
  if (!isRecord(value)) {
    return invalid(path);
  }
  const { color, size, visible } = value;
  if (typeof color !== "string" || parseHexColor(color) === null) {
    return invalid(`${path}.color`);
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return invalid(`${path}.size`);
  }
  if (typeof visible !== "boolean") {
    return invalid(`${path}.visible`);
  }
  return ok({ color, size, visible });
};

const parseEntry = (value: unknown, path: string): Check<DatasetEntry> => {
  if (!isRecord(value)) {
    return invalid(path);
  }
  const { id, name, source, imported_at, kind, join, columns, count, style, stored_format } = value;
  if (typeof id !== "string" || !isDatasetId(id)) {
    return invalid(`${path}.id`);
  }
  if (typeof name !== "string") {
    return invalid(`${path}.name`);
  }
  if (!isRecord(source)) {
    return invalid(`${path}.source`);
  }
  const { name: sourceName, size: sourceSize } = source;
  if (typeof sourceName !== "string") {
    return invalid(`${path}.source.name`);
  }
  if (typeof sourceSize !== "number" || !Number.isInteger(sourceSize) || sourceSize < 0) {
    return invalid(`${path}.source.size`);
  }
  if (typeof imported_at !== "string" || !ISO_8601.test(imported_at)) {
    return invalid(`${path}.imported_at`);
  }
  if (!oneOf<DatasetKind>(DATASET_KINDS, kind)) {
    return invalid(`${path}.kind`);
  }
  if (!isArray(join) || !join.every((t) => oneOf<JoinTarget>(JOIN_TARGETS, t))) {
    return invalid(`${path}.join`);
  }
  if (!isArray(columns)) {
    return invalid(`${path}.columns`);
  }
  const parsedColumns: ColumnSchema[] = [];
  for (const [i, column] of columns.entries()) {
    const parsed = parseColumn(column, `${path}.columns[${i}]`);
    if (!parsed.ok) {
      return parsed;
    }
    parsedColumns.push(parsed.value);
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    return invalid(`${path}.count`);
  }
  const parsedStyle = parseStyle(style, `${path}.style`);
  if (!parsedStyle.ok) {
    return parsedStyle;
  }
  if (!oneOf<StoredFormat>(STORED_FORMATS, stored_format)) {
    return invalid(`${path}.stored_format`);
  }
  return ok({
    id,
    name,
    source: { name: sourceName, size: sourceSize },
    imported_at,
    kind,
    join: join.filter((t): t is JoinTarget => oneOf<JoinTarget>(JOIN_TARGETS, t)),
    columns: parsedColumns,
    count,
    style: parsedStyle.value,
    stored_format,
  });
};

/** JSON.parse した目録を検査する。版が違う、形が違う、同じ id が2つある目録は拒否する */
export const parseManifest = (input: unknown): Result<Manifest, ManifestError> => {
  if (!isRecord(input)) {
    return invalid("");
  }
  const { schema_version, datasets } = input;
  if (schema_version !== MANIFEST_SCHEMA_VERSION) {
    return err({ kind: "unsupported-version", version: schema_version });
  }
  if (!isArray(datasets)) {
    return invalid("datasets");
  }
  const entries: DatasetEntry[] = [];
  const ids = new Set<string>();
  for (const [i, value] of datasets.entries()) {
    const entry = parseEntry(value, `datasets[${i}]`);
    if (!entry.ok) {
      return entry;
    }
    if (ids.has(entry.value.id)) {
      return err({ kind: "duplicate-id", id: entry.value.id });
    }
    ids.add(entry.value.id);
    entries.push(entry.value);
  }
  return ok({ schema_version: MANIFEST_SCHEMA_VERSION, datasets: entries });
};

/** 目録を書き出す文字列にする */
export const serializeManifest = (manifest: Manifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/** datasets/ の中の、データのファイルの名前 */
export const datasetFileName = (entry: Pick<DatasetEntry, "id" | "stored_format">): string =>
  `${entry.id}.${entry.stored_format}`;

/**
 * datasets/ にあるファイルのうち、目録にないものの名前。起動時に io が消す
 * （取り込みの途中でタブが閉じられた場合の残り。docs/design/user-data.md の「書き込みの手順」）。
 */
export const orphanDatasetFiles = (
  manifest: Manifest,
  filesInDatasetsDir: readonly string[],
): readonly string[] => {
  const known = new Set(manifest.datasets.map(datasetFileName));
  return filesInDatasetsDir.filter((name) => !known.has(name));
};

export const addDataset = (
  manifest: Manifest,
  entry: DatasetEntry,
): Result<Manifest, ManifestError> =>
  manifest.datasets.some((d) => d.id === entry.id)
    ? err({ kind: "duplicate-id", id: entry.id })
    : ok({ ...manifest, datasets: [...manifest.datasets, entry] });

export const removeDataset = (manifest: Manifest, id: string): Manifest => ({
  ...manifest,
  datasets: manifest.datasets.filter((d) => d.id !== id),
});

export const updateDatasetStyle = (
  manifest: Manifest,
  id: string,
  style: Partial<LayerStyle>,
): Manifest => ({
  ...manifest,
  datasets: manifest.datasets.map((d) =>
    d.id === id ? { ...d, style: { ...d.style, ...style } } : d,
  ),
});

/**
 * レイヤーの色の候補（D26）。取り込んだ順に、まだ使っていない色を割り当てる。
 * Okabe と Ito の配色を、地図の塗り分けの Orange と離れた色から並べている
 */
export const LAYER_COLORS: readonly string[] = [
  "#0072b2",
  "#009e73",
  "#cc79a7",
  "#56b4e9",
  "#d55e00",
  "#e69f00",
  "#f0e442",
  "#000000",
];

/** まだ使っていない最初の色。すべて使っていれば、データの数で巡回させる */
export const nextLayerColor = (datasets: readonly DatasetEntry[]): string => {
  const used = new Set(datasets.map((d) => d.style.color.toLowerCase()));
  return (
    LAYER_COLORS.find((c) => !used.has(c)) ??
    LAYER_COLORS[datasets.length % LAYER_COLORS.length] ??
    "#000000"
  );
};

/**
 * 種類ごとの size の既定値。取り込むときに目録に書くので、変えても取り込み済みのデータには効かない。
 * 点は濃い塗りの上でも見つけられる半径、面は薄い塗りでも範囲が分かる枠の幅にする。
 */
export const DEFAULT_LAYER_SIZE: Readonly<Record<DatasetKind, number>> = {
  table: 1,
  point: 6,
  line: 2,
  polygon: 2,
};

/** 検査を通ったデータ。表（CSV、Parquet）か GeoJSON */
export type AcceptedDataset =
  | { readonly source: "table"; readonly table: AcceptedTable }
  | { readonly source: "geojson"; readonly geojson: AcceptedGeoJson };

/**
 * 正規化した Parquet での結合用の列の型。io はこの型で書き出す。
 * code は先頭の 0 を保つため文字列、mesh は UINTEGER、lat と lon は DOUBLE にする。
 */
export const STORED_JOIN_COLUMNS: Readonly<Record<TableJoinKind, readonly ColumnSchema[]>> = {
  code: [{ name: "code", type: "string" }],
  mesh: [{ name: "mesh", type: "integer" }],
  point: [
    { name: "lat", type: "float" },
    { name: "lon", type: "float" },
  ],
};

/**
 * 結合用の列の名前。表（CSV と Parquet）は結合用の列も columns に持つので、合計の対象から除く。
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

/** 検査の結果から、目録に書く種類、結合先、列、件数、保存の形式を決める */
export const datasetShape = (
  accepted: AcceptedDataset,
): Pick<DatasetEntry, "kind" | "join" | "columns" | "count" | "stored_format"> => {
  switch (accepted.source) {
    case "table": {
      const join = accepted.table.join.kind;
      return {
        kind: join === "point" ? "point" : "table",
        join:
          join === "code"
            ? ["municipality"]
            : join === "mesh"
              ? ["mesh"]
              : ["mesh", "municipality"],
        columns: [...STORED_JOIN_COLUMNS[join], ...accepted.table.attributes],
        count: accepted.table.rowCount,
        stored_format: "parquet",
      };
    }
    case "geojson": {
      const kind = accepted.geojson.geometryKind;
      return {
        kind,
        join: kind === "point" ? ["mesh", "municipality"] : [],
        columns: accepted.geojson.attributes,
        count: accepted.geojson.featureCount,
        stored_format: "geojson",
      };
    }
    default: {
      const unreachable: never = accepted;
      return unreachable;
    }
  }
};

/** 新しく取り込んだデータの目録の項目を作る。id と日時は app が作って渡す */
export const newDatasetEntry = (args: {
  readonly id: string;
  readonly name: string;
  readonly source: { readonly name: string; readonly size: number };
  readonly importedAt: string;
  readonly accepted: AcceptedDataset;
  readonly existing: readonly DatasetEntry[];
}): DatasetEntry => {
  const shape = datasetShape(args.accepted);
  return {
    id: args.id,
    name: args.name,
    source: args.source,
    imported_at: args.importedAt,
    ...shape,
    style: {
      color: nextLayerColor(args.existing),
      size: DEFAULT_LAYER_SIZE[shape.kind],
      visible: true,
    },
  };
};
