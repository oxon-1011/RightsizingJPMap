// GeoJSON の受け入れ検査（D13、docs/design/user-data.md の「GeoJSON の受け入れ条件」）。
// io が JSON.parse した値（unknown）を受け取り、全地物を検査する。条件を満たさない値は推測で直さない。
// 緯度と経度の入れ違いと投影座標は、座標の範囲の検査で拒否される。

import { err, ok, type Result } from "../result";
import type { ColumnSchema, ColumnType } from "./table";
import { LAT_RANGE, LON_RANGE } from "./table";
import { type Violation, violationCollector } from "./violation";

/** ジオメトリの種類。点、線、面のどれか */
export type GeometryKind = "point" | "line" | "polygon";

const GEOMETRY_KINDS: Readonly<Record<string, GeometryKind>> = {
  Point: "point",
  LineString: "line",
  MultiLineString: "line",
  Polygon: "polygon",
  MultiPolygon: "polygon",
};

/**
 * crs メンバーに受け付ける名前。どちらも経度、緯度の順の WGS84 を表す。
 * EPSG:4326 は軸の順が緯度、経度なので受け付けない。
 */
export const CRS84_NAMES: readonly string[] = [
  "urn:ogc:def:crs:OGC:1.3:CRS84",
  "urn:ogc:def:crs:OGC::CRS84",
];

/**
 * 地物ごとの条件。1つの地物は、最初に満たさなかった条件だけで数える。
 * - feature：type が Feature のオブジェクトで、properties がオブジェクトか null
 * - geometry-null：ジオメトリが null でない
 * - geometry-type：ジオメトリが点、線、面のどれか（MultiPoint と GeometryCollection は受け付けない）
 * - coordinates：座標の配列の入れ子が、ジオメトリの種類どおり（RFC 7946）
 * - coordinate-range：すべての座標が北緯 20〜46 度、東経 122〜154 度に入る
 * - single-geometry-kind：最初の地物と同じ種類のジオメトリ
 */
export type GeoJsonCondition =
  | "feature"
  | "geometry-null"
  | "geometry-type"
  | "coordinates"
  | "coordinate-range"
  | "single-geometry-kind";

export type GeoJsonRejection =
  | { readonly kind: "not-feature-collection" }
  | { readonly kind: "unsupported-crs" }
  | { readonly kind: "no-features" }
  | {
      readonly kind: "invalid-features";
      /** 条件ごとの違反。GeoJsonCondition の並びの順 */
      readonly violations: readonly Violation<GeoJsonCondition>[];
    };

/** 検査を通った GeoJSON */
export type AcceptedGeoJson = {
  readonly geometryKind: GeometryKind;
  readonly featureCount: number;
  /** properties の名前と型。数は float、文字列は string、混在や真偽値などは other */
  readonly attributes: readonly ColumnSchema[];
  /**
   * 点のときだけ、座標と数値の属性を列にしたもの。CSV の点と同じ処理に通すために使う。
   * 数値の属性で値がない（null や別の型）地物は NaN。
   */
  readonly points: {
    readonly lat: Float64Array;
    readonly lon: Float64Array;
    readonly numeric: Readonly<Record<string, Float64Array>>;
  } | null;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isCrs84 = (crs: unknown): boolean => {
  if (!isRecord(crs)) {
    return false;
  }
  const { type, properties } = crs;
  if (type !== "name" || !isRecord(properties)) {
    return false;
  }
  const { name } = properties;
  return typeof name === "string" && CRS84_NAMES.includes(name);
};

/** 座標の検査の結果。形の誤りを範囲の誤りより先に数える */
type CoordinateCheck = "ok" | "malformed" | "out-of-range";

const worse = (a: CoordinateCheck, b: CoordinateCheck): CoordinateCheck =>
  a === "malformed" || b === "malformed" ? "malformed" : a === "out-of-range" ? a : b;

/** 位置は2つ以上の有限の数の配列で、最初が経度、2つめが緯度 */
const checkPosition = (position: unknown): CoordinateCheck => {
  if (
    !isArray(position) ||
    position.length < 2 ||
    !position.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return "malformed";
  }
  const [lon, lat] = position;
  return typeof lon === "number" &&
    typeof lat === "number" &&
    lon >= LON_RANGE.min &&
    lon <= LON_RANGE.max &&
    lat >= LAT_RANGE.min &&
    lat <= LAT_RANGE.max
    ? "ok"
    : "out-of-range";
};

const checkArray = (
  value: unknown,
  minLength: number,
  item: (v: unknown) => CoordinateCheck,
): CoordinateCheck => {
  if (!isArray(value) || value.length < minLength) {
    return "malformed";
  }
  let result: CoordinateCheck = "ok";
  for (const v of value) {
    result = worse(result, item(v));
    if (result === "malformed") {
      return result;
    }
  }
  return result;
};

const samePosition = (a: unknown, b: unknown): boolean =>
  isArray(a) && isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** 線形リング。4つ以上の位置で、最初と最後が同じ */
const checkRing = (ring: unknown): CoordinateCheck => {
  const result = checkArray(ring, 4, checkPosition);
  return result !== "malformed" && isArray(ring) && !samePosition(ring[0], ring.at(-1))
    ? "malformed"
    : result;
};

const checkLine = (line: unknown) => checkArray(line, 2, checkPosition);
const checkPolygon = (polygon: unknown) => checkArray(polygon, 1, checkRing);

const checkCoordinates = (type: string, coordinates: unknown): CoordinateCheck => {
  switch (type) {
    case "Point":
      return checkPosition(coordinates);
    case "LineString":
      return checkLine(coordinates);
    case "MultiLineString":
      return checkArray(coordinates, 0, checkLine);
    case "Polygon":
      return checkPolygon(coordinates);
    case "MultiPolygon":
      return checkArray(coordinates, 0, checkPolygon);
    default:
      return "malformed";
  }
};

/** properties の値の型を、名前ごとにまとめる */
const inferAttributes = (
  properties: readonly (Readonly<Record<string, unknown>> | null)[],
): readonly ColumnSchema[] => {
  const types = new Map<string, ColumnType | null>();
  for (const props of properties) {
    if (props === null) {
      continue;
    }
    for (const [name, value] of Object.entries(props)) {
      const seen = types.get(name) ?? null;
      const type: ColumnType | null =
        value === null
          ? null
          : typeof value === "number"
            ? "float"
            : typeof value === "string"
              ? "string"
              : "other";
      if (type === null) {
        types.set(name, seen);
      } else {
        types.set(name, seen === null || seen === type ? type : "other");
      }
    }
  }
  return [...types].map(([name, type]) => ({ name, type: type ?? "other" }));
};

/** 点の座標（検査済み）と属性から、列を作る */
const pointTable = (
  coordinates: readonly unknown[],
  properties: readonly (Readonly<Record<string, unknown>> | null)[],
  attributes: readonly ColumnSchema[],
): NonNullable<AcceptedGeoJson["points"]> => {
  const n = coordinates.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  coordinates.forEach((position, i) => {
    const [x, y] = isArray(position) ? position : [];
    lon[i] = typeof x === "number" ? x : Number.NaN;
    lat[i] = typeof y === "number" ? y : Number.NaN;
  });
  const numeric: Record<string, Float64Array> = {};
  for (const { name, type } of attributes) {
    if (type === "float") {
      numeric[name] = Float64Array.from(properties, (props) => {
        const value = props?.[name];
        return typeof value === "number" ? value : Number.NaN;
      });
    }
  }
  return { lat, lon, numeric };
};

/** GeoJSON を検査する。input は JSON.parse の戻り値 */
export const checkGeoJson = (input: unknown): Result<AcceptedGeoJson, GeoJsonRejection> => {
  if (!isRecord(input)) {
    return err({ kind: "not-feature-collection" });
  }
  const { type, features, crs } = input;
  if (type !== "FeatureCollection" || !isArray(features)) {
    return err({ kind: "not-feature-collection" });
  }
  if ("crs" in input && !isCrs84(crs)) {
    return err({ kind: "unsupported-crs" });
  }
  if (features.length === 0) {
    return err({ kind: "no-features" });
  }

  const collectors = {
    feature: violationCollector("feature" as const),
    "geometry-null": violationCollector("geometry-null" as const),
    "geometry-type": violationCollector("geometry-type" as const),
    coordinates: violationCollector("coordinates" as const),
    "coordinate-range": violationCollector("coordinate-range" as const),
    "single-geometry-kind": violationCollector("single-geometry-kind" as const),
  };
  const accepted: unknown[] = [];
  const properties: (Readonly<Record<string, unknown>> | null)[] = [];
  let firstKind: GeometryKind | null = null;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (!isRecord(feature)) {
      collectors.feature.add(i);
      continue;
    }
    const { type: featureType, properties: props, geometry } = feature;
    if (featureType !== "Feature" || !(props === null || isRecord(props))) {
      collectors.feature.add(i);
      continue;
    }
    if (geometry === null || geometry === undefined) {
      collectors["geometry-null"].add(i);
      continue;
    }
    const { type: geometryType, coordinates } = isRecord(geometry) ? geometry : {};
    const kind = typeof geometryType === "string" ? GEOMETRY_KINDS[geometryType] : undefined;
    if (typeof geometryType !== "string" || kind === undefined) {
      collectors["geometry-type"].add(i);
      continue;
    }
    const check = checkCoordinates(geometryType, coordinates);
    if (check === "malformed") {
      collectors.coordinates.add(i);
      continue;
    }
    if (check === "out-of-range") {
      collectors["coordinate-range"].add(i);
      continue;
    }
    firstKind = firstKind ?? kind;
    if (kind !== firstKind) {
      collectors["single-geometry-kind"].add(i);
      continue;
    }
    accepted.push(coordinates);
    properties.push(props);
  }

  const violations = Object.values(collectors)
    .map((c) => c.result())
    .filter((v): v is Violation<GeoJsonCondition> => v !== null);
  if (violations.length > 0 || firstKind === null) {
    return err({ kind: "invalid-features", violations });
  }
  const geometryKind: GeometryKind = firstKind;
  const attributes = inferAttributes(properties);
  return ok({
    geometryKind,
    featureCount: features.length,
    attributes,
    points: geometryKind === "point" ? pointTable(accepted, properties, attributes) : null,
  });
};
