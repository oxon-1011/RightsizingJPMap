// 自前データのレイヤーの描画の指定（docs/design/map-and-hosting.md の「全体の構成」）。
// 点は deck.gl の ScatterplotLayer、線と面は GeoJsonLayer で描く。

import { hex, type Rgba } from "../classify/color";
import type { LayerStyle } from "../storage/manifest";

/** 点のレイヤー。positions は経度と緯度を交互に並べた配列で、ScatterplotLayer の getPosition に渡す */
export type PointLayerSpec = {
  readonly kind: "point";
  readonly id: string;
  readonly length: number;
  readonly positions: Float64Array;
  readonly color: Rgba;
  readonly radiusPixels: number;
  readonly visible: boolean;
};

/** 線と面のレイヤー。GeoJSON そのものは io が OPFS から読んで渡す */
export type GeoJsonLayerSpec = {
  readonly kind: "line" | "polygon";
  readonly id: string;
  readonly color: Rgba;
  /** 線の幅、面の枠の幅（ピクセル） */
  readonly lineWidthPixels: number;
  /** 面の塗りの色。下の塗り分けが見えるよう半透明にする。線では null */
  readonly fillColor: Rgba | null;
  readonly visible: boolean;
};

/** 面の塗りの不透明度（0〜255）。TODO(トラック C): 仮の値 */
export const POLYGON_FILL_ALPHA = 64;

/**
 * 点のレイヤーの指定を作る。lat と lon は同じ長さの、検査済みの座標。
 * 長さが違うのは呼び出し側の誤りなので例外を投げる。
 */
export const pointLayerSpec = (
  id: string,
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  style: LayerStyle,
): PointLayerSpec => {
  if (lat.length !== lon.length) {
    throw new Error(`lat と lon の長さが違う: ${lat.length} と ${lon.length}`);
  }
  const positions = new Float64Array(lat.length * 2);
  for (let i = 0; i < lat.length; i++) {
    positions[i * 2] = lon[i] ?? Number.NaN;
    positions[i * 2 + 1] = lat[i] ?? Number.NaN;
  }
  return {
    kind: "point",
    id,
    length: lat.length,
    positions,
    color: hex(style.color),
    radiusPixels: style.size,
    visible: style.visible,
  };
};

export const geoJsonLayerSpec = (
  id: string,
  kind: "line" | "polygon",
  style: LayerStyle,
): GeoJsonLayerSpec => {
  const color = hex(style.color);
  const [r, g, b] = color;
  return {
    kind,
    id,
    color,
    lineWidthPixels: style.size,
    fillColor: kind === "polygon" ? [r, g, b, POLYGON_FILL_ALPHA] : null,
    visible: style.visible,
  };
};
