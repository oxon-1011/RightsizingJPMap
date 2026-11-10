// 画面全体で1つの app。main.tsx で boot を呼び、ui の部品には App.tsx から値と手続きを渡す。
// 作るだけでは何も読まない（読み込みは boot と attachMap から始まる）。

import { useStore } from "zustand";
import { browserPorts } from "./browser-ports";
import { createApp } from "./create-app";
import type { HoverStoreState } from "./hover";
import type { AppStoreState } from "./store";

export const app = createApp(browserPorts());

/**
 * ストアの値を React の部品で読む。selector は state や runtime のように、ストアにある値をそのまま返す。
 * 呼ぶたびに新しいオブジェクトを返す selector は、描き直しが止まらなくなる（Zustand 5）。
 */
export const useAppStore = <T>(selector: (state: AppStoreState) => T): T =>
  useStore(app.store, selector);

/**
 * ホバーのカードを React の部品で読む。カードの部品だけがこれを読み、ポインタを動かしても
 * ほかの部品は描き直されない（src/app/hover.ts）
 */
export const useHoverStore = <T>(selector: (state: HoverStoreState) => T): T =>
  useStore(app.hover, selector);
