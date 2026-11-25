// 地域（表示する都道府県）と、URL の # 以降の文字列との変換。
// 形は `#名前=19,20` で、都道府県のコードをカンマで区切る。全国のときは、名前の値を置かない。
// # 以降の扱いは、地図の位置（position/hash.ts）と同じで、ほかの名前の値はそのまま残す。
// URL を読むことと書くことは io がする（src/io/hash.ts）。

import { hashParams } from "../position/hash";
import { isPrefCode, isWholeCountry, type PrefCode, type Region, regionOf } from "./region";

/**
 * URL の # 以降から、地域を読む。
 * 名前の値がない、都道府県のコードでないものがある、同じコードが2回ある、のどれかなら null を返す。
 * コードの順は問わない。コードでないものを除いて残りを使うことはしない
 */
export const parseRegionHash = (hash: string, name: string): Region | null => {
  const prefix = `${name}=`;
  const param = hashParams(hash).find((p) => p.startsWith(prefix));
  if (param === undefined) {
    return null;
  }
  const codes: PrefCode[] = [];
  for (const part of param.slice(prefix.length).split(",")) {
    if (!isPrefCode(part) || codes.includes(part)) {
      return null;
    }
    codes.push(part);
  }
  return regionOf(codes);
};

/**
 * URL の # 以降の、名前の値を region に置き換えたものを返す（先頭の # を含む）。
 * 名前の値がなければ末尾に足し、全国なら名前の値を取り除く。ほかの名前の値と、その並びは変えない。
 * 値が1つも残らなければ、空の文字列を返す
 */
export const formatRegionHash = (hash: string, name: string, region: Region): string => {
  const prefix = `${name}=`;
  const current = hashParams(hash);
  const others = current.filter((p) => !p.startsWith(prefix));
  if (isWholeCountry(region)) {
    return others.length === 0 ? "" : `#${others.join("&")}`;
  }
  const next = `${prefix}${region.join(",")}`;
  const replaced = current.some((p) => p.startsWith(prefix))
    ? current.map((p) => (p.startsWith(prefix) ? next : p))
    : [...current, next];
  return `#${replaced.join("&")}`;
};

/** URL の # 以降に、その名前の値があるか。値が正しい形かは見ない */
export const hasHashParam = (hash: string, name: string): boolean =>
  hashParams(hash).some((p) => p.startsWith(`${name}=`));
