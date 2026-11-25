// 地域モードの地域（docs/design/map-and-hosting.md の「地域モード」）。
// 地域は、表示する都道府県のコードを昇順に並べたもので、空なら全国である。
// 地域を選ぶと、メッシュはその都道府県のファイル（mesh_pref/<コード>.parquet）だけを読んで描き、
// 行政区域は団体コードの上2桁がその都道府県のものだけを塗る。

import type { AdminGeomIndex, BBox } from "../data/schema";
import type { MeshLookup } from "../join/per-population";

/** 都道府県のコード（JIS X 0401 の2桁）と名前。コードの順 */
export const PREFECTURES = [
  { code: "01", name: "北海道" },
  { code: "02", name: "青森県" },
  { code: "03", name: "岩手県" },
  { code: "04", name: "宮城県" },
  { code: "05", name: "秋田県" },
  { code: "06", name: "山形県" },
  { code: "07", name: "福島県" },
  { code: "08", name: "茨城県" },
  { code: "09", name: "栃木県" },
  { code: "10", name: "群馬県" },
  { code: "11", name: "埼玉県" },
  { code: "12", name: "千葉県" },
  { code: "13", name: "東京都" },
  { code: "14", name: "神奈川県" },
  { code: "15", name: "新潟県" },
  { code: "16", name: "富山県" },
  { code: "17", name: "石川県" },
  { code: "18", name: "福井県" },
  { code: "19", name: "山梨県" },
  { code: "20", name: "長野県" },
  { code: "21", name: "岐阜県" },
  { code: "22", name: "静岡県" },
  { code: "23", name: "愛知県" },
  { code: "24", name: "三重県" },
  { code: "25", name: "滋賀県" },
  { code: "26", name: "京都府" },
  { code: "27", name: "大阪府" },
  { code: "28", name: "兵庫県" },
  { code: "29", name: "奈良県" },
  { code: "30", name: "和歌山県" },
  { code: "31", name: "鳥取県" },
  { code: "32", name: "島根県" },
  { code: "33", name: "岡山県" },
  { code: "34", name: "広島県" },
  { code: "35", name: "山口県" },
  { code: "36", name: "徳島県" },
  { code: "37", name: "香川県" },
  { code: "38", name: "愛媛県" },
  { code: "39", name: "高知県" },
  { code: "40", name: "福岡県" },
  { code: "41", name: "佐賀県" },
  { code: "42", name: "長崎県" },
  { code: "43", name: "熊本県" },
  { code: "44", name: "大分県" },
  { code: "45", name: "宮崎県" },
  { code: "46", name: "鹿児島県" },
  { code: "47", name: "沖縄県" },
] as const;

export type PrefCode = (typeof PREFECTURES)[number]["code"];

/** 表示する都道府県のコード。重複がなく、昇順に並ぶ。空は全国 */
export type Region = readonly PrefCode[];

export const WHOLE_COUNTRY: Region = [];

const PREF_NAMES: ReadonlyMap<string, string> = new Map(PREFECTURES.map((p) => [p.code, p.name]));

export const isPrefCode = (value: string): value is PrefCode => PREF_NAMES.has(value);

/** コードの集まりを、重複を除いて昇順に並べる */
export const regionOf = (codes: Iterable<PrefCode>): Region => [...new Set(codes)].sort();

/** 都道府県を1つ、地域に入れるか外す */
export const toggleRegion = (region: Region, code: PrefCode, selected: boolean): Region =>
  regionOf(selected ? [...region, code] : region.filter((c) => c !== code));

export const sameRegion = (a: Region, b: Region): boolean =>
  a.length === b.length && a.every((code, i) => code === b[i]);

export const isWholeCountry = (region: Region): boolean => region.length === 0;

/** 地域を見分ける文字列。塗り分けを作り直すかの判断と、読んだデータの持ち回りに使う */
export const regionKey = (region: Region): string =>
  isWholeCountry(region) ? "all" : region.join(",");

/** 5桁の団体コードの区域が、地域に入るか。全国ならどの区域も入る */
export const isInRegion = (areaCode: string, region: Region): boolean =>
  isWholeCountry(region) || region.some((code) => areaCode.startsWith(code));

/** 画面に出す地域の名前。3つ以上のときは、先頭の名前と残りの数にする */
export const regionLabel = (region: Region): string => {
  const names = region.map((code) => PREF_NAMES.get(code) ?? code);
  const [first = "全国", second] = names;
  if (names.length <= 1) {
    return first;
  }
  return names.length === 2 ? `${first}、${second}` : `${first} ほか ${names.length - 1}`;
};

/** 地域の都道府県の範囲を合わせた範囲。全国のときと、範囲の表に都道府県がないときは null */
export const regionBBox = (index: AdminGeomIndex, region: Region): BBox | null => {
  const boxes = region.map((code) => index[code]).filter((box) => box !== undefined);
  if (boxes.length === 0 || boxes.length !== region.length) {
    return null;
  }
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
};

/**
 * 団体コードごとの値を、地域の区域だけにする。地域の外の区域は値なし（NaN）にして残す。
 * 残すのは、地図の塗りがすべての区域の色を受け取って、前の色を消すからである（render/admin.ts）
 */
export const restrictCodeValues = (
  values: ReadonlyMap<string, number>,
  region: Region,
): ReadonlyMap<string, number> =>
  isWholeCountry(region)
    ? values
    : new Map([...values].map(([code, v]) => [code, isInRegion(code, region) ? v : Number.NaN]));

/**
 * メッシュごとの値を、members にあるメッシュだけにする。順は変えない。
 * 自前データを結合した指標を、地域のメッシュ（地域のベースデータにあるメッシュ）に絞るのに使う
 */
export const restrictMeshValues = (
  meshes: Uint32Array,
  values: ArrayLike<number>,
  members: MeshLookup,
): { readonly meshes: Uint32Array; readonly values: Float64Array } => {
  if (meshes.length !== values.length) {
    throw new Error(`メッシュの数と値の数が違う: ${meshes.length} と ${values.length}`);
  }
  const kept: number[] = [];
  for (let i = 0; i < meshes.length; i++) {
    if (members.has(meshes[i] ?? Number.NaN)) {
      kept.push(i);
    }
  }
  return {
    meshes: Uint32Array.from(kept, (i) => meshes[i] ?? 0),
    values: Float64Array.from(kept, (i) => values[i] ?? Number.NaN),
  };
};
