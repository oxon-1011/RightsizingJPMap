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
} as const;

/** 空間結合に使う行政区域のポリゴンのファイル（都道府県ごと） */
export const adminGeomFile = (prefCode: string): `admin_geom/${string}.parquet` =>
  `admin_geom/${prefCode}.parquet`;

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
