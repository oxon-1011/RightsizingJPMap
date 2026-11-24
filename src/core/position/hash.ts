// 地図の位置（ズーム、中心、向き）と、URL の # 以降の文字列との変換。
// 形は `#名前=ズーム/緯度/経度` で、北が上でないときだけ `/向き` が続く（MapLibre の hash と同じ並び）。
// # 以降は `&` で区切った `名前=値` の並びとして扱い、ほかの名前の値はそのまま残す。
// URL を読むことと書くことは io がする（src/io/map.ts）。

/** 地図の位置。bearing は北から時計回りの角度（度）で、北が上なら 0 */
export type MapPosition = {
  readonly zoom: number;
  readonly lat: number;
  readonly lon: number;
  readonly bearing: number;
};

export type ZoomRange = { readonly minZoom: number; readonly maxZoom: number };

/** 符号、整数部、小数部だけの 10 進の数。指数や空白は受け付けない */
const DECIMAL = /^-?\d+(\.\d+)?$/;

const params = (hash: string): readonly string[] =>
  hash
    .replace(/^#/, "")
    .split("&")
    .filter((param) => param !== "");

const within = (value: number, min: number, max: number): boolean => value >= min && value <= max;

/**
 * URL の # 以降から、地図の位置を読む。
 * 名前の値がない、数が3つでも4つでもない、数でないものがある、範囲の外の値がある、のどれかなら null を返す。
 * 範囲は、ズームが range の中、緯度が ±90、経度と向きが ±180。範囲の外の値を、範囲の中に寄せることはしない
 */
export const parsePositionHash = (
  hash: string,
  name: string,
  range: ZoomRange,
): MapPosition | null => {
  const prefix = `${name}=`;
  const param = params(hash).find((p) => p.startsWith(prefix));
  if (param === undefined) {
    return null;
  }
  const parts = param.slice(prefix.length).split("/");
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every((part) => DECIMAL.test(part))) {
    return null;
  }
  const [zoom = Number.NaN, lat = Number.NaN, lon = Number.NaN, bearing = 0] = parts.map(Number);
  return within(zoom, range.minZoom, range.maxZoom) &&
    within(lat, -90, 90) &&
    within(lon, -180, 180) &&
    within(bearing, -180, 180)
    ? { zoom, lat, lon, bearing }
    : null;
};

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  // -0 を 0 にそろえる
  return Math.round(value * scale) / scale + 0;
};

/**
 * 緯度と経度の小数の桁数。画面の半ピクセルより細かくなる桁数にする（MapLibre の hash と同じ式）。
 * 512px のタイルで、ズーム z の1ピクセルは経度 360 / (512 × 2^z) 度にあたる
 */
const coordinateDigits = (zoom: number): number =>
  Math.max(0, Math.ceil((zoom * Math.LN2 + Math.log(512 / 360 / 0.5)) / Math.LN10));

const positionValue = ({ zoom, lat, lon, bearing }: MapPosition): string => {
  const digits = coordinateDigits(zoom);
  const values = [round(zoom, 2), round(lat, digits), round(lon, digits)];
  const roundedBearing = round(bearing, 1);
  return (roundedBearing === 0 ? values : [...values, roundedBearing]).join("/");
};

/**
 * URL の # 以降の、名前の値を position に置き換えたものを返す（先頭の # を含む）。
 * 名前の値がなければ末尾に足す。ほかの名前の値と、その並びは変えない
 */
export const formatPositionHash = (hash: string, name: string, position: MapPosition): string => {
  const prefix = `${name}=`;
  const next = `${prefix}${positionValue(position)}`;
  const current = params(hash);
  const replaced = current.some((p) => p.startsWith(prefix))
    ? current.map((p) => (p.startsWith(prefix) ? next : p))
    : [...current, next];
  return `#${replaced.join("&")}`;
};
