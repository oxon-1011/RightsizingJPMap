// 左上のパネルの歯車のボタンと、背景地図の鉄道、道路、川の表示を切り替える小さな設定
// （docs/design/implementation-plan.md の段階 7.5 の 5.）。チェックボックスは DADS の Checkbox を使う。
// 開くと最初のチェックボックスにフォーカスを移す。Esc と歯車で閉じたときは、フォーカスを歯車に戻す。
// 設定の外を押したときと、外へフォーカスが移ったとき（Ctrl + K の入力欄が開いたときなど）も閉じるが、
// 押した先や移った先のフォーカスは奪わない。

import { useEffect, useId, useRef, useState } from "react";
import {
  BASEMAP_LAYER_GROUPS,
  type BasemapLayerGroup,
  type BasemapVisibility,
} from "../core/render/basemap";
import { Checkbox } from "./dads/Checkbox";
import { SettingsIcon } from "./icons";

type BasemapSettingsProps = {
  visibility: BasemapVisibility;
  onChange: (group: BasemapLayerGroup, visible: boolean) => void;
};

const GROUP_LABELS: Readonly<Record<BasemapLayerGroup, string>> = {
  rail: "鉄道",
  road: "道路",
  river: "川",
};

export const BasemapSettings = ({ visibility, onChange }: BasemapSettingsProps) => {
  // 開閉は、この部品の中で閉じる表示の状態なので、部品が持つ
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);

  // 外を押したか、外へフォーカスが移ったら閉じる。pointerdown は地図より先に受けるよう、捕捉の段階で聞く
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeIfOutside = (e: Event): void => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("focusin", closeIfOutside);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("focusin", closeIfOutside);
    };
  }, [open]);

  const closeToGear = (): void => {
    setOpen(false);
    gearRef.current?.focus();
  };

  const closeOnEscape = (e: React.KeyboardEvent): void => {
    if (open && e.key === "Escape") {
      closeToGear();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={gearRef}
        type="button"
        aria-label="背景地図の設定"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        className={`
          flex size-8 cursor-pointer items-center justify-center rounded-4 text-solid-gray-800
          hover:bg-solid-gray-50 active:bg-solid-gray-100 aria-expanded:bg-solid-gray-50
          focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300
        `}
        onClick={() => (open ? closeToGear() : setOpen(true))}
        onKeyDown={closeOnEscape}
      >
        <SettingsIcon />
      </button>
      {open && (
        <fieldset
          id={popupId}
          className="absolute top-full right-0 mt-2 w-max rounded-8 bg-white px-4 py-1 shadow-2"
          onKeyDown={closeOnEscape}
        >
          <legend className="sr-only">背景地図</legend>
          {BASEMAP_LAYER_GROUPS.map((group, index) => (
            <Checkbox
              key={group}
              // 歯車で開いたときだけ現れるので、開いたらすぐキーで切り替えられるようにする
              autoFocus={index === 0}
              checked={visibility[group]}
              onChange={(e) => onChange(group, e.currentTarget.checked)}
            >
              {GROUP_LABELS[group]}
            </Checkbox>
          ))}
        </fieldset>
      )}
    </div>
  );
};
