// メッシュの四角形を、deck.gl の SolidPolygonLayer のバイナリ形式で作る。
// 読み込み時に一度だけ作り、指標や年を変えたときは色の配列だけを作り直す
// （docs/design/map-and-hosting.md の「描画の流れ」）。
//
// io は次のように渡す想定である。
//   data: { length, startIndices, attributes: { getPolygon: { value: positions, size: 2 }, indices } }
//   _normalize: false、_windingOrder: "CW"（既定値）、positionFormat: "XY"
//
// _normalize: false にすると、deck.gl は輪を閉じる処理と向きをそろえる処理を飛ばす。
// そのため、各メッシュの輪を閉じ（最初の頂点を最後にもう一度置く）、北を上にした地図で時計回りにする。
// 時計回りは @math.gl/polygon の WINDING.CLOCKWISE（符号付き面積が正）と同じ向きである。
// indices を渡すと、deck.gl は三角形への分割（earcut）も飛ばす。
// 確かめたのは deck.gl 9.4.1 の solid-polygon-layer.js、polygon-tesselator.js、core の tesselator.js。

import { meshCodeToBounds } from "./mesh-code";

/** 1つのメッシュの輪の頂点の数。南西、北西、北東、南東、南西（閉じる点）の5つ */
export const MESH_RING_VERTEX_COUNT = 5;

/** 1つのメッシュの三角形の頂点の番号の数。2つの三角形で6つ */
export const MESH_TRIANGLE_INDEX_COUNT = 6;

export type MeshGeometry = {
  /** メッシュの数 */
  readonly length: number;
  /** i 番目のメッシュの最初の頂点の番号。長さは length + 1 で、最後は頂点の総数 */
  readonly startIndices: Uint32Array;
  /** 頂点の経度と緯度を交互に並べた配列。長さは length × 5 × 2 */
  readonly positions: Float64Array;
  /** 三角形の頂点の番号。長さは length × 6 */
  readonly indices: Uint32Array;
};

/** メッシュコードの配列から、四角形の頂点を作る。順序は codes と同じ */
export const buildMeshGeometry = (codes: ArrayLike<number>): MeshGeometry => {
  const length = codes.length;
  const startIndices = new Uint32Array(length + 1);
  const positions = new Float64Array(length * MESH_RING_VERTEX_COUNT * 2);
  const indices = new Uint32Array(length * MESH_TRIANGLE_INDEX_COUNT);
  for (let i = 0; i < length; i++) {
    const { south, west, north, east } = meshCodeToBounds(codes[i] ?? Number.NaN);
    const start = i * MESH_RING_VERTEX_COUNT;
    startIndices[i] = start;
    positions.set([west, south, west, north, east, north, east, south, west, south], start * 2);
    // 南西、北西、北東 と 南西、北東、南東 の2つの三角形
    indices.set([start, start + 1, start + 2, start, start + 2, start + 3], i * 6);
  }
  startIndices[length] = length * MESH_RING_VERTEX_COUNT;
  return { length, startIndices, positions, indices };
};
