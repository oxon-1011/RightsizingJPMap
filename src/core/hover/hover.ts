// ホバーのカードに出す中身（docs/design/implementation-plan.md の段階 7.5 の 3.）。
// ポインタの下にあったもの（io が MapLibre と deck.gl から集める）と、app が持つ塗り分けの値から、
// カードに出す値を決める。数字の書き方と見出しの文言は ui が決める。

import { meshIndicatorColumns, type PopulationIndicatorId } from "../indicators/definitions";
import type { MunicipalNames } from "../indicators/municipal";
import type { MeshLookup } from "../join/per-population";
import { latLonToMeshCode } from "../mesh/mesh-code";
import type { IndicatorSelection } from "../state/state";

/** カードに出す値。秘匿（D7）と値なしを、数と分けて持つ */
export type HoverValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "masked" }
  | { readonly kind: "none" };

/** ポインタの下にあったもの。io が地図から集めて渡す */
export type HoverHit = {
  readonly lon: number;
  readonly lat: number;
  /** 市区町村の塗りの地物の団体コード。市区町村を塗っていないときと、区域の外では null */
  readonly municipalityCode: string | null;
  /**
   * いちばん上に描いた自前データの地物（deck.gl の picking の結果）。
   * index は点のレイヤーの点の番号、properties は線と面の GeoJSON の地物の属性で、どちらも検査していない
   */
  readonly feature: {
    readonly layerId: string;
    readonly index: number;
    readonly properties: unknown;
  } | null;
};

/** 塗り分けの値の、カードに出す部分の共通の項目 */
type ChoroplethPart = {
  readonly year: number;
  readonly indicator: IndicatorSelection;
  /** 結合した指標のデータの名前。ベースデータの指標では null */
  readonly datasetName: string | null;
};

/**
 * 塗り分けの値をポインタの位置で引くための持ち物。app が塗り分けを地図に渡すたびに作り直す。
 * どれも app が読んで持っている値を指すだけで、カードのために読み直したものではない（2行目の人数と秘匿の列を除く）。
 * population はカードの2行目の人数で、indicator がその人数の指標（hoverPopulationIndicator）。
 */
export type ChoroplethHoverData =
  | (ChoroplethPart & {
      readonly unit: "mesh";
      /** 塗り分けの値の、メッシュコードから値の番号への対応。結合した指標では集計したメッシュだけを持つ */
      readonly valueRows: MeshLookup;
      readonly values: ArrayLike<number>;
      /** ベースデータの、メッシュコードから行の番号への対応。2行目の人数と秘匿の列はこの行の順 */
      readonly baseRows: MeshLookup;
      /** その年の2行目の人数と、それを秘匿にしたかを決める列（年齢別の人数のときだけ） */
      readonly population: {
        readonly indicator: PopulationIndicatorId;
        readonly values: ArrayLike<number>;
        readonly masked: readonly ArrayLike<number>[];
      } | null;
      /** 値を秘匿として透明にしたかを決める列（D7）。どれかが 0 でなければ秘匿 */
      readonly masked: readonly ArrayLike<number>[];
    })
  | (ChoroplethPart & {
      readonly unit: "municipality";
      readonly values: ReadonlyMap<string, number>;
      /** その年の2行目の人数 */
      readonly population: {
        readonly indicator: PopulationIndicatorId;
        readonly values: ReadonlyMap<string, number>;
      } | null;
      readonly names: MunicipalNames;
    });

/**
 * 自前データのレイヤーの持ち物。点は数値の属性だけをメモリに持つ（文字列の属性は OPFS の Parquet にしかない）。
 * 線と面は、picking の結果の地物の properties を使う。
 */
export type LayerHoverData = {
  readonly datasetId: string;
  readonly name: string;
  readonly pointAttributes: {
    readonly names: readonly string[];
    readonly columns: Readonly<Record<string, ArrayLike<number>>>;
  } | null;
};

export type HoverData = {
  readonly choropleth: ChoroplethHoverData | null;
  /** deck.gl のレイヤーの ID から、そのレイヤーの持ち物 */
  readonly layers: ReadonlyMap<string, LayerHoverData>;
};

/** 自前データの属性1つ。文字列、数、真偽値以外（入れ子のオブジェクトなど）は JSON の文字列にする */
export type HoverAttribute = {
  readonly name: string;
  readonly value: string | number | boolean | null;
};

/** カードの2行目の人数。indicator はその人数の指標（総人口か、人口あたりの値の分母） */
export type HoverPopulation = {
  readonly indicator: PopulationIndicatorId;
  readonly value: HoverValue;
};

export type HoverContent =
  | (ChoroplethPart & {
      readonly kind: "mesh";
      readonly code: number;
      readonly value: HoverValue;
      readonly population: HoverPopulation | null;
    })
  | (ChoroplethPart & {
      readonly kind: "municipality";
      readonly code: string;
      readonly name: string;
      readonly prefecture: string | null;
      readonly value: HoverValue;
      readonly population: HoverPopulation | null;
    })
  | {
      readonly kind: "feature";
      readonly datasetId: string;
      readonly layerName: string;
      readonly attributes: readonly HoverAttribute[];
      /** 出さなかった属性の数 */
      readonly omitted: number;
    };

/** カードに出す属性の数。多いときは先頭からこの数だけ出す */
export const MAX_HOVER_ATTRIBUTES = 5;

const NONE: HoverValue = { kind: "none" };
const MASKED: HoverValue = { kind: "masked" };

const numberValue = (value: number | undefined): HoverValue =>
  value === undefined || Number.isNaN(value) ? NONE : { kind: "number", value };

/**
 * カードの2行目に出す人数の指標（持ち主の決定、2026-11-10）。
 * 結合した指標の人口あたりの値で、分母が総人口でなければ、その分母の人数を出す（極端な値の理由が分母の少なさにあるため）。
 * それ以外は、その年の総人口を出す。指標が総人口なら、同じ値を2回出さないよう null にする。
 */
export const hoverPopulationIndicator = (
  indicator: IndicatorSelection,
): PopulationIndicatorId | null => {
  switch (indicator.kind) {
    case "base":
      return indicator.id === "pop" ? null : "pop";
    case "joined":
      return indicator.perPopulation === null ? "pop" : indicator.perPopulation.base;
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};

type ColumnSource = { readonly value: string; readonly masked: string | null };

/** 指標の計算に使う人数の列（総数と年齢別）。選べない年なら空 */
const sourcesOf = (
  id: Parameters<typeof meshIndicatorColumns>[0],
  year: number,
): readonly ColumnSource[] => {
  const plan = meshIndicatorColumns(id, year);
  if (plan === null) {
    return [];
  }
  switch (plan.kind) {
    case "count":
      return [plan.value];
    case "ratio":
      return [plan.numerator, plan.denominator];
    case "change":
      return [plan.current, plan.base];
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
};

const maskedColumnsOf = (sources: readonly ColumnSource[]): readonly string[] => [
  ...new Set(sources.flatMap((s) => (s.masked === null ? [] : [s.masked]))),
];

/**
 * メッシュのカードのために、塗り分けの列のほかに読む列。
 * - population：2行目の人数の列と、それを秘匿にしたかを決める秘匿の列。2行目がないか、選べない年なら null
 * - masked：値を秘匿として透明にしたかを決める秘匿の列（D7）。結合した指標の人口あたりの値は、分母の指標の秘匿の列で決まる
 */
export const meshHoverColumns = (
  indicator: IndicatorSelection,
  year: number,
): {
  readonly population: {
    readonly indicator: PopulationIndicatorId;
    readonly value: string;
    readonly masked: readonly string[];
  } | null;
  readonly masked: readonly string[];
} => {
  const populationIndicator = hoverPopulationIndicator(indicator);
  const [populationSource] =
    populationIndicator === null ? [] : sourcesOf(populationIndicator, year);
  const maskedBy =
    indicator.kind === "base"
      ? indicator.id
      : indicator.perPopulation === null
        ? null
        : indicator.perPopulation.base;
  return {
    population:
      populationIndicator === null || populationSource === undefined
        ? null
        : {
            indicator: populationIndicator,
            value: populationSource.value,
            masked: maskedColumnsOf([populationSource]),
          },
    masked: maskedBy === null ? [] : maskedColumnsOf(sourcesOf(maskedBy, year)),
  };
};

/** 秘匿の列のどれかが 0 でなければ秘匿。NaN は io の誤りなので、indicators/mesh.ts と同じく値なしとして扱う */
const isMaskedAt = (masked: readonly ArrayLike<number>[], row: number): boolean =>
  masked.some((column) => {
    const flag = column[row];
    return flag !== undefined && !Number.isNaN(flag) && flag !== 0;
  });

const meshContent = (
  data: Extract<ChoroplethHoverData, { readonly unit: "mesh" }>,
  hit: HoverHit,
): HoverContent | null => {
  const code = latLonToMeshCode(hit);
  const valueRow = data.valueRows.get(code);
  const baseRow = data.baseRows.get(code);
  // 塗り分けにもベースデータにもないメッシュ（海や、2020 年に人が住んでいなかった場所）には出さない
  if (valueRow === undefined && baseRow === undefined) {
    return null;
  }
  const raw = valueRow === undefined ? undefined : data.values[valueRow];
  const value =
    raw !== undefined && !Number.isNaN(raw)
      ? numberValue(raw)
      : baseRow !== undefined && isMaskedAt(data.masked, baseRow)
        ? MASKED
        : NONE;
  const { population: source } = data;
  const population =
    source === null
      ? null
      : {
          indicator: source.indicator,
          value:
            baseRow === undefined
              ? NONE
              : isMaskedAt(source.masked, baseRow)
                ? MASKED
                : numberValue(source.values[baseRow]),
        };
  return {
    kind: "mesh",
    code,
    year: data.year,
    indicator: data.indicator,
    datasetName: data.datasetName,
    value,
    population,
  };
};

const municipalityContent = (
  data: Extract<ChoroplethHoverData, { readonly unit: "municipality" }>,
  hit: HoverHit,
): HoverContent | null => {
  const code = hit.municipalityCode;
  const name = code === null ? undefined : data.names.areas.get(code);
  // 値の表にない区域（値のない北方領土の6村）には出さない。メッシュでベースデータにないメッシュに出さないのと同じ
  if (code === null || name === undefined) {
    return null;
  }
  return {
    kind: "municipality",
    code,
    name,
    prefecture: data.names.prefectures.get(code.slice(0, 2)) ?? null,
    year: data.year,
    indicator: data.indicator,
    datasetName: data.datasetName,
    value: numberValue(data.values.get(code)),
    population:
      data.population === null
        ? null
        : {
            indicator: data.population.indicator,
            value: numberValue(data.population.values.get(code)),
          },
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const attributeValue = (value: unknown): HoverAttribute["value"] => {
  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return value;
  }
  return value === undefined ? null : JSON.stringify(value);
};

/** 属性を先頭から MAX_HOVER_ATTRIBUTES 個だけ出し、残りの数を数える */
const featureContent = (
  layer: LayerHoverData,
  feature: NonNullable<HoverHit["feature"]>,
): HoverContent => {
  const all: readonly HoverAttribute[] =
    layer.pointAttributes !== null
      ? layer.pointAttributes.names.map((name) => ({
          name,
          value: attributeValue(layer.pointAttributes?.columns[name]?.[feature.index]),
        }))
      : isRecord(feature.properties)
        ? Object.entries(feature.properties).map(([name, value]) => ({
            name,
            value: attributeValue(value),
          }))
        : [];
  return {
    kind: "feature",
    datasetId: layer.datasetId,
    layerName: layer.name,
    attributes: all.slice(0, MAX_HOVER_ATTRIBUTES),
    omitted: Math.max(0, all.length - MAX_HOVER_ATTRIBUTES),
  };
};

/**
 * ポインタの下のもののカードの中身。いちばん上の自前データの地物を、塗り分けより先に出す。
 * カードを出さない場所（塗り分けのない場所、データを作る前）では null。
 */
export const hoverContent = (data: HoverData, hit: HoverHit): HoverContent | null => {
  if (hit.feature !== null) {
    const layer = data.layers.get(hit.feature.layerId);
    if (layer !== undefined) {
      return featureContent(layer, hit.feature);
    }
  }
  const { choropleth } = data;
  if (choropleth === null) {
    return null;
  }
  switch (choropleth.unit) {
    case "mesh":
      return meshContent(choropleth, hit);
    case "municipality":
      return municipalityContent(choropleth, hit);
    default: {
      const unreachable: never = choropleth;
      return unreachable;
    }
  }
};
