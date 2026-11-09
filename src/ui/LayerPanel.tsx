// レイヤーの一覧（Figma の「Panel / レイヤー」と「Layer / 行」）。
// 行には色の点、名前、件数、表示の切り替え、削除だけを置く。データが1つもないときはパネル自体を出さない。
// 色の点を押すと、行の下に色の候補（core の LAYER_COLORS）が開く。候補の外の色は選べない。
// データが2つ以上あるときは、一覧の下に「すべて削除」を置く。

import { useId, useRef, useState } from "react";
import { type DatasetEntry, LAYER_COLORS, type LayerStyle } from "../core/storage/manifest";
import { Button } from "./dads/Button";
import { TrashIcon, VisibilityIcon, VisibilityOffIcon } from "./icons";
import { layerColorName } from "./layer-color";

type LayerPanelProps = {
  datasets: readonly DatasetEntry[];
  onStyleChange: (id: string, style: Partial<LayerStyle>) => void;
  onRemove: (id: string) => void;
  /** すべてのデータを消す。確かめるかどうかは、呼び出す側が決める */
  onRemoveAll: () => void;
};

const countFormat = new Intl.NumberFormat("ja-JP");

const focusRingStyle =
  "focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300";

/** 行の中のアイコンのボタン。Figma のアイコンは 24px で、押せる範囲も 24px にする */
const iconButtonStyle = `
  flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-4
  hover:bg-solid-gray-50
  ${focusRingStyle}
`;

/** 色の候補。選ぶとすぐに反映する。マウスで選んだときと Esc で閉じ、矢印のキーで選び直しているあいだは開いたままにする */
const ColorChoices = ({
  id,
  name,
  color,
  onSelect,
  onClose,
}: {
  id: string;
  name: string;
  color: string;
  onSelect: (color: string) => void;
  onClose: () => void;
}) => (
  <fieldset
    id={id}
    className="mt-2 flex flex-wrap gap-1"
    onKeyDown={(e) => {
      if (e.key === "Escape") {
        onClose();
      }
    }}
  >
    <legend className="sr-only">「{name}」の色</legend>
    {LAYER_COLORS.map((c) => (
      <label
        key={c}
        className={`
          flex size-8 cursor-pointer items-center justify-center rounded-4
          hover:bg-solid-gray-50 has-[:checked]:ring-2 has-[:checked]:ring-solid-gray-800
          has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-black has-[:focus-visible]:outline-offset-[calc(2/16*1rem)]
        `}
      >
        <input
          type="radio"
          name={id}
          value={c}
          aria-label={layerColorName(c)}
          checked={c === color.toLowerCase()}
          className="sr-only"
          onChange={() => onSelect(c)}
          // キーボードで選んだときの click は detail が 0 になる。マウスで選んだときだけ閉じる
          onClick={(e) => {
            if (e.detail > 0) {
              onClose();
            }
          }}
        />
        <span aria-hidden={true} className="size-4 rounded-full" style={{ backgroundColor: c }} />
      </label>
    ))}
  </fieldset>
);

const LayerRow = ({
  dataset,
  onStyleChange,
  onRemove,
}: {
  dataset: DatasetEntry;
} & Pick<LayerPanelProps, "onStyleChange" | "onRemove">) => {
  const { id, name, count, style } = dataset;
  // 色の候補の開閉は、この行の中で閉じる表示の状態なので、部品が持つ
  const [choicesOpen, setChoicesOpen] = useState(false);
  const choicesId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeChoices = () => {
    setChoicesOpen(false);
    toggleRef.current?.focus();
  };
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        {/* 色の点は 12px だが、押せる範囲は 24px にする */}
        <button
          ref={toggleRef}
          type="button"
          aria-label={`「${name}」の色：${layerColorName(style.color)}`}
          aria-expanded={choicesOpen}
          aria-controls={choicesId}
          className={iconButtonStyle}
          onClick={() => setChoicesOpen((open) => !open)}
        >
          <span
            aria-hidden={true}
            className="size-3 rounded-full"
            style={{ backgroundColor: style.color }}
          />
        </button>
        <p className="min-w-0 flex-1 truncate text-dns-16N-120 text-solid-gray-800">{name}</p>
        <p className="shrink-0 text-oln-14N-100 text-solid-gray-600">
          {countFormat.format(count)}
          <span className="sr-only"> 件</span>
        </p>
        <button
          type="button"
          aria-label={`「${name}」を表示`}
          aria-pressed={style.visible}
          className={`${iconButtonStyle} ${style.visible ? "text-key-900" : "text-solid-gray-600"}`}
          onClick={() => onStyleChange(id, { visible: !style.visible })}
        >
          {style.visible ? <VisibilityIcon /> : <VisibilityOffIcon />}
        </button>
        <button
          type="button"
          aria-label={`「${name}」を削除`}
          className={`${iconButtonStyle} text-solid-gray-900`}
          onClick={() => onRemove(id)}
        >
          <TrashIcon />
        </button>
      </div>
      {choicesOpen && (
        <ColorChoices
          id={choicesId}
          name={name}
          color={style.color}
          onSelect={(color) => onStyleChange(id, { color })}
          onClose={closeChoices}
        />
      )}
    </li>
  );
};

export const LayerPanel = ({ datasets, onStyleChange, onRemove, onRemoveAll }: LayerPanelProps) =>
  datasets.length === 0 ? null : (
    <section aria-label="レイヤー" className="w-80 rounded-8 bg-white px-4 py-1 shadow-2">
      <ul>
        {datasets.map((dataset) => (
          <LayerRow
            key={dataset.id}
            dataset={dataset}
            onStyleChange={onStyleChange}
            onRemove={onRemove}
          />
        ))}
      </ul>
      {datasets.length >= 2 && (
        <div className="flex justify-end border-t border-solid-gray-200 py-2">
          <Button size="xs" variant="text" onClick={onRemoveAll}>
            すべて削除
          </Button>
        </div>
      )}
    </section>
  );
