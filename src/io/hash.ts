// URL の # 以降を読み書きする。値の形は core が決める（position/hash.ts、region/hash.ts）。
// 地図の位置は map.ts が同じ # 以降に書くので、どちらも履歴を増やさない replaceState で書く。

/** いまの URL の # 以降（先頭の # を含む。なければ空の文字列） */
export const readHash = (): string => window.location.hash;

/**
 * URL の # 以降を置き換える。履歴は増やさず、hashchange も起きない。
 * hash は先頭の # を含む文字列で、空の文字列なら # 以降を取り除く
 */
export const replaceHash = (hash: string): void => {
  if (hash === window.location.hash) {
    return;
  }
  const { pathname, search } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    hash === "" ? `${pathname}${search}` : hash,
  );
};

/** 利用者が URL の # 以降を書き換えたとき（hashchange）に知らせる。返した関数で知らせるのをやめる */
export const watchHash = (listener: (hash: string) => void): (() => void) => {
  const onChange = (): void => listener(window.location.hash);
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
