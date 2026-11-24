// 左上のパネルの歯車のボタンと、地図の設定（docs/design/ui.md の「地図の設定」）。
// 背景地図（ラジオボタン）、重ねるもの（鉄道、道路、川と湖、地名のチェックボックス）、塗りの不透明度（ラジオボタン）
// の3つのまとまりを縦に並べる。部品は DADS の Radio と Checkbox を使う。
// 設定は、左上のパネルの右に、パネルの上端にそろえて開く。位置の基準は、IndicatorPanel の section である。
// 開くと、選んでいる背景地図のラジオボタンにフォーカスを移す。Esc と歯車で閉じたときは、フォーカスを歯車に戻す。
// 設定の外を押したときと、外へフォーカスが移ったとき（Ctrl + K の入力欄が開いたときなど）も閉じるが、
// 押した先や移った先のフォーカスは奪わない。

import { useEffect, useId, useRef, useState } from "react";
import {
  BASEMAP_HIDDEN_GROUPS,
  BASEMAP_IDS,
  BASEMAP_LAYER_GROUPS,
  type BasemapId,
  type BasemapLayerGroup,
  type BasemapSelection,
} from "../core/render/basemap";
import { FILL_OPACITIES, type FillOpacity } from "../core/render/fill-opacity";
import { Checkbox } from "./dads/Checkbox";
import { Radio } from "./dads/Radio";
import { SettingsIcon } from "./icons";

type MapSettingsProps = {
  basemap: BasemapSelection;
  fillOpacity: FillOpacity;
  onBasemapSelect: (id: BasemapId) => void;
  onLayerGroupChange: (group: BasemapLayerGroup, visible: boolean) => void;
  onFillOpacitySelect: (opacity: FillOpacity) => void;
};

const BASEMAP_LABELS: Readonly<Record<BasemapId, string>> = {
  vector: "既定",
  photo: "写真",
  pale: "淡色地図",
  std: "標準地図",
  relief: "色別標高図",
  osm: "OpenStreetMap",
};

const GROUP_LABELS: Readonly<Record<BasemapLayerGroup, string>> = {
  rail: "鉄道",
  road: "道路",
  // 水域の面には湖も入り、z8 以下では湖だけが出る
  river: "川と湖",
  label: "地名",
};

const LEGEND_CLASS = "pb-1 text-dns-14B-130 text-solid-gray-800";

export const MapSettings = ({
  basemap,
  fillOpacity,
  onBasemapSelect,
  onLayerGroupChange,
  onFillOpacitySelect,
}: MapSettingsProps) => {
  // 開閉は、この部品の中で閉じる表示の状態なので、部品が持つ
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const radioName = useId();
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

  /** 選んだ背景地図が、表示の設定にかかわらず隠している単位 */
  const hiddenGroups = BASEMAP_HIDDEN_GROUPS[basemap.id];

  return (
    <div ref={rootRef}>
      <button
        ref={gearRef}
        type="button"
        aria-label="地図の設定"
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
        // biome-ignore lint/a11y/useSemanticElements: 3つの fieldset を束ねる入れ物で、fieldset を入れ子にしない
        <div
          id={popupId}
          role="group"
          aria-label="地図の設定"
          // 画面が低いときは、設定の中をスクロールする。3rem は、パネルの上の余白（top-6）と、同じ幅の下の余白
          className="absolute top-0 left-full ml-2 flex max-h-[calc(100dvh-3rem)] w-max flex-col gap-3 overflow-y-auto rounded-8 bg-white px-4 py-3 shadow-2"
          onKeyDown={closeOnEscape}
        >
          <fieldset>
            <legend className={LEGEND_CLASS}>背景地図</legend>
            {BASEMAP_IDS.map((id) => (
              <Radio
                key={id}
                name={`${radioName}-basemap`}
                // 歯車で開いたときだけ現れるので、開いたらすぐキーで選べるようにする
                autoFocus={id === basemap.id}
                checked={id === basemap.id}
                onChange={() => onBasemapSelect(id)}
              >
                {BASEMAP_LABELS[id]}
              </Radio>
            ))}
          </fieldset>
          <fieldset>
            <legend className={LEGEND_CLASS}>重ねるもの</legend>
            {BASEMAP_LAYER_GROUPS.map((group) => (
              <Checkbox
                key={group}
                // 背景地図が線と地名を画像に持つあいだは、切り替えても変わらないので選べなくする。設定は残す
                disabled={hiddenGroups.includes(group)}
                checked={basemap.visibility[group]}
                onChange={(e) => onLayerGroupChange(group, e.currentTarget.checked)}
              >
                {GROUP_LABELS[group]}
              </Checkbox>
            ))}
          </fieldset>
          <fieldset>
            <legend className={LEGEND_CLASS}>塗りの不透明度</legend>
            <div className="flex gap-4">
              {FILL_OPACITIES.map((opacity) => (
                <Radio
                  key={opacity}
                  name={`${radioName}-opacity`}
                  checked={opacity === fillOpacity}
                  onChange={() => onFillOpacitySelect(opacity)}
                >
                  {`${Math.round(opacity * 100)}%`}
                </Radio>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
};
