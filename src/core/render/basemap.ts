// 背景地図のレイヤーの表示の切り替え（docs/design/implementation-plan.md の段階 7.5 の 5.）。
// 切り替えの単位（鉄道、道路、川）はここで決める。単位ごとのスタイルのレイヤーの ID は、
// 背景地図のスタイルの metadata の rjm:layerGroups に書く。スタイルを差し替えても、ここと画面は変えずに済む。

import { err, ok, type Result } from "../result";

/** 表示を切り替える単位。鉄道は地上、地下、破線の3つのレイヤーをまとめて切り替える */
export const BASEMAP_LAYER_GROUPS = ["rail", "road", "river"] as const;

export type BasemapLayerGroup = (typeof BASEMAP_LAYER_GROUPS)[number];

/** 単位ごとに表示するか */
export type BasemapVisibility = Readonly<Record<BasemapLayerGroup, boolean>>;

/** すべて表示する。背景地図のスタイルの既定と同じ */
export const ALL_BASEMAP_LAYERS_VISIBLE: BasemapVisibility = {
  rail: true,
  road: true,
  river: true,
};

/** 単位ごとの、背景地図のスタイルのレイヤーの ID */
export type BasemapLayerIds = Readonly<Record<BasemapLayerGroup, readonly string[]>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGroup = (key: string): boolean => (BASEMAP_LAYER_GROUPS as readonly string[]).includes(key);

/** 1つ以上のレイヤーの ID の配列 */
const parseIds = (value: unknown): readonly string[] | null =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((id): id is string => typeof id === "string")
    ? value
    : null;

/**
 * スタイルの metadata の rjm:layerGroups を検査する。
 * 3つの単位のすべてに、1つ以上のレイヤーの ID の配列を書く。ほかの単位は受け付けない。
 * レイヤーがスタイルにあるかは、スタイルを読んだ io が確かめる。
 */
export const parseBasemapLayerIds = (value: unknown): Result<BasemapLayerIds, string> => {
  if (!isRecord(value)) {
    return err("単位からレイヤーの ID の配列への対応にする");
  }
  const unknownKeys = Object.keys(value).filter((key) => !isGroup(key));
  if (unknownKeys.length > 0) {
    return err(`知らない単位: ${unknownKeys.join(", ")}`);
  }
  const { rail: railIds, road: roadIds, river: riverIds } = value;
  const rail = parseIds(railIds);
  const road = parseIds(roadIds);
  const river = parseIds(riverIds);
  if (rail === null || road === null || river === null) {
    const invalid = BASEMAP_LAYER_GROUPS.filter((group) => parseIds(value[group]) === null);
    return err(`1つ以上のレイヤーの ID の配列でない単位: ${invalid.join(", ")}`);
  }
  return ok({ rail, road, river });
};

/** レイヤーの ID ごとの表示。io はこのとおりに MapLibre の layout の visibility を設定する */
export const basemapLayerVisibility = (
  ids: BasemapLayerIds,
  visibility: BasemapVisibility,
): readonly { readonly id: string; readonly visible: boolean }[] =>
  BASEMAP_LAYER_GROUPS.flatMap((group) =>
    ids[group].map((id) => ({ id, visible: visibility[group] })),
  );
