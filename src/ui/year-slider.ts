// 年次スライダーの値の変換。DADS にスライダーがないので自作する（docs/design/ui.md の「年次スライダー」）。
// トラックには単位の年をすべて並べ、つまみは選べる年（core の selectableYears）にだけ止める。

import { MESH_YEARS, MUNICIPAL_YEARS } from "../core/data/schema";
import type { Unit } from "../core/indicators/definitions";
import { nearestYear } from "../core/state/state";

/** トラックに並べる年。メッシュは 2020〜2070 年、市区町村は 2020〜2050 年（D8） */
export const trackYears = (unit: Unit): readonly number[] =>
  unit === "mesh" ? MESH_YEARS : MUNICIPAL_YEARS;

/** 年のトラック上の位置。最初の年を 0、最後の年を 1 とする */
export const yearRatio = (year: number, years: readonly number[]): number => {
  const first = years[0];
  const last = years[years.length - 1];
  if (first === undefined || last === undefined || first === last) {
    return 0;
  }
  return Math.min(1, Math.max(0, (year - first) / (last - first)));
};

/** トラック上の位置に最も近い、選べる年。位置はトラックの外に出ても端に寄せる */
export const yearAtRatio = (
  ratio: number,
  years: readonly number[],
  selectable: readonly number[],
): number => {
  const first = years[0] ?? 0;
  const last = years[years.length - 1] ?? first;
  const clamped = Math.min(1, Math.max(0, ratio));
  return nearestYear(first + clamped * (last - first), selectable);
};

/** PageUp と PageDown で動かす段の数。5年刻みなので 10 年になる */
const PAGE_STEPS = 2;

/**
 * キーで動かしたあとの年（WAI-ARIA APG のスライダーのキー操作）。
 * 矢印は1段、PageUp と PageDown は2段、Home と End は端へ動かす。スライダーで扱わないキーなら null。
 */
export const yearForKey = (
  key: string,
  value: number,
  selectable: readonly number[],
): number | null => {
  const current = selectable.indexOf(nearestYear(value, selectable));
  const at = (index: number): number =>
    selectable[Math.min(selectable.length - 1, Math.max(0, index))] ?? value;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return at(current + 1);
    case "ArrowLeft":
    case "ArrowDown":
      return at(current - 1);
    case "PageUp":
      return at(current + PAGE_STEPS);
    case "PageDown":
      return at(current - PAGE_STEPS);
    case "Home":
      return at(0);
    case "End":
      return at(selectable.length - 1);
    default:
      return null;
  }
};
