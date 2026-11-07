// 前処理（pipeline/）が出力し、フロントが読む生成物の契約。
// 内容は docs/design/base-data.md の「前処理と生成物」と一致させる。
// 変えるときは他のトラックに影響するので相談する（docs/design/implementation-plan.md）。

/** 配信するデータの版。パスに含め、更新のたびに上げる（docs/design/map-and-hosting.md） */
export const DATA_VERSION = "v1";

export const DATA_FILES = {
  meshIndicators: "mesh_indicators.parquet",
  municipalIndicators: "municipal_indicators.parquet",
  adminTiles: "admin.pmtiles",
  adminGeomIndex: "admin_geom/index.json",
  places: "places.json",
} as const;

/** 範囲。西端の経度、南端の緯度、東端の経度、北端の緯度の順 */
export type BBox = readonly [number, number, number, number];

/** places.json の要素。場所への移動の候補（docs/design/ui.md の「場所への移動」） */
export type Place = {
  /** 5桁の団体コード。都道府県は末尾が 000 */
  readonly code: string;
  readonly name: string;
  readonly pref_name: string;
  readonly kind: "prefecture" | "designated-city" | "ward" | "municipality";
  readonly bbox: BBox;
};

/** admin.pmtiles のレイヤー名 */
export const ADMIN_TILE_LAYERS = { prefecture: "pref", municipality: "muni" } as const;

/**
 * admin.pmtiles の地物が団体コードを持つ属性の名前。MapLibre の promoteId に指定する。
 * 値は5桁の文字列で、都道府県は末尾が 000（municipal_indicators.parquet の code と同じ）
 */
export const ADMIN_TILE_CODE_PROPERTY = "code";

/** 空間結合に使う行政区域のポリゴンのファイル（都道府県ごと）。prefCode は2桁 */
export const adminGeomFile = (prefCode: string): `admin_geom/${string}.parquet` =>
  `admin_geom/${prefCode}.parquet`;

/**
 * admin_geom/<都道府県コード>.parquet の列名。GeoParquet 1.1 で、1行が1区域。
 * 座標は経度緯度で、crs は省いている（OGC:CRS84 とみなす）。
 */
export const ADMIN_GEOM_COLUMNS = {
  /** 5桁の団体コード（VARCHAR）。admin.pmtiles の muni レイヤーの code と同じ */
  code: "code",
  /** 区域の名前（VARCHAR） */
  name: "name",
  /** 区域の形（WKB の MultiPolygon）。隣と隙間も重なりもないように簡略化してある */
  geometry: "geometry",
  /** 区域の範囲（xmin、ymin、xmax、ymax の DOUBLE の構造体）。GeoParquet の covering に宣言している */
  bbox: "bbox",
} as const;

/** admin_geom/index.json の中身。2桁の都道府県コードから、その都道府県の範囲への対応 */
export type AdminGeomIndex = Readonly<Record<string, BBox>>;

/**
 * Parquet から読んだ列を core に渡すときの型。io が列の型に応じて変換する。
 * UINTEGER は Uint32Array、FLOAT は Float32Array、BOOLEAN は Uint8Array（0 か 1）、
 * INTEGER と BIGINT は Float64Array、VARCHAR は文字列の配列にする。数値の NULL は NaN にする。
 * UINTEGER、BOOLEAN、VARCHAR は NULL を表せないので、NULL があれば io は失敗を返す。
 */
export type ColumnArray =
  | Uint32Array
  | Float32Array
  | Float64Array
  | Uint8Array
  | readonly string[];

/** メッシュの年次（D8） */
export const MESH_YEARS = [
  2020, 2025, 2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065, 2070,
] as const;

/** メッシュで年齢別の値と秘匿記号がある年次。2020 年は総数だけ */
export const MESH_AGE_YEARS = [2025, 2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065, 2070] as const;

/** 行政区域の年次（D8） */
export const MUNICIPAL_YEARS = [2020, 2025, 2030, 2035, 2040, 2045, 2050] as const;

/** 増減率の基準年（D8） */
export const BASE_YEAR = 2025;

export type MeshYear = (typeof MESH_YEARS)[number];
export type MeshAgeYear = (typeof MESH_AGE_YEARS)[number];
export type MunicipalYear = (typeof MUNICIPAL_YEARS)[number];

/** 年齢別の人口の区分。メッシュと行政区域で共通 */
export const AGE_GROUPS = ["p0_14", "p15_64", "p65", "p75"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** mesh_indicators.parquet の列名。1行1メッシュで、年と指標の組を列に展開している */
export const meshColumn = {
  /** 3次メッシュコード（UINTEGER） */
  mesh: "mesh",
  /** 総人口（PTN）。FLOAT */
  pop: <Y extends MeshYear>(year: Y): `${Y}_pop` => `${year}_pop`,
  /** 年齢別の人口。FLOAT */
  age: <Y extends MeshAgeYear, G extends AgeGroup>(year: Y, group: G): `${Y}_${G}` =>
    `${year}_${group}`,
  /** その年に秘匿記号が付いているか。BOOLEAN */
  masked: <Y extends MeshAgeYear>(year: Y): `${Y}_masked` => `${year}_masked`,
} as const;

/**
 * municipal_indicators.parquet の列名。1行が1地域の1年（縦持ち）。
 * 浜松市は 2024 年の再編後の3区に差し替えてある。
 */
export const MUNICIPAL_COLUMNS = {
  /** 5桁の団体コード（VARCHAR） */
  code: "code",
  /** 地域の名前（VARCHAR） */
  name: "name",
  /** 都道府県の名前（VARCHAR） */
  prefName: "pref_name",
  /** 地域の種類（VARCHAR）。AREA_TYPES を参照 */
  areaType: "area_type",
  /** 年（INTEGER） */
  year: "year",
  /** 総人口（BIGINT） */
  pop: "pop",
  /** 年齢別の人口（BIGINT）。列名は AGE_GROUPS の値そのもの */
  age: <G extends AgeGroup>(group: G): G => group,
} as const;

/** 社人研の推計の area_type 列の値（docs/design/base-data.md の「行政区域と団体コード」） */
export const AREA_TYPES = {
  prefecture: "a",
  designatedCity: "1",
  ward: "0",
  city: "2",
  townVillage: "3",
  hamadoori: "9",
} as const;
export type AreaType = (typeof AREA_TYPES)[keyof typeof AREA_TYPES];
