// ホバーのカード（docs/design/implementation-plan.md の段階 7.5 の 3.）。
// 地図のポインタの知らせ（io の watchPointer）を受け、core の hoverContent でカードの中身を作る。
// カードの位置はポインタを動かすたびに変わるので、画面全体のストア（store.ts）とは別の小さなストアに置く。
// 画面全体のストアに置くと、ストアを読む部品とストアの購読（地図の描き直しの判断）が、フレームごとに呼ばれる。

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  type ChoroplethHoverData,
  type HoverContent,
  type HoverData,
  hoverContent,
  hoverPopulationIndicator,
  type LayerHoverData,
  meshHoverColumns,
} from "../core/hover/hover";
import { numericColumn } from "../core/indicators/columns";
import { computeMunicipalIndicator } from "../core/indicators/municipal";
import { indexMeshes, type MeshLookup } from "../core/join/per-population";
import { err, ok, type Result } from "../core/result";
import type { AppState } from "../core/state/state";
import { type DatasetEntry, summableColumns } from "../core/storage/manifest";
import type { MapPointerEvent } from "../io/map";
import type { BaseData } from "./base-data";
import type { Choropleth } from "./choropleth";
import type { DatasetCache } from "./datasets";
import { datasetLayerId } from "./overlays";
import type { AppError } from "./ports";

/** 画面に出しているカード。x と y はポインタの位置、width と height は地図の要素の大きさ（どれも px） */
export type HoverCard = {
  readonly content: HoverContent;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type HoverStoreState = { readonly card: HoverCard | null };

export type HoverStore = StoreApi<HoverStoreState>;

/** 地図に渡した塗り分けと、それを作った状態 */
export type AppliedChoropleth = {
  readonly choropleth: Choropleth;
  readonly state: Pick<AppState, "unit" | "year" | "indicator">;
};

/** カードの中身を作る材料。地図を描き直すたびに app が渡す */
export type HoverInputs = {
  /** 地図に渡した塗り分け。まだ描いていなければ null */
  readonly applied: AppliedChoropleth | null;
  readonly datasets: readonly DatasetEntry[];
};

type Sources = {
  readonly base: BaseData;
  readonly datasets: DatasetCache;
  readonly report: (error: AppError) => void;
};

/** 結合した指標の集計したメッシュの、メッシュコードから値の番号への対応。集計ごとに一度だけ作る */
const joinedRows = new WeakMap<Uint32Array, MeshLookup>();

const rowsOf = (
  codes: Uint32Array,
  base: { readonly codes: Uint32Array; readonly lookup: MeshLookup },
): MeshLookup => {
  if (codes === base.codes) {
    return base.lookup;
  }
  const cached = joinedRows.get(codes);
  if (cached !== undefined) {
    return cached;
  }
  const rows = indexMeshes(codes);
  joinedRows.set(codes, rows);
  return rows;
};

const datasetNameOf = (
  applied: AppliedChoropleth,
  datasets: readonly DatasetEntry[],
): string | null => {
  const { indicator } = applied.state;
  return indicator.kind === "joined"
    ? (datasets.find((d) => d.id === indicator.datasetId)?.name ?? null)
    : null;
};

const meshData = async (
  sources: Sources,
  applied: AppliedChoropleth,
  choropleth: Extract<Choropleth, { readonly unit: "mesh" }>,
  datasetName: string | null,
): Promise<Result<ChoroplethHoverData, AppError>> => {
  const { year, indicator } = applied.state;
  const mesh = await sources.base.mesh();
  if (!mesh.ok) {
    return mesh;
  }
  // 塗り分けに使った列は持ち回っているので、読み直さない。2行目の人数の列だけが新しく読むことがある
  const columns = meshHoverColumns(indicator, year);
  const second = columns.population;
  const names = [
    ...new Set([...(second === null ? [] : [second.value, ...second.masked]), ...columns.masked]),
  ];
  const read = await sources.base.meshColumns(names);
  if (!read.ok) {
    return read;
  }
  const length = mesh.value.codes.length;
  const pick = (name: string): Result<ArrayLike<number>, AppError> => {
    const column = numericColumn(read.value, name, length);
    return column.ok
      ? column
      : err({
          kind: "base-data",
          file: "mesh_indicators.parquet",
          message: JSON.stringify(column.error),
        });
  };
  const pickAll = (list: readonly string[]): Result<ArrayLike<number>[], AppError> => {
    const picked: ArrayLike<number>[] = [];
    for (const name of list) {
      const column = pick(name);
      if (!column.ok) {
        return column;
      }
      picked.push(column.value);
    }
    return ok(picked);
  };
  const masked = pickAll(columns.masked);
  if (!masked.ok) {
    return masked;
  }
  const secondValues = second === null ? ok(null) : pick(second.value);
  if (!secondValues.ok) {
    return secondValues;
  }
  const secondMasked = pickAll(second?.masked ?? []);
  if (!secondMasked.ok) {
    return secondMasked;
  }
  const population =
    second === null || secondValues.value === null
      ? null
      : { indicator: second.indicator, values: secondValues.value, masked: secondMasked.value };
  return ok({
    unit: "mesh",
    year,
    indicator,
    datasetName,
    valueRows: rowsOf(choropleth.codes, mesh.value),
    values: choropleth.values,
    baseRows: mesh.value.lookup,
    population,
    masked: masked.value,
  });
};

const municipalData = async (
  sources: Sources,
  applied: AppliedChoropleth,
  choropleth: Extract<Choropleth, { readonly unit: "municipality" }>,
  datasetName: string | null,
): Promise<Result<ChoroplethHoverData, AppError>> => {
  const { year, indicator } = applied.state;
  const municipal = await sources.base.municipal();
  if (!municipal.ok) {
    return municipal;
  }
  const secondIndicator = hoverPopulationIndicator(indicator);
  const second =
    secondIndicator === null
      ? ok(null)
      : computeMunicipalIndicator(municipal.value.table, secondIndicator, year);
  if (!second.ok) {
    return err({
      kind: "base-data",
      file: "municipal_indicators.parquet",
      message: JSON.stringify(second.error),
    });
  }
  const population =
    secondIndicator === null || second.value === null
      ? null
      : { indicator: secondIndicator, values: second.value };
  return ok({
    unit: "municipality",
    year,
    indicator,
    datasetName,
    values: choropleth.values,
    population,
    names: municipal.value.names,
  });
};

const choroplethData = (
  sources: Sources,
  applied: AppliedChoropleth,
  datasets: readonly DatasetEntry[],
): Promise<Result<ChoroplethHoverData, AppError>> => {
  const { choropleth } = applied;
  const datasetName = datasetNameOf(applied, datasets);
  switch (choropleth.unit) {
    case "mesh":
      return meshData(sources, applied, choropleth, datasetName);
    case "municipality":
      return municipalData(sources, applied, choropleth, datasetName);
    default: {
      const unreachable: never = choropleth;
      return unreachable;
    }
  }
};

/**
 * 自前データのレイヤーの持ち物。点は OPFS から読み直したときに持った数値の属性だけを使い、カードのために読み直さない。
 * 読めなかったデータは、レイヤーを作るとき（overlays.ts）に知らせているので、ここでは除くだけにする。
 */
const layerData = async (
  datasets: DatasetCache,
  entries: readonly DatasetEntry[],
): Promise<ReadonlyMap<string, LayerHoverData>> => {
  const layers = await Promise.all(
    entries
      .filter((entry) => entry.kind !== "table")
      .map(async (entry): Promise<readonly [string, LayerHoverData] | null> => {
        const base = { datasetId: entry.id, name: entry.name };
        if (entry.kind !== "point") {
          return [datasetLayerId(entry.id), { ...base, pointAttributes: null }];
        }
        const loaded = await datasets.load(entry);
        if (!loaded.ok || loaded.value.kind !== "point") {
          return null;
        }
        const { numeric } = loaded.value;
        const names = summableColumns(entry).filter((name) => Object.hasOwn(numeric, name));
        return [
          datasetLayerId(entry.id),
          { ...base, pointAttributes: { names, columns: numeric } },
        ];
      }),
  );
  return new Map(layers.filter((layer) => layer !== null));
};

const buildHoverData = async (sources: Sources, inputs: HoverInputs): Promise<HoverData> => {
  const [choropleth, layers] = await Promise.all([
    inputs.applied === null
      ? Promise.resolve(null)
      : choroplethData(sources, inputs.applied, inputs.datasets),
    layerData(sources.datasets, inputs.datasets),
  ]);
  if (choropleth !== null && !choropleth.ok) {
    sources.report(choropleth.error);
  }
  return { choropleth: choropleth?.ok === true ? choropleth.value : null, layers };
};

export type Hover = {
  readonly store: HoverStore;
  /** 地図を描き直したときに呼ぶ。ポインタが地図の上にあれば、新しい塗り分けでカードを作り直す */
  readonly update: (inputs: HoverInputs) => void;
  /** 地図のポインタの知らせ */
  readonly onPointer: (event: MapPointerEvent) => void;
  /** カードを消す（地図を片付けたとき） */
  readonly clear: () => void;
};

type HoverEvent = Extract<MapPointerEvent, { readonly kind: "hover" }>;

export const createHover = (sources: Sources): Hover => {
  const store = createStore<HoverStoreState>()(() => ({ card: null }));
  let inputs: HoverInputs | null = null;
  /** inputs を変えるたびに増やす。古い材料で作り終えた結果は使わない */
  let generation = 0;
  let data: HoverData | null = null;
  let building = false;
  /** 最後のポインタの知らせ。ポインタが地図の外にあるか、地図が動いているあいだは null */
  let last: HoverEvent | null = null;

  const show = (): void => {
    if (last === null || data === null) {
      return;
    }
    const content = hoverContent(data, last.hit);
    const { x, y, width, height } = last;
    store.setState({ card: content === null ? null : { content, x, y, width, height } });
  };

  /** 材料からカードの持ち物を作る。作り終えたら、最後のポインタの位置でカードを出す */
  const build = (): void => {
    if (inputs === null || data !== null || building) {
      return;
    }
    building = true;
    const started = generation;
    buildHoverData(sources, inputs)
      .then((built) => {
        if (started !== generation) {
          return;
        }
        building = false;
        data = built;
        show();
      })
      .catch((e: unknown) => {
        // プログラムの誤り。次の知らせで作り直せるようにする
        if (started === generation) {
          building = false;
        }
        sources.report({ kind: "unexpected", message: e instanceof Error ? e.message : String(e) });
      });
  };

  const update = (next: HoverInputs): void => {
    inputs = next;
    generation++;
    data = null;
    building = false;
    // 作り直すあいだは、前のカードを残す（年を切り替えるたびにカードが消えて点滅しないように）
    if (last !== null) {
      build();
    }
  };

  const clear = (): void => {
    last = null;
    if (store.getState().card !== null) {
      store.setState({ card: null });
    }
  };

  const onPointer = (event: MapPointerEvent): void => {
    if (event.kind === "leave") {
      clear();
      return;
    }
    last = event;
    if (data === null) {
      build();
      return;
    }
    show();
  };

  return { store, update, onPointer, clear };
};
