// 選んでいる単位、指標、年の塗り分けの値と階級区分を作る（docs/design/map-and-hosting.md の「描画の流れ」）。
// 列を読むのは base-data.ts と datasets.ts、値と区切りの計算は core の関数で行う。

import type { Classification } from "../core/classify/classify";
import {
  classificationOf,
  JOINED_CLASSIFICATION_YEAR,
  joinedClassification,
} from "../core/classify/scales";
import type { PopulationIndicatorId, Unit } from "../core/indicators/definitions";
import { meshColumnsToRead } from "../core/indicators/definitions";
import { computeMeshIndicator } from "../core/indicators/mesh";
import { computeMunicipalIndicator } from "../core/indicators/municipal";
import { measureValues } from "../core/join/aggregate";
import {
  completeCodeValues,
  perPopulationByCode,
  perPopulationByMesh,
} from "../core/join/per-population";
import { buildMeshGeometry, type MeshGeometry } from "../core/mesh/geometry";
import {
  isInRegion,
  isWholeCountry,
  type Region,
  regionKey,
  restrictCodeValues,
  restrictMeshValues,
} from "../core/region/region";
import { err, ok, type Result } from "../core/result";
import type { AppState, IndicatorSelection } from "../core/state/state";
import type { DatasetEntry } from "../core/storage/manifest";
import type { BaseData } from "./base-data";
import type { DatasetCache } from "./datasets";
import type { AppError } from "./ports";

/**
 * 塗り分けの値。メッシュは geometry と同じ順の値、行政区域は団体コードごとの値。
 * メッシュの codes は値の順のメッシュコードで、ベースデータの指標では MeshBase.codes そのもの、
 * 結合した指標では集計したメッシュ（MeshAggregate.keys）である。
 * 地域モードでは、メッシュは地域のものだけを持ち、行政区域は地域の外の値を値なし（NaN）にする
 */
export type Choropleth =
  | {
      readonly unit: "mesh";
      readonly codes: Uint32Array;
      readonly geometry: MeshGeometry;
      readonly values: ArrayLike<number>;
      readonly classification: Classification;
      readonly joined: boolean;
    }
  | {
      readonly unit: "municipality";
      readonly values: ReadonlyMap<string, number>;
      readonly classification: Classification;
      readonly joined: boolean;
    };

/** 塗り分けを決める状態 */
export type ChoroplethState = Pick<AppState, "unit" | "year" | "indicator" | "region">;

/**
 * 塗り分けを決める状態の組を表す文字列。同じなら塗り分けを作り直さない。
 * 地図の deck.gl のレイヤーに渡す colorKey にも使う（色を作り直したことを知らせる）。
 */
export const choroplethKey = (state: ChoroplethState): string => {
  const { unit, year, indicator } = state;
  const scope = `${regionKey(state.region)}/${unit}/${year}`;
  switch (indicator.kind) {
    case "base":
      return `${scope}/base/${indicator.id}`;
    case "joined": {
      const { measure, perPopulation } = indicator;
      const measureKey = measure.kind === "count" ? "count" : `sum:${measure.column}`;
      const per = perPopulation === null ? "none" : `${perPopulation.base}:${perPopulation.per}`;
      return `${scope}/joined/${indicator.datasetId}/${measureKey}/${per}`;
    }
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};

const indicatorError = (message: string): AppError => ({
  kind: "base-data",
  file: "mesh_indicators.parquet",
  message,
});

type Sources = { readonly base: BaseData; readonly datasets: DatasetCache };

/** メッシュのベースの指標の値。行の順は、その地域の MeshBase.codes と同じ */
const baseMeshValues = async (
  base: BaseData,
  region: Region,
  id: Parameters<typeof computeMeshIndicator>[0],
  year: number,
): Promise<Result<Float32Array, AppError>> => {
  const mesh = await base.mesh(region);
  if (!mesh.ok) {
    return mesh;
  }
  const columns = await base.meshColumns(region, meshColumnsToRead(id, year));
  if (!columns.ok) {
    return columns;
  }
  const values = computeMeshIndicator(id, year, columns.value, mesh.value.codes.length);
  return values.ok ? values : err(indicatorError(JSON.stringify(values.error)));
};

const baseMunicipalValues = async (
  base: BaseData,
  id: Parameters<typeof computeMunicipalIndicator>[1],
  year: number,
): Promise<Result<ReadonlyMap<string, number>, AppError>> => {
  const municipal = await base.municipal();
  if (!municipal.ok) {
    return municipal;
  }
  const values = computeMunicipalIndicator(municipal.value.table, id, year);
  return values.ok
    ? values
    : err({
        kind: "base-data",
        file: "municipal_indicators.parquet",
        message: JSON.stringify(values.error),
      });
};

type JoinedSelection = Extract<IndicatorSelection, { readonly kind: "joined" }>;

const findDataset = (
  datasets: readonly DatasetEntry[],
  id: string,
): Result<DatasetEntry, AppError> => {
  const entry = datasets.find((d) => d.id === id);
  return entry === undefined ? err({ kind: "dataset", id, message: "目録にない" }) : ok(entry);
};

/**
 * 結合の集計を、地域のメッシュだけにする。全国ならそのまま返す。
 * 地域のメッシュは、地域のベースデータにあるメッシュである。ベースデータにないメッシュ（人のいないメッシュ）は、
 * どの都道府県のものかを決める材料がないので、地域モードでは描かない
 */
const scopedMeshJoin = async (
  sources: Sources,
  region: Region,
  join: { readonly keys: Uint32Array; readonly geometry: MeshGeometry },
  numerators: ArrayLike<number>,
): Promise<
  Result<
    {
      readonly keys: Uint32Array;
      readonly geometry: MeshGeometry;
      readonly numerators: ArrayLike<number>;
    },
    AppError
  >
> => {
  if (isWholeCountry(region)) {
    return ok({ ...join, numerators });
  }
  const mesh = await sources.base.mesh(region);
  if (!mesh.ok) {
    return mesh;
  }
  const scoped = restrictMeshValues(join.keys, numerators, mesh.value.lookup);
  return ok({
    keys: scoped.meshes,
    geometry: buildMeshGeometry(scoped.meshes),
    numerators: scoped.values,
  });
};

const joinedMesh = async (
  sources: Sources,
  entry: DatasetEntry,
  indicator: JoinedSelection,
  year: number,
  region: Region,
): Promise<Result<Choropleth, AppError>> => {
  const join = await sources.datasets.meshJoin(entry);
  if (!join.ok) {
    return join;
  }
  const all = measureValues(join.value.aggregate, indicator.measure);
  if (all === null) {
    return err({ kind: "dataset", id: entry.id, message: "合計する列がない" });
  }
  const scoped = await scopedMeshJoin(
    sources,
    region,
    { keys: join.value.aggregate.keys, geometry: join.value.geometry },
    all,
  );
  if (!scoped.ok) {
    return scoped;
  }
  const { keys, geometry, numerators } = scoped.value;
  const { perPopulation } = indicator;
  if (perPopulation === null) {
    return ok({
      unit: "mesh",
      codes: keys,
      geometry,
      values: numerators,
      // 区切りは、表示している地域の値の分位で決める
      classification: joinedClassification(numerators),
      joined: true,
    });
  }
  const mesh = await sources.base.mesh(region);
  if (!mesh.ok) {
    return mesh;
  }
  const perPopulationAt = async (y: number): Promise<Result<Float32Array, AppError>> => {
    const baseValues = await baseMeshValues(sources.base, region, perPopulation.base, y);
    return baseValues.ok
      ? ok(
          perPopulationByMesh({
            meshes: keys,
            numerators,
            lookup: mesh.value.lookup,
            baseValues: baseValues.value,
            per: perPopulation.per,
          }),
        )
      : baseValues;
  };
  const values = await perPopulationAt(year);
  if (!values.ok) {
    return values;
  }
  // 区切りは年をまたいで固定するので、決まった年の分母で作る
  const forBreaks =
    year === JOINED_CLASSIFICATION_YEAR
      ? values
      : await perPopulationAt(JOINED_CLASSIFICATION_YEAR);
  if (!forBreaks.ok) {
    return forBreaks;
  }
  return ok({
    unit: "mesh",
    codes: keys,
    geometry,
    values: values.value,
    classification: joinedClassification(forBreaks.value),
    joined: true,
  });
};

/**
 * 行政区域ごとの値を、地図で塗るすべての地域に広げる。
 * 点の件数では、点のない地域を 0 にする。表の値と合計では値なし（透明）にする（core の completeCodeValues）。
 */
const fillValue = (entry: DatasetEntry, indicator: JoinedSelection): number =>
  entry.kind === "point" && indicator.measure.kind === "count" ? 0 : Number.NaN;

/** 区切りを作る値。地域の区域の値だけを使う（地域の外は値なしにしてあるので、分位に入らない） */
const classificationValues = (values: ReadonlyMap<string, number>, region: Region): number[] =>
  [...values].filter(([code]) => isInRegion(code, region)).map(([, value]) => value);

const joinedMunicipal = async (
  sources: Sources,
  entry: DatasetEntry,
  indicator: JoinedSelection,
  year: number,
  region: Region,
): Promise<Result<Choropleth, AppError>> => {
  const aggregate = await sources.datasets.codeJoin(entry);
  if (!aggregate.ok) {
    return aggregate;
  }
  const numerators = measureValues(aggregate.value, indicator.measure);
  if (numerators === null) {
    return err({ kind: "dataset", id: entry.id, message: "合計する列がない" });
  }
  const municipal = await sources.base.municipal();
  if (!municipal.ok) {
    return municipal;
  }
  const completed = restrictCodeValues(
    completeCodeValues(
      aggregate.value.keys,
      numerators,
      municipal.value.paintedCodes,
      fillValue(entry, indicator),
    ),
    region,
  );
  const { perPopulation } = indicator;
  if (perPopulation === null) {
    return ok({
      unit: "municipality",
      values: completed,
      classification: joinedClassification(classificationValues(completed, region)),
      joined: true,
    });
  }
  const codes = [...completed.keys()];
  const counts = [...completed.values()];
  const perPopulationAt = async (
    y: number,
    base: PopulationIndicatorId,
  ): Promise<Result<ReadonlyMap<string, number>, AppError>> => {
    const baseValues = await baseMunicipalValues(sources.base, base, y);
    return baseValues.ok
      ? ok(
          perPopulationByCode({
            codes,
            numerators: counts,
            baseValues: baseValues.value,
            per: perPopulation.per,
          }),
        )
      : baseValues;
  };
  const values = await perPopulationAt(year, perPopulation.base);
  if (!values.ok) {
    return values;
  }
  const forBreaks =
    year === JOINED_CLASSIFICATION_YEAR
      ? values
      : await perPopulationAt(JOINED_CLASSIFICATION_YEAR, perPopulation.base);
  if (!forBreaks.ok) {
    return forBreaks;
  }
  return ok({
    unit: "municipality",
    values: values.value,
    classification: joinedClassification([...forBreaks.value.values()]),
    joined: true,
  });
};

const joinedChoropleth = (
  sources: Sources,
  unit: Unit,
  entry: DatasetEntry,
  indicator: JoinedSelection,
  year: number,
  region: Region,
): Promise<Result<Choropleth, AppError>> =>
  unit === "mesh"
    ? joinedMesh(sources, entry, indicator, year, region)
    : joinedMunicipal(sources, entry, indicator, year, region);

/** いまの状態の塗り分けを作る。指標が塗れることは core の reduce が保っている */
export const computeChoropleth = async (
  sources: Sources,
  state: ChoroplethState & Pick<AppState, "datasets">,
): Promise<Result<Choropleth, AppError>> => {
  const { unit, year, indicator, region } = state;
  switch (indicator.kind) {
    case "base": {
      if (unit === "mesh") {
        const mesh = await sources.base.mesh(region);
        if (!mesh.ok) {
          return mesh;
        }
        const values = await baseMeshValues(sources.base, region, indicator.id, year);
        return values.ok
          ? ok({
              unit,
              codes: mesh.value.codes,
              geometry: mesh.value.geometry,
              values: values.value,
              classification: classificationOf(indicator.id, unit),
              joined: false,
            })
          : values;
      }
      const values = await baseMunicipalValues(sources.base, indicator.id, year);
      return values.ok
        ? ok({
            unit,
            values: restrictCodeValues(values.value, region),
            classification: classificationOf(indicator.id, unit),
            joined: false,
          })
        : values;
    }
    case "joined": {
      const entry = findDataset(state.datasets, indicator.datasetId);
      return entry.ok
        ? joinedChoropleth(sources, unit, entry.value, indicator, year, region)
        : entry;
    }
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};
