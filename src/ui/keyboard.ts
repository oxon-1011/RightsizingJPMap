// キーボードの操作の判定。場所への移動の入力欄を開くキー（D19）と、候補の一覧の操作。

/** キーの判定に使う、KeyboardEvent の一部 */
export type KeyInput = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** IME で変換している途中か */
  readonly isComposing: boolean;
};

/** macOS（と iPadOS）か。navigator.platform か navigator.userAgentData.platform の値を渡す */
export const isMacPlatform = (platform: string): boolean => /^(mac|iphone|ipad)/i.test(platform);

/**
 * 場所への移動の入力欄を開くキーか。Ctrl + K、macOS では Command + K（D19）。
 * Shift や Alt を足した組み合わせは、ほかの操作に残しておくために受け付けない。
 */
export const isPlaceSearchShortcut = (input: KeyInput, isMac: boolean): boolean =>
  !input.isComposing &&
  input.key.toLowerCase() === "k" &&
  !input.altKey &&
  !input.shiftKey &&
  (isMac ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey);

/** 候補の一覧でのキーの結果 */
export type ListboxAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "close" };

/**
 * 入力欄で押したキーから、候補の一覧への操作を決める（WAI-ARIA APG の Combobox）。
 * active は選んでいる候補の番号で、どれも選んでいなければ -1。
 * - 下と上の矢印：次と前の候補へ動かす。端では反対の端へ回る
 * - Enter：選んでいる候補に決める。どれも選んでいなければ先頭の候補に決める
 * - Esc：入力欄を閉じる
 * IME の変換中のキーは、変換の操作なので扱わない。扱わないキーなら null。
 */
export const listboxAction = (
  input: KeyInput,
  active: number,
  count: number,
): ListboxAction | null => {
  if (input.isComposing) {
    return null;
  }
  switch (input.key) {
    case "ArrowDown":
      return count === 0 ? null : { type: "move", index: active + 1 >= count ? 0 : active + 1 };
    case "ArrowUp":
      return count === 0 ? null : { type: "move", index: active <= 0 ? count - 1 : active - 1 };
    case "Enter":
      return count === 0
        ? null
        : { type: "select", index: active >= 0 && active < count ? active : 0 };
    case "Escape":
      return { type: "close" };
    default:
      return null;
  }
};
