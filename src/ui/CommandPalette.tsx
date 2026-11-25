// コマンドパレット。Ctrl（macOS では Command）+ K で画面の上部に開く（D19、docs/design/ui.md の「コマンドパレット」）。
// 場所への移動の候補と、操作（地域を選ぶ部品を開く）を、1つの一覧に並べる。
// 入力欄は DADS の Input に、WAI-ARIA APG の Combobox（候補の一覧つき）の属性を付けて作る。
// 項目は App が palette.ts の paletteItems で作って渡す。項目を選ぶと onSelect、Esc か入力欄の外へ移ると onClose を呼ぶ。

import { useId } from "react";
import { Input } from "./dads/Input";
import { listboxAction } from "./keyboard";
import { type PaletteItem, paletteItemKey } from "./palette";

type CommandPaletteProps = {
  query: string;
  items: readonly PaletteItem[];
  /** 選んでいる項目の番号。どれも選んでいなければ -1。入力が変わったら App が -1 に戻す */
  activeIndex: number;
  /** places.json を読み込んでいる途中か。初めて開いたときに読み込む */
  loading: boolean;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: PaletteItem) => void;
  onClose: () => void;
};

/** 一覧の下に出す一言。入力が空のときと項目があるときは出さない */
const statusText = (query: string, count: number, loading: boolean): string | null => {
  if (loading) {
    return "読み込んでいます";
  }
  return query.trim() !== "" && count === 0 ? "一致するものがありません" : null;
};

/** 項目の名前と、その右に薄く添える言葉。場所には都道府県名を、操作には「操作」を添える */
const itemText = (item: PaletteItem): { readonly name: string; readonly note: string | null } =>
  item.kind === "command"
    ? { name: item.command.label, note: "操作" }
    : { name: item.candidate.place.name, note: item.candidate.prefName };

export const CommandPalette = ({
  query,
  items,
  activeIndex,
  loading,
  onQueryChange,
  onActiveIndexChange,
  onSelect,
  onClose,
}: CommandPaletteProps) => {
  const listboxId = useId();
  const optionId = (index: number): string => `${listboxId}-${index}`;
  const expanded = items.length > 0;
  const status = statusText(query, items.length, loading);

  const select = (index: number): void => {
    const item = items[index];
    if (item !== undefined) {
      onSelect(item);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="場所へ移動、操作を選ぶ"
      className="fixed inset-x-4 top-6 z-40 mx-auto flex w-140 max-w-[calc(100%-2rem)] flex-col gap-2 rounded-8 bg-white p-4 shadow-3"
      onBlur={(e) => {
        // 入力欄の外（地図など）へ移ったら閉じる。一覧の中を押したときは、押す前に入力欄に戻すので閉じない
        if (!e.currentTarget.contains(e.relatedTarget)) {
          onClose();
        }
      }}
    >
      <Input
        // この欄は利用者が Ctrl + K で開いたときだけ現れるので、開いたらすぐ打てるようにする
        autoFocus={true}
        type="text"
        role="combobox"
        aria-label="都道府県名、市区町村名、操作の名前"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        blockSize="md"
        className="w-full"
        value={query}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          const action = listboxAction(
            {
              key: e.key,
              ctrlKey: e.ctrlKey,
              metaKey: e.metaKey,
              altKey: e.altKey,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
            },
            activeIndex,
            items.length,
          );
          if (action === null) {
            return;
          }
          e.preventDefault();
          switch (action.type) {
            case "move":
              onActiveIndexChange(action.index);
              return;
            case "select":
              select(action.index);
              return;
            case "close":
              onClose();
              return;
            default: {
              const unreachable: never = action;
              return unreachable;
            }
          }
        }}
      />
      <div id={listboxId} role="listbox" aria-label="候補" className="flex flex-col empty:hidden">
        {items.map((item, index) => {
          const { name, note } = itemText(item);
          return (
            // 候補の操作は入力欄のキーで受けるので、項目自体にはキーの処理を置かない（APG の Combobox）
            // biome-ignore lint/a11y/useKeyWithClickEvents: キーの操作は入力欄の onKeyDown が受ける
            <div
              key={paletteItemKey(item)}
              id={optionId(index)}
              role="option"
              // 候補にはフォーカスを移さず、入力欄の aria-activedescendant で選んでいる候補を伝える
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className={`flex cursor-pointer items-baseline gap-2 rounded-4 px-3 py-2 ${
                index === activeIndex ? "bg-key-50" : ""
              }`}
              // 押しても入力欄からフォーカスを外さない
              onMouseDown={(e) => e.preventDefault()}
              onPointerMove={() => {
                if (index !== activeIndex) {
                  onActiveIndexChange(index);
                }
              }}
              onClick={() => select(index)}
            >
              <span className="text-dns-16N-120 text-solid-gray-800">{name}</span>
              {note !== null && (
                <span className="text-oln-14N-100 text-solid-gray-600">{note}</span>
              )}
            </div>
          );
        })}
      </div>
      {status !== null && (
        <p role="status" className="px-3 text-oln-14N-100 text-solid-gray-600">
          {status}
        </p>
      )}
    </div>
  );
};
