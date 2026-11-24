// 背景地図の切り替え（docs/design/ui.md の「地図の設定」）。
// 背景地図の候補と、線と地名の表示を切り替える単位（鉄道、道路、川、地名）はここで決める。
// 候補ごと、単位ごとのスタイルのレイヤーの ID は、背景地図のスタイルの metadata の rjm:basemaps と
// rjm:layerGroups に書く。スタイルを差し替えても、ここと画面は変えずに済む。

import { err, ok, type Result } from "../result";

/** 線と地名の表示を切り替える単位。鉄道は地上、地下、破線の3つのレイヤーをまとめて切り替える */
export const BASEMAP_LAYER_GROUPS = ["rail", "road", "river", "label"] as const;

export type BasemapLayerGroup = (typeof BASEMAP_LAYER_GROUPS)[number];

/** 単位ごとに表示するか */
export type BasemapVisibility = Readonly<Record<BasemapLayerGroup, boolean>>;

/** すべて表示する。背景地図のスタイルの既定と同じ */
export const ALL_BASEMAP_LAYERS_VISIBLE: BasemapVisibility = {
  rail: true,
  road: true,
  river: true,
  label: true,
};

/**
 * 背景地図の候補。塗り分けの下に敷く、陸と海の絵である。
 * - vector：国土地理院の最適化ベクトルタイルを薄い色で描いた、陸と海の塗り（既定）
 * - photo、pale、std、relief：地理院タイルの写真、淡色地図、標準地図、色別標高図（ラスター）
 * - osm：OpenStreetMap の標準のタイル（ラスター）
 */
export const BASEMAP_IDS = ["vector", "photo", "pale", "std", "relief", "osm"] as const;

export type BasemapId = (typeof BASEMAP_IDS)[number];

/** 選んだ背景地図と、単位ごとの表示 */
export type BasemapSelection = {
  readonly id: BasemapId;
  readonly visibility: BasemapVisibility;
};

/** 既定の背景地図。段階 B より前と同じ見た目になる */
export const DEFAULT_BASEMAP: BasemapSelection = {
  id: "vector",
  visibility: ALL_BASEMAP_LAYERS_VISIBLE,
};

const ALL_GROUPS: readonly BasemapLayerGroup[] = BASEMAP_LAYER_GROUPS;

/**
 * 背景地図を選んでいるあいだ、表示の設定にかかわらず隠す単位。
 * 淡色地図、標準地図、OpenStreetMap は、線と地名を画像の中に持つ。ベクトルタイルの線と地名を重ねると、
 * 少しずれた線と、二重の地名になるので、すべて隠す。
 * 写真は線と地名を持たないので残すが、川と湖の水色の塗りは、写真の水面を覆うので隠す。
 */
export const BASEMAP_HIDDEN_GROUPS: Readonly<Record<BasemapId, readonly BasemapLayerGroup[]>> = {
  vector: [],
  photo: ["river"],
  pale: ALL_GROUPS,
  std: ALL_GROUPS,
  relief: [],
  osm: ALL_GROUPS,
};

/** いまの選択で、その単位のレイヤーを描くか */
export const isGroupShown = (selection: BasemapSelection, group: BasemapLayerGroup): boolean =>
  selection.visibility[group] && !BASEMAP_HIDDEN_GROUPS[selection.id].includes(group);

/** 単位ごとの、背景地図のスタイルのレイヤーの ID */
export type BasemapLayerIds = Readonly<Record<BasemapLayerGroup, readonly string[]>>;

/** 背景地図の候補ごとの、選んだときにだけ表示するスタイルのレイヤーの ID */
export type BasemapSurfaceIds = Readonly<Record<BasemapId, readonly string[]>>;

/** 背景地図のスタイルの metadata から読んだレイヤーの ID */
export type BasemapStyleLayers = {
  readonly groups: BasemapLayerIds;
  readonly surfaces: BasemapSurfaceIds;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 1つ以上のレイヤーの ID の配列 */
const parseIds = (value: unknown): readonly string[] | null =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((id): id is string => typeof id === "string")
    ? value
    : null;

/** 対応のキーが keys のどれかであることを確かめる。知らないキーがあれば、失敗の文を返す */
const unknownKeyError = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  noun: string,
): string | null => {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  return unknownKeys.length > 0 ? `知らない${noun}: ${unknownKeys.join(", ")}` : null;
};

/** 1つ以上のレイヤーの ID の配列でないキーを並べた、失敗の文 */
const invalidIdsError = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  noun: string,
): string =>
  `1つ以上のレイヤーの ID の配列でない${noun}: ${keys.filter((key) => parseIds(value[key]) === null).join(", ")}`;

/**
 * スタイルの metadata の rjm:layerGroups を検査する。
 * 4つの単位のすべてに、1つ以上のレイヤーの ID の配列を書く。ほかの単位は受け付けない。
 * レイヤーがスタイルにあるかは、スタイルを読んだ io が確かめる。
 */
export const parseBasemapLayerIds = (value: unknown): Result<BasemapLayerIds, string> => {
  if (!isRecord(value)) {
    return err("単位からレイヤーの ID の配列への対応にする");
  }
  const unknown = unknownKeyError(value, BASEMAP_LAYER_GROUPS, "単位");
  if (unknown !== null) {
    return err(unknown);
  }
  const { rail: railIds, road: roadIds, river: riverIds, label: labelIds } = value;
  const rail = parseIds(railIds);
  const road = parseIds(roadIds);
  const river = parseIds(riverIds);
  const label = parseIds(labelIds);
  if (rail === null || road === null || river === null || label === null) {
    return err(invalidIdsError(value, BASEMAP_LAYER_GROUPS, "単位"));
  }
  return ok({ rail, road, river, label });
};

/**
 * スタイルの metadata の rjm:basemaps を検査する。
 * 背景地図の候補のすべてに、選んだときにだけ表示するレイヤーの ID を、1つ以上の配列で書く。
 * ほかの候補は受け付けない。レイヤーがスタイルにあるかは、スタイルを読んだ io が確かめる。
 */
export const parseBasemapSurfaceIds = (value: unknown): Result<BasemapSurfaceIds, string> => {
  if (!isRecord(value)) {
    return err("背景地図からレイヤーの ID の配列への対応にする");
  }
  const unknown = unknownKeyError(value, BASEMAP_IDS, "背景地図");
  if (unknown !== null) {
    return err(unknown);
  }
  const {
    vector: vectorIds,
    photo: photoIds,
    pale: paleIds,
    std: stdIds,
    relief: reliefIds,
    osm: osmIds,
  } = value;
  const vector = parseIds(vectorIds);
  const photo = parseIds(photoIds);
  const pale = parseIds(paleIds);
  const std = parseIds(stdIds);
  const relief = parseIds(reliefIds);
  const osm = parseIds(osmIds);
  if (
    vector === null ||
    photo === null ||
    pale === null ||
    std === null ||
    relief === null ||
    osm === null
  ) {
    return err(invalidIdsError(value, BASEMAP_IDS, "背景地図"));
  }
  return ok({ vector, photo, pale, std, relief, osm });
};

/**
 * レイヤーの ID ごとの表示。io はこのとおりに MapLibre の layout の visibility を設定する。
 * 背景地図のレイヤーは、選んだ候補のものだけを表示する。単位のレイヤーは、表示の設定が入っていて、
 * 選んだ背景地図が隠さないものを表示する。
 */
export const basemapLayerVisibility = (
  layers: BasemapStyleLayers,
  selection: BasemapSelection,
): readonly { readonly id: string; readonly visible: boolean }[] => [
  ...BASEMAP_IDS.flatMap((basemap) =>
    layers.surfaces[basemap].map((id) => ({ id, visible: basemap === selection.id })),
  ),
  ...BASEMAP_LAYER_GROUPS.flatMap((group) =>
    layers.groups[group].map((id) => ({ id, visible: isGroupShown(selection, group) })),
  ),
];

/** 地図の上の出典の表示に並べる、背景地図の提供元（docs/user/attribution.md の「画面での表示」） */
export type BasemapCredit = { readonly label: string; readonly url: string };

/** 地理院タイル一覧のページ。出典には、このページへのリンクを付ける */
const GSI_TILE_LIST_URL = "https://maps.gsi.go.jp/development/ichiran.html";

/**
 * 背景地図の提供元の表示。label は、背景地図のスタイルのソースの attribution と同じ文字にする。
 * MapLibre は、ソースの attribution が出典の表示の文字列に含まれていれば、重ねて出さない
 */
export const BASEMAP_CREDITS = {
  gsiVector: { label: "国土地理院最適化ベクトルタイル", url: GSI_TILE_LIST_URL },
  gsiRaster: { label: "地理院タイル", url: GSI_TILE_LIST_URL },
  osm: { label: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
} as const satisfies Readonly<Record<string, BasemapCredit>>;

/** ラスターの背景地図の提供元。ベクトルタイルの背景地図は、線と地名と同じ提供元なので null */
const SURFACE_CREDIT: Readonly<Record<BasemapId, BasemapCredit | null>> = {
  vector: null,
  photo: BASEMAP_CREDITS.gsiRaster,
  pale: BASEMAP_CREDITS.gsiRaster,
  std: BASEMAP_CREDITS.gsiRaster,
  relief: BASEMAP_CREDITS.gsiRaster,
  osm: BASEMAP_CREDITS.osm,
};

/**
 * いまの選択で地図に描いているものの提供元を、出典の表示に並べる順で返す。
 * 最適化ベクトルタイルは、陸と海の塗り（既定の背景地図）か、線と地名のどれかを描いているときだけ入れる。
 */
export const basemapCredits = (selection: BasemapSelection): readonly BasemapCredit[] => {
  const surface = SURFACE_CREDIT[selection.id];
  const usesVectorTiles =
    selection.id === "vector" ||
    BASEMAP_LAYER_GROUPS.some((group) => isGroupShown(selection, group));
  return [
    ...(surface === null ? [] : [surface]),
    ...(usesVectorTiles ? [BASEMAP_CREDITS.gsiVector] : []),
  ];
};
