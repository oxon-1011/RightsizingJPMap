// メッシュのレイヤーの描画の指定。deck.gl の SolidPolygonLayer に渡す値を、普通のデータとして組み立てる。

import { type Classification, classIndex, NO_CLASS } from "../classify/classify";
import { type Rgba, TRANSPARENT } from "../classify/color";
import { MESH_RING_VERTEX_COUNT, type MeshGeometry } from "../mesh/geometry";

/**
 * 値を色に変え、頂点ごとの RGBA を並べた配列にする。値なし（NaN）は透明。
 * SolidPolygonLayer は _normalize: false のとき、バイナリの getFillColor を頂点ごとの値として読むので、
 * メッシュの色を輪の5つの頂点に同じように置く（mesh/geometry.ts）。長さは values.length × 5 × 4。
 */
export const meshVertexColors = (
  values: ArrayLike<number>,
  classification: Classification,
): Uint8Array => {
  const { breaks, colors } = classification;
  const stride = MESH_RING_VERTEX_COUNT * 4;
  const out = new Uint8Array(values.length * stride);
  for (let i = 0; i < values.length; i++) {
    const k = classIndex(values[i] ?? Number.NaN, breaks);
    const [r, g, b, a] = k === NO_CLASS ? TRANSPARENT : (colors[k] ?? TRANSPARENT);
    for (let v = 0; v < MESH_RING_VERTEX_COUNT; v++) {
      const o = i * stride + v * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
};

export type MeshLayerSpec = {
  readonly id: string;
  readonly geometry: MeshGeometry;
  /** 頂点ごとの RGBA。meshVertexColors の戻り値 */
  readonly fillColors: Uint8Array;
  /** 色を作り直したことを deck.gl に伝える値（updateTriggers の getFillColor に渡す） */
  readonly colorKey: string;
  readonly visible: boolean;
};

/**
 * メッシュのレイヤーの指定を作る。values はメッシュの順（geometry と同じ順）に並んだ指標の値。
 * 長さが違うのは呼び出し側の誤りなので例外を投げる。
 */
export const meshLayerSpec = (args: {
  readonly id: string;
  readonly geometry: MeshGeometry;
  readonly values: ArrayLike<number>;
  readonly classification: Classification;
  readonly colorKey: string;
  readonly visible: boolean;
}): MeshLayerSpec => {
  if (args.values.length !== args.geometry.length) {
    throw new Error(`メッシュの数と値の数が違う: ${args.geometry.length} と ${args.values.length}`);
  }
  return {
    id: args.id,
    geometry: args.geometry,
    fillColors: meshVertexColors(args.values, args.classification),
    colorKey: args.colorKey,
    visible: args.visible,
  };
};

/** 1つのメッシュの色を取り出す。テストと、ホバーしたメッシュの色を凡例で示すときに使う */
export const meshColorAt = (fillColors: Uint8Array, index: number): Rgba => {
  const o = index * MESH_RING_VERTEX_COUNT * 4;
  return [
    fillColors[o] ?? 0,
    fillColors[o + 1] ?? 0,
    fillColors[o + 2] ?? 0,
    fillColors[o + 3] ?? 0,
  ];
};
