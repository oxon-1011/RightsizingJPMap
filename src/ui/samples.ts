// 仮の配置（App.tsx）で部品に渡す見本の値。段階 5 のストアと段階 7 の地図の結線で置き換える。
// Figma の画面 01〜04 と見比べられるよう、画面ごとの状態を core の reduce で組み立てる。

import type { Classification } from "../core/classify/classify";
import { joinedClassification } from "../core/classify/scales";
import type { Place } from "../core/data/schema";
import { type AppState, INITIAL_STATE, reduce } from "../core/state/state";
import type { DatasetEntry } from "../core/storage/manifest";

/** Figma の画面の番号。01 地図（基本）、02 ファイルを重ねている、03 取り込めなかった、04 データを追加したあと */
export type SampleScreen = "01" | "02" | "03" | "04";

export const parseSampleScreen = (value: string | null): SampleScreen =>
  value === "02" || value === "03" || value === "04" ? value : "01";

/** 04 の点のデータ。Figma の見本と同じく架空のもので、実在の施設ではない */
export const SAMPLE_DATASET: DatasetEntry = {
  id: "sample-clinics",
  name: "医療機関（見本）",
  source: { name: "医療機関.csv", size: 12_345 },
  imported_at: "2026-11-09T00:00:00.000Z",
  kind: "point",
  join: ["mesh", "municipality"],
  columns: [
    { name: "lat", type: "float" },
    { name: "lon", type: "float" },
    { name: "名称", type: "string" },
    { name: "病床数", type: "integer" },
  ],
  style: { color: "#0072b2", size: 4, visible: true },
  stored_format: "parquet",
};

/** 04 の点の数（Figma の「Layer / 行」と同じ 160） */
export const SAMPLE_COUNTS: ReadonlyMap<string, number> = new Map([[SAMPLE_DATASET.id, 160]]);

/** 自前データの指標を選んだときの凡例の見本。メッシュごとの件数を仮に並べた値から分位で区切る */
export const SAMPLE_JOINED_CLASSIFICATION: Classification = joinedClassification([
  0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30,
]);

/** 画面ごとの状態。書き込みの権利は writer にして、削除も試せるようにする */
export const sampleState = (screen: SampleScreen): AppState => {
  const writer = reduce(INITIAL_STATE, { type: "access-changed", access: "writer" });
  switch (screen) {
    case "01":
    case "02":
      return writer;
    case "03":
      // Figma の通知と同じく、3、15、42 行目ほか 2 件の code が地図の単位にない CSV
      return reduce(writer, {
        type: "notified",
        notice: {
          kind: "import-rejected",
          fileName: "施設一覧.csv",
          rejection: {
            stage: "table",
            format: "csv",
            rejection: {
              kind: "invalid-values",
              violation: { condition: "code", positions: [1, 13, 40], count: 5 },
            },
          },
        },
      });
    case "04":
      return reduce(writer, { type: "dataset-added", entry: SAMPLE_DATASET });
    default: {
      const unreachable: never = screen;
      return unreachable;
    }
  }
};

/**
 * 場所への移動の候補の見本。places.json は段階 5 で読み込むので、同じ名前の市区町村と政令指定都市の区を含む数件だけを置く。
 * 範囲はおおよその値で、地図の移動には使わない。
 */
export const SAMPLE_PLACES: readonly Place[] = [
  {
    code: "13000",
    name: "東京都",
    pref_name: "東京都",
    kind: "prefecture",
    bbox: [136.07, 20.42, 153.99, 35.9],
  },
  {
    code: "13101",
    name: "千代田区",
    pref_name: "東京都",
    kind: "municipality",
    bbox: [139.73, 35.67, 139.78, 35.7],
  },
  {
    code: "13206",
    name: "府中市",
    pref_name: "東京都",
    kind: "municipality",
    bbox: [139.43, 35.65, 139.52, 35.69],
  },
  {
    code: "34208",
    name: "府中市",
    pref_name: "広島県",
    kind: "municipality",
    bbox: [133.17, 34.53, 133.31, 34.66],
  },
  {
    code: "01233",
    name: "伊達市",
    pref_name: "北海道",
    kind: "municipality",
    bbox: [140.74, 42.43, 141.06, 42.64],
  },
  {
    code: "07213",
    name: "伊達市",
    pref_name: "福島県",
    kind: "municipality",
    bbox: [140.43, 37.67, 140.75, 37.9],
  },
  {
    code: "22000",
    name: "静岡県",
    pref_name: "静岡県",
    kind: "prefecture",
    bbox: [137.47, 34.57, 139.18, 35.65],
  },
  {
    code: "22130",
    name: "浜松市",
    pref_name: "静岡県",
    kind: "designated-city",
    bbox: [137.55, 34.6, 138.0, 35.3],
  },
  {
    code: "22138",
    name: "浜松市中央区",
    pref_name: "静岡県",
    kind: "ward",
    bbox: [137.55, 34.6, 137.85, 34.85],
  },
  {
    code: "22139",
    name: "浜松市浜名区",
    pref_name: "静岡県",
    kind: "ward",
    bbox: [137.62, 34.75, 137.85, 35.0],
  },
  {
    code: "22140",
    name: "浜松市天竜区",
    pref_name: "静岡県",
    kind: "ward",
    bbox: [137.65, 34.85, 138.0, 35.3],
  },
];
