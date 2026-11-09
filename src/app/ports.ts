// app の手続きが使う副作用の口。ブラウザでは browser-ports.ts が io の関数で作り、
// node のテストでは偽物を渡す。手続きの判断は core の関数と create-app.ts にあり、ここには型だけを置く。

import type { ColumnSchema, ColumnValues, TableFormat, TableJoinPlan } from "../core/accept/table";
import type { BBox } from "../core/data/schema";
import type { DataFile } from "../core/data/url";
import type { PointAdminAssignment } from "../core/join/admin";
import type { AdminFillSpec } from "../core/render/admin";
import type { Result } from "../core/result";
import type { ManifestError } from "../core/storage/manifest";
import type { OverlayLayers } from "../io/deck-layers";
import type { MapError } from "../io/map";
import type { DatasetStorage, PersistError, StorageError } from "../io/opfs";
import type { ParquetError, ParquetFile } from "../io/parquet";
import type { ManifestChannel, TabsError, WriterLock } from "../io/tabs";

/** 地図。io の startMap が返す MapHandle に、app が使う操作だけを束ねたもの */
export type MapView = {
  readonly setAdminFill: (spec: AdminFillSpec) => Result<void, MapError>;
  readonly setOverlayLayers: (layers: OverlayLayers) => Result<void, MapError>;
  readonly fitBBox: (bbox: BBox) => void;
  readonly stop: () => void;
};

/**
 * 表（CSV、Parquet）を読む処理の失敗。
 * - read-failed：ファイルを読めなかった（UTF-8 でない CSV、Parquet でないファイルなど）。利用者に拒否として示す
 * - engine-failed：DuckDB-WASM の起動や spatial 拡張の取得に失敗した。ファイルのせいではない
 */
export type TableEngineError =
  | { readonly kind: "read-failed"; readonly message: string }
  | { readonly kind: "engine-failed"; readonly message: string };

/** 取り込むために DuckDB に登録した表 */
export type TableSource = {
  /** 列の名前と型。CSV の結合用の列（code、mesh、lat、lon）は、先頭の 0 を落とさないよう文字列型で読む */
  readonly columns: readonly ColumnSchema[];
  /** 結合用の列の値を全行読む。値の型は plan.joinColumns の型にそろえる */
  readonly readJoinValues: (
    plan: TableJoinPlan,
  ) => Promise<Result<Readonly<Record<string, ColumnValues>>, TableEngineError>>;
  /**
   * 正規化した Parquet のバイト列を作る。結合用の列は core の STORED_JOIN_COLUMNS の型、
   * 数値の属性の列は DOUBLE にし、ほかの列はそのまま残す
   */
  readonly writeNormalized: (plan: TableJoinPlan) => Promise<Result<Uint8Array, TableEngineError>>;
  /** 登録したファイルを消す */
  readonly close: () => Promise<void>;
};

/** 点の割り当てに使う、都道府県ごとの admin_geom の Parquet */
export type AdminGeometry = { readonly prefCode: string; readonly bytes: Uint8Array };

/** DuckDB-WASM を使う処理。DuckDB は初めて使うときに起動する（D4） */
export type TableEngine = {
  readonly openTable: (
    file: Blob,
    format: TableFormat,
  ) => Promise<Result<TableSource, TableEngineError>>;
  /**
   * 点を行政区域に割り当てる（D9）。spatial 拡張は初めて呼んだときに読み込む。
   * 結果の codes は点の順で、どの区域にも入らない点は null
   */
  readonly assignPoints: (
    points: { readonly lat: Float64Array; readonly lon: Float64Array },
    geometries: readonly AdminGeometry[],
  ) => Promise<Result<PointAdminAssignment, TableEngineError>>;
  readonly stop: () => Promise<void>;
};

export type FetchError =
  | { readonly kind: "fetch-failed"; readonly message: string }
  | { readonly kind: "invalid-json"; readonly message: string };

/** 手続きの失敗。画面に出す通知の種類が core にないものは、report で知らせる */
export type AppError =
  | { readonly kind: "storage"; readonly error: StorageError }
  | { readonly kind: "manifest"; readonly error: ManifestError | FetchError }
  | { readonly kind: "base-data"; readonly file: DataFile; readonly message: string }
  | { readonly kind: "dataset"; readonly id: string; readonly message: string }
  | { readonly kind: "engine"; readonly error: TableEngineError }
  | { readonly kind: "map"; readonly error: MapError }
  | { readonly kind: "tabs"; readonly error: TabsError }
  | { readonly kind: "persistence"; readonly error: PersistError };

/**
 * 手続きが使う副作用の口。Container は地図を描く要素の型で、ブラウザでは HTMLElement。
 * node のテストでは、地図の偽物を返す startMap と一緒に別の型を使う。
 */
export type AppPorts<Container> = {
  readonly openStorage: () => Promise<DatasetStorage>;
  readonly acquireWriterLock: (options: {
    readonly onPromoted: () => void;
  }) => Promise<Result<WriterLock, TabsError>>;
  readonly openManifestChannel: () => Result<ManifestChannel, TabsError>;
  readonly requestPersistence: () => Promise<Result<boolean, PersistError>>;
  readonly isPersisted: () => Promise<Result<boolean, PersistError>>;
  /** 生成物の Parquet のメタデータを読む（hyparquet） */
  readonly openBaseParquet: (file: DataFile) => Promise<Result<ParquetFile, ParquetError>>;
  /** 生成物の JSON を読み、JSON.parse した値を返す */
  readonly fetchBaseJson: (file: DataFile) => Promise<Result<unknown, FetchError>>;
  /** 生成物のファイル全体をバイト列で読む */
  readonly fetchBaseBytes: (file: DataFile) => Promise<Result<Uint8Array, FetchError>>;
  /** 利用者が選んだファイルをバイト列で読む（GeoJSON の取り込み） */
  readonly readBlob: (blob: Blob) => Promise<Result<Uint8Array, FetchError>>;
  readonly tables: TableEngine;
  readonly startMap: (container: Container) => Promise<Result<MapView, MapError>>;
  /** 取り込んだ日時（ISO 8601）。core は時刻を読まないので app が渡す */
  readonly now: () => string;
  /** データの識別子（core の isDatasetId を満たすもの） */
  readonly newId: () => string;
  /** 画面の通知にない失敗を知らせる。ブラウザではコンソールに出す */
  readonly report: (error: AppError) => void;
};
