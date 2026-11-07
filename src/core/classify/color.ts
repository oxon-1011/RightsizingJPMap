// 色の表し方。deck.gl と MapLibre に渡す RGBA（各 0〜255）を、ライブラリの型に依存せずに持つ。

/** 赤、緑、青、不透明度。どれも 0〜255 の整数 */
export type Rgba = readonly [number, number, number, number];

/** 値なしと秘匿を表す透明（docs/design/ui.md の「凡例」） */
export const TRANSPARENT: Rgba = [0, 0, 0, 0];

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * "#rrggbb" を不透明の Rgba にする。コードに書いた定数を変換するためのもので、
 * 形が違うのはプログラムの誤りなので例外を投げる。外から来た値には parseHexColor を使う。
 */
export const hex = (value: string): Rgba => {
  const parsed = parseHexColor(value);
  if (parsed === null) {
    throw new Error(`色の形が違う: ${value}`);
  }
  return parsed;
};

/** "#rrggbb" を Rgba にする。形が違えば null */
export const parseHexColor = (value: string): Rgba | null => {
  const match = HEX.exec(value);
  if (match === null) {
    return null;
  }
  const [, r = "", g = "", b = ""] = match;
  return [Number.parseInt(r, 16), Number.parseInt(g, 16), Number.parseInt(b, 16), 255];
};

/** Rgba を "#rrggbb" にする。不透明度は落とす */
export const toHex = ([r, g, b]: Rgba): string =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
