// 3次メッシュコード（8桁）と緯度経度の変換（JIS X 0410）。
// 式は docs/design/map-and-hosting.md の「メッシュコードから四角形を求める式」と同じ。

export type LatLon = { readonly lat: number; readonly lon: number };

export type Bounds = {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
};

/** 3次メッシュの緯度方向の大きさ（度）。30 秒 */
export const MESH3_LAT_SIZE = 30 / 3600;

/** 3次メッシュの経度方向の大きさ（度）。45 秒 */
export const MESH3_LON_SIZE = 45 / 3600;

/** メッシュコードから、そのメッシュの範囲を求める */
export const meshCodeToBounds = (code: number): Bounds => {
  const p = Math.floor(code / 1_000_000);
  const u = Math.floor(code / 10_000) % 100;
  const q = Math.floor(code / 1_000) % 10;
  const v = Math.floor(code / 100) % 10;
  const r = Math.floor(code / 10) % 10;
  const w = code % 10;
  const south = p / 1.5 + q * (5 / 60) + r * MESH3_LAT_SIZE;
  const west = u + 100 + v * (7.5 / 60) + w * MESH3_LON_SIZE;
  return { south, west, north: south + MESH3_LAT_SIZE, east: west + MESH3_LON_SIZE };
};

/**
 * 緯度経度から、その点を含むメッシュのコードを求める。
 * 日本の範囲の座標を渡す前提で、範囲の検査は受け入れ検査で行う。
 */
export const latLonToMeshCode = ({ lat, lon }: LatLon): number => {
  const a = lat * 1.5;
  const p = Math.floor(a);
  const q = Math.floor((a - p) * 8);
  const r = Math.floor(((a - p) * 8 - q) * 10);
  const b = lon - 100;
  const u = Math.floor(b);
  const v = Math.floor((b - u) * 8);
  const w = Math.floor(((b - u) * 8 - v) * 10);
  return p * 1_000_000 + u * 10_000 + q * 1_000 + v * 100 + r * 10 + w;
};
