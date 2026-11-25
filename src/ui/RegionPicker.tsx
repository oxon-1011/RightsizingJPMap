// 地域モードの地域（表示する都道府県）を選ぶ部品（docs/design/ui.md の「地域を選ぶ」）。
// 左上のパネルに、いまの地域を書いたボタンを置く。押すと、47 都道府県のチェックボックスを、パネルの右に開く。
// 1つも選んでいなければ全国で、選ぶと、選んだ都道府県だけを読み込んで描く。部品は DADS の Button と Checkbox を使う。
// 開閉は App が持つ。コマンドパレット（CommandPalette.tsx）からも開けるようにするためである。
// 開くと、選んでいる先頭の都道府県（なければ北海道）のチェックボックスにフォーカスを移す。
// Esc とボタンで閉じたときは、フォーカスをボタンに戻す。外を押したときと、外へフォーカスが移ったときも閉じるが、
// 押した先や移った先のフォーカスは奪わない（MapSettings.tsx と同じ）。

import { useEffect, useId, useRef } from "react";
import { PREFECTURES, type PrefCode, type Region, regionLabel } from "../core/region/region";
import { Button } from "./dads/Button";
import { Checkbox } from "./dads/Checkbox";

type RegionPickerProps = {
  region: Region;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (code: PrefCode, selected: boolean) => void;
  /** すべて外して、全国に戻す */
  onClear: () => void;
};

export const RegionPicker = ({
  region,
  open,
  onOpenChange,
  onToggle,
  onClear,
}: RegionPickerProps) => {
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 外を押したか、外へフォーカスが移ったら閉じる。pointerdown は地図より先に受けるよう、捕捉の段階で聞く
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeIfOutside = (e: Event): void => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("focusin", closeIfOutside);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("focusin", closeIfOutside);
    };
  }, [open, onOpenChange]);

  const closeToButton = (): void => {
    onOpenChange(false);
    buttonRef.current?.focus();
  };

  const closeOnEscape = (e: React.KeyboardEvent): void => {
    if (open && e.key === "Escape") {
      closeToButton();
    }
  };

  /** 開いたときにフォーカスを移す都道府県 */
  const focused: PrefCode = region[0] ?? PREFECTURES[0].code;

  return (
    <div ref={rootRef}>
      <Button
        ref={buttonRef}
        type="button"
        size="xs"
        variant="outline"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={() => (open ? closeToButton() : onOpenChange(true))}
        onKeyDown={closeOnEscape}
      >
        {`地域：${regionLabel(region)}`}
      </Button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: fieldset とボタンを束ねる入れ物で、fieldset を入れ子にしない
        <div
          id={popupId}
          role="group"
          aria-label="地域"
          // 画面が低いときは、中をスクロールする。3rem は、パネルの上の余白（top-6）と、同じ幅の下の余白
          className="absolute top-0 left-full ml-2 flex max-h-[calc(100dvh-3rem)] w-max flex-col gap-2 overflow-y-auto rounded-8 bg-white px-4 py-3 shadow-2"
          onKeyDown={closeOnEscape}
        >
          <fieldset>
            <legend className="pb-1 text-dns-14B-130 text-solid-gray-800">表示する都道府県</legend>
            {/* コードの順に、上から下へ、左の列から並べる */}
            <div className="grid grid-flow-col grid-rows-12 gap-x-4">
              {PREFECTURES.map(({ code, name }) => (
                <Checkbox
                  key={code}
                  // ボタンかコマンドパレットで開いたときだけ現れるので、開いたらすぐキーで選べるようにする
                  autoFocus={code === focused}
                  checked={region.includes(code)}
                  onChange={(e) => onToggle(code, e.currentTarget.checked)}
                >
                  {name}
                </Checkbox>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center justify-between gap-4">
            <p className="text-dns-14N-130 text-solid-gray-600">選ばなければ、全国を表示します</p>
            <Button
              type="button"
              size="xs"
              variant="text"
              aria-disabled={region.length === 0}
              onClick={() => {
                if (region.length > 0) {
                  onClear();
                }
              }}
            >
              全国に戻す
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
