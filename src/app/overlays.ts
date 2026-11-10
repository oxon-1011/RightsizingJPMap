// 自前データの点、線、面のレイヤーの指定を作る（docs/design/map-and-hosting.md の「全体の構成」）。
// 表（code か mesh で結合するもの）は地図に重ねず、指標としてだけ使う。

import { geoJsonLayerSpec, type PointLayerSpec, pointLayerSpec } from "../core/render/overlay";
import type { Result } from "../core/result";
import type { DatasetEntry } from "../core/storage/manifest";
import type { GeoJsonOverlay } from "../io/deck-layers";
import type { DatasetCache, LoadedDataset } from "./datasets";
import type { AppError } from "./ports";

export type DatasetOverlays = {
  readonly points: readonly PointLayerSpec[];
  readonly geoJsons: readonly GeoJsonOverlay[];
};

/** deck.gl のレイヤーの ID。メッシュのレイヤー（MESH_LAYER_ID）と重ならないよう、前に付ける */
export const datasetLayerId = (id: string): string => `rjm-dataset-${id}`;

const NO_COORDINATES = new Float64Array(0);

export const createOverlayBuilder = (deps: {
  readonly datasets: DatasetCache;
  readonly report: (error: AppError) => void;
}) => {
  /** データごとの、座標を詰めた点のレイヤーの指定。スタイルを替えても座標の配列は同じものを使う */
  const pointBases = new Map<string, PointLayerSpec>();

  const pointSpec = (
    entry: DatasetEntry,
    data: Extract<LoadedDataset, { readonly kind: "point" }>,
  ): PointLayerSpec => {
    const id = datasetLayerId(entry.id);
    const base = pointBases.get(entry.id) ?? pointLayerSpec(id, data.lat, data.lon, entry.style);
    pointBases.set(entry.id, base);
    // 色、大きさ、表示の有無は core の pointLayerSpec で決め、座標は前と同じ配列にする。
    // deck.gl は同じ座標の配列なら、座標を転送し直さない（io の deck-layers.ts）
    const styled = pointLayerSpec(id, NO_COORDINATES, NO_COORDINATES, entry.style);
    return { ...styled, length: base.length, positions: base.positions };
  };

  const overlayOf = async (
    entry: DatasetEntry,
  ): Promise<PointLayerSpec | GeoJsonOverlay | null> => {
    if (entry.kind === "table") {
      return null;
    }
    const loaded: Result<LoadedDataset, AppError> = await deps.datasets.load(entry);
    if (!loaded.ok) {
      deps.report(loaded.error);
      return null;
    }
    const data = loaded.value;
    if (data.kind === "point") {
      return pointSpec(entry, data);
    }
    if (data.kind === "shape" && (entry.kind === "line" || entry.kind === "polygon")) {
      return {
        spec: geoJsonLayerSpec(datasetLayerId(entry.id), entry.kind, entry.style),
        data: data.data,
      };
    }
    return null;
  };

  /** 目録の順に、点、線、面のレイヤーの指定を作る。読めなかったデータは report で知らせて除く */
  const build = async (entries: readonly DatasetEntry[]): Promise<DatasetOverlays> => {
    const overlays = await Promise.all(entries.map(overlayOf));
    const points: PointLayerSpec[] = [];
    const geoJsons: GeoJsonOverlay[] = [];
    for (const overlay of overlays) {
      if (overlay === null) {
        continue;
      }
      if ("kind" in overlay) {
        points.push(overlay);
      } else {
        geoJsons.push(overlay);
      }
    }
    return { points, geoJsons };
  };

  const retain = (ids: ReadonlySet<string>): void => {
    for (const id of pointBases.keys()) {
      if (!ids.has(id)) {
        pointBases.delete(id);
      }
    }
  };

  return { build, retain };
};
