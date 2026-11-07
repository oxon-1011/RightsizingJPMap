// 行政区域の塗り分けの描画の指定。MapLibre の feature-state に渡す、団体コードと色の対応を作る
// （docs/design/map-and-hosting.md の「行政区域の描画」）。

import { type Classification, classIndex, NO_CLASS } from "../classify/classify";
import { type Rgba, TRANSPARENT } from "../classify/color";
import { ADMIN_TILE_CODE_PROPERTY, ADMIN_TILE_LAYERS } from "../data/schema";

export type AdminFillSpec = {
  /** admin.pmtiles の塗るレイヤー */
  readonly sourceLayer: typeof ADMIN_TILE_LAYERS.municipality;
  /** MapLibre の promoteId に指定する属性 */
  readonly promoteId: typeof ADMIN_TILE_CODE_PROPERTY;
  /**
   * 団体コードから色への対応。値なし（NaN）の地域は透明で、対応に必ず含める。
   * 前の指標の色が feature-state に残らないよう、io はここにあるすべての地域を更新する。
   */
  readonly colors: ReadonlyMap<string, Rgba>;
  readonly visible: boolean;
};

/** 団体コードごとの値を、階級区分で色に変える */
export const adminFillSpec = (
  values: ReadonlyMap<string, number>,
  classification: Classification,
  visible: boolean,
): AdminFillSpec => {
  const colors = new Map<string, Rgba>();
  for (const [code, value] of values) {
    const k = classIndex(value, classification.breaks);
    colors.set(code, k === NO_CLASS ? TRANSPARENT : (classification.colors[k] ?? TRANSPARENT));
  }
  return {
    sourceLayer: ADMIN_TILE_LAYERS.municipality,
    promoteId: ADMIN_TILE_CODE_PROPERTY,
    colors,
    visible,
  };
};
