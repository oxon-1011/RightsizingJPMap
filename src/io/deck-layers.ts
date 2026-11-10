// core の描画の指定を、deck.gl のレイヤーに変える（docs/design/map-and-hosting.md の「描画の流れ」）。
// 地図への適用は map.ts の setOverlayLayers が行う。ここはレイヤーを組み立てるだけで、地図に触らない。

import {
  GeoJsonLayer,
  type GeoJsonLayerProps,
  ScatterplotLayer,
  SolidPolygonLayer,
} from "@deck.gl/layers";
import type { Rgba } from "../core/classify/color";
import type { MeshGeometry } from "../core/mesh/geometry";
import type { MeshLayerSpec } from "../core/render/mesh";
import type { GeoJsonLayerSpec, PointLayerSpec } from "../core/render/overlay";
import { err, ok, type Result } from "../core/result";

/** deck.gl の GeoJsonLayer に渡せる GeoJSON。parseOverlayGeoJson で作る */
export type OverlayGeoJson = Exclude<GeoJsonLayerProps["data"], string | Promise<unknown>>;

/** 線と面の自前データのレイヤー。GeoJSON の中身は、指定とは別に渡す */
export type GeoJsonOverlay = {
  readonly spec: GeoJsonLayerSpec;
  readonly data: OverlayGeoJson;
};

/** 地図に重ねる deck.gl のレイヤーの全体。setOverlayLayers に渡す */
export type OverlayLayers = {
  /** メッシュの塗り分け。行政区域を塗っているときは null か、visible を false にした指定 */
  readonly mesh: MeshLayerSpec | null;
  /** 自前データの点 */
  readonly points: readonly PointLayerSpec[];
  /** 自前データの線と面 */
  readonly geoJsons: readonly GeoJsonOverlay[];
};

export type OverlayGeoJsonError = { readonly kind: "invalid-json"; readonly message: string };

/**
 * OPFS から読んだ GeoJSON のバイト列を、GeoJsonLayer に渡せる値にする。
 * 中身の検査は取り込みのときに core の checkGeoJson で済んでいる前提で、ここでは JSON として読むだけにする。
 * 結果を持っておき、レイヤーを作り直すたびに同じ値を渡す（deck.gl は data が同じなら作り直さない）。
 */
export const parseOverlayGeoJson = (
  bytes: Uint8Array,
): Result<OverlayGeoJson, OverlayGeoJsonError> => {
  try {
    const parsed: OverlayGeoJson = JSON.parse(new TextDecoder().decode(bytes));
    return ok(parsed);
  } catch (e) {
    return err({ kind: "invalid-json", message: e instanceof Error ? e.message : String(e) });
  }
};

/** deck.gl の色。Rgba をそのまま渡すと readonly が外せないので、配列に写す */
const deckColor = ([r, g, b, a]: Rgba): [number, number, number, number] => [r, g, b, a];

type MeshData = {
  readonly length: number;
  readonly startIndices: Uint32Array;
  readonly attributes: {
    readonly getPolygon: { readonly value: Float64Array; readonly size: 2 };
    readonly indices: Uint32Array;
    readonly getFillColor: {
      readonly value: Uint8Array;
      readonly size: 4;
      readonly normalized: true;
    };
  };
};

/** meshLayer が作った data から、その元の形への対応 */
const meshGeometryOf = new WeakMap<object, MeshGeometry>();

/**
 * 同じ形から作った data なら、変わっていないとみなす。
 * 色を差し替えるたびに data は新しいオブジェクトになるが、deck.gl に形の作り直し（三角形への分割と頂点の転送）を
 * させず、updateTriggers で色の配列だけを転送させるためである。
 * deck.gl の型に合わせて、引数は型を決めずに受け取る。
 */
const sameMeshGeometry = <T>(next: T, prev?: T): boolean => {
  if (typeof next !== "object" || next === null || typeof prev !== "object" || prev === null) {
    return false;
  }
  const geometry = meshGeometryOf.get(next);
  return geometry !== undefined && geometry === meshGeometryOf.get(prev);
};

/**
 * メッシュの塗り分けのレイヤー。SolidPolygonLayer にバイナリ形式で渡す（src/core/mesh/geometry.ts）。
 * beforeId は、地図の中でこのレイヤーを差し込む位置（このレイヤーの直後に来る MapLibre のレイヤー）である。
 */
export const meshLayer = (spec: MeshLayerSpec, beforeId: string): SolidPolygonLayer<MeshData> => {
  const { geometry } = spec;
  const data: MeshData = {
    length: geometry.length,
    startIndices: geometry.startIndices,
    attributes: {
      getPolygon: { value: geometry.positions, size: 2 },
      indices: geometry.indices,
      getFillColor: { value: spec.fillColors, size: 4, normalized: true },
    },
  };
  meshGeometryOf.set(data, geometry);
  // beforeId は @deck.gl/mapbox が読む属性で、SolidPolygonLayer の型にはない。
  // 変数に入れて渡すと、オブジェクトリテラルの余分な属性の検査を受けない
  const placement = { id: spec.id, beforeId };
  return new SolidPolygonLayer<MeshData>(
    {
      data,
      dataComparator: sameMeshGeometry,
      _normalize: false,
      positionFormat: "XY",
      filled: true,
      extruded: false,
      visible: spec.visible,
      updateTriggers: { getFillColor: spec.colorKey },
    },
    placement,
  );
};

type PointData = {
  readonly length: number;
  readonly attributes: {
    readonly getPosition: { readonly value: Float64Array; readonly size: 2 };
  };
};

/**
 * 点の座標をバイナリ形式の data にしたもの。同じ座標の配列には同じ data を返し、
 * スタイルだけを変えたときに座標を転送し直させない。
 */
const pointDataCache = new WeakMap<Float64Array, PointData>();

const pointData = (spec: PointLayerSpec): PointData => {
  const cached = pointDataCache.get(spec.positions);
  if (cached !== undefined) {
    return cached;
  }
  const data: PointData = {
    length: spec.length,
    attributes: { getPosition: { value: spec.positions, size: 2 } },
  };
  pointDataCache.set(spec.positions, data);
  return data;
};

/** 点の縁取り。濃い塗りの上でも点を見つけられるよう、白で囲む */
const POINT_STROKE = { color: [255, 255, 255, 255], widthPixels: 1.5 } as const;

/** 自前データの点のレイヤー */
export const pointLayer = (spec: PointLayerSpec): ScatterplotLayer<PointData> =>
  new ScatterplotLayer<PointData>({
    id: spec.id,
    data: pointData(spec),
    getFillColor: deckColor(spec.color),
    getRadius: spec.radiusPixels,
    radiusUnits: "pixels",
    stroked: true,
    getLineColor: POINT_STROKE.color,
    getLineWidth: POINT_STROKE.widthPixels,
    lineWidthUnits: "pixels",
    visible: spec.visible,
  });

/** 自前データの線と面のレイヤー */
export const geoJsonLayer = ({ spec, data }: GeoJsonOverlay): GeoJsonLayer =>
  new GeoJsonLayer({
    id: spec.id,
    data,
    filled: spec.fillColor !== null,
    stroked: true,
    getFillColor: deckColor(spec.fillColor ?? spec.color),
    getLineColor: deckColor(spec.color),
    getLineWidth: spec.lineWidthPixels,
    lineWidthUnits: "pixels",
    pointType: "circle",
    visible: spec.visible,
  });

/**
 * 地図に重ねるレイヤーを、下から順に並べる。
 * メッシュは meshBeforeId の位置（背景地図の道路と境界線の下）に、自前データは地図のいちばん上に描く。
 */
export const overlayDeckLayers = (
  layers: OverlayLayers,
  meshBeforeId: string,
): readonly (SolidPolygonLayer<MeshData> | ScatterplotLayer<PointData> | GeoJsonLayer)[] => [
  ...(layers.mesh === null ? [] : [meshLayer(layers.mesh, meshBeforeId)]),
  ...layers.geoJsons.map(geoJsonLayer),
  ...layers.points.map(pointLayer),
];
