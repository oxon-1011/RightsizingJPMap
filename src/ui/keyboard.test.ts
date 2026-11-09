import { describe, expect, it } from "vitest";
import { isMacPlatform, isPlaceSearchShortcut, type KeyInput, listboxAction } from "./keyboard";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...mods,
});

describe("isMacPlatform", () => {
  it("macOS と iPadOS を見分ける", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("")).toBe(false);
  });
});

describe("isPlaceSearchShortcut", () => {
  it("macOS では Command + K、それ以外では Ctrl + K", () => {
    expect(isPlaceSearchShortcut(key("k", { metaKey: true }), true)).toBe(true);
    expect(isPlaceSearchShortcut(key("k", { ctrlKey: true }), true)).toBe(false);
    expect(isPlaceSearchShortcut(key("k", { ctrlKey: true }), false)).toBe(true);
    expect(isPlaceSearchShortcut(key("k", { metaKey: true }), false)).toBe(false);
  });

  it("Caps Lock で大文字になっても受け付ける", () => {
    expect(isPlaceSearchShortcut(key("K", { ctrlKey: true }), false)).toBe(true);
  });

  it("Shift や Alt を足した組み合わせと、K だけ、ほかのキーは受け付けない", () => {
    expect(isPlaceSearchShortcut(key("K", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPlaceSearchShortcut(key("k", { ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPlaceSearchShortcut(key("k"), false)).toBe(false);
    expect(isPlaceSearchShortcut(key("f", { ctrlKey: true }), false)).toBe(false);
  });

  it("IME の変換中は受け付けない", () => {
    expect(isPlaceSearchShortcut(key("k", { ctrlKey: true, isComposing: true }), false)).toBe(
      false,
    );
  });
});

describe("listboxAction", () => {
  it("下の矢印で次の候補へ動かし、最後の次は先頭へ回る", () => {
    expect(listboxAction(key("ArrowDown"), -1, 3)).toEqual({ type: "move", index: 0 });
    expect(listboxAction(key("ArrowDown"), 0, 3)).toEqual({ type: "move", index: 1 });
    expect(listboxAction(key("ArrowDown"), 2, 3)).toEqual({ type: "move", index: 0 });
  });

  it("上の矢印で前の候補へ動かし、先頭の前は最後へ回る", () => {
    expect(listboxAction(key("ArrowUp"), -1, 3)).toEqual({ type: "move", index: 2 });
    expect(listboxAction(key("ArrowUp"), 0, 3)).toEqual({ type: "move", index: 2 });
    expect(listboxAction(key("ArrowUp"), 2, 3)).toEqual({ type: "move", index: 1 });
  });

  it("Enter で選んでいる候補に決め、どれも選んでいなければ先頭に決める", () => {
    expect(listboxAction(key("Enter"), 1, 3)).toEqual({ type: "select", index: 1 });
    expect(listboxAction(key("Enter"), -1, 3)).toEqual({ type: "select", index: 0 });
  });

  it("候補がなければ矢印と Enter では何もしない", () => {
    expect(listboxAction(key("ArrowDown"), -1, 0)).toBeNull();
    expect(listboxAction(key("Enter"), -1, 0)).toBeNull();
  });

  it("Esc で閉じる", () => {
    expect(listboxAction(key("Escape"), 0, 3)).toEqual({ type: "close" });
  });

  it("IME の変換中の Enter は、変換の確定なので候補に決めない", () => {
    expect(listboxAction(key("Enter", { isComposing: true }), 0, 3)).toBeNull();
  });

  it("文字のキーは入力欄に任せる", () => {
    expect(listboxAction(key("a"), 0, 3)).toBeNull();
    expect(listboxAction(key("Home"), 0, 3)).toBeNull();
  });
});
