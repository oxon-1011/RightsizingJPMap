// レイヤーの一覧（Figma の「Panel / レイヤー」と「Layer / 行」）。
// 行には色の点、名前、件数、表示の切り替え、削除だけを置く。データが1つもないときはパネル自体を出さない。
// 色の点を押すと、ブラウザの色の選択を開く。

import type { DatasetEntry, LayerStyle } from "../core/storage/manifest";
import { TrashIcon, VisibilityIcon, VisibilityOffIcon } from "./icons";

type LayerPanelProps = {
  datasets: readonly DatasetEntry[];
  /** データごとの件数（行か地物の数）。目録に件数がないので app が渡す。分からなければ出さない */
  counts: ReadonlyMap<string, number>;
  onStyleChange: (id: string, style: Partial<LayerStyle>) => void;
  onRemove: (id: string) => void;
};

const countFormat = new Intl.NumberFormat("ja-JP");

/** 行の中のアイコンのボタン。Figma のアイコンは 24px で、押せる範囲も 24px にする */
const iconButtonStyle = `
  flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-4
  hover:bg-solid-gray-50
  focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300
`;

const LayerRow = ({
  dataset,
  count,
  onStyleChange,
  onRemove,
}: {
  dataset: DatasetEntry;
  count: number | undefined;
} & Pick<LayerPanelProps, "onStyleChange" | "onRemove">) => {
  const { id, name, style } = dataset;
  return (
    <li className="flex items-center gap-2 py-2">
      {/* 色の点は 12px だが、押せる範囲は 24px にする。input の上に点を重ね、input を透明にする */}
      <span
        className={`
          relative flex size-6 shrink-0 items-center justify-center rounded-4
          has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-black has-[:focus-visible]:outline-offset-[calc(2/16*1rem)] has-[:focus-visible]:ring-[calc(2/16*1rem)] has-[:focus-visible]:ring-yellow-300
        `}
      >
        <span
          aria-hidden={true}
          className="size-3 rounded-full"
          style={{ backgroundColor: style.color }}
        />
        <input
          type="color"
          aria-label={`「${name}」の色`}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={style.color}
          onChange={(e) => onStyleChange(id, { color: e.currentTarget.value })}
        />
      </span>
      <p className="min-w-0 flex-1 truncate text-dns-16N-120 text-solid-gray-800">{name}</p>
      {count !== undefined && (
        <p className="shrink-0 text-oln-14N-100 text-solid-gray-600">
          {countFormat.format(count)}
          <span className="sr-only"> 件</span>
        </p>
      )}
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
    </li>
  );
};

export const LayerPanel = ({ datasets, counts, onStyleChange, onRemove }: LayerPanelProps) =>
  datasets.length === 0 ? null : (
    <section aria-label="レイヤー" className="w-80 rounded-8 bg-white px-4 py-1 shadow-2">
      <ul>
        {datasets.map((dataset) => (
          <LayerRow
            key={dataset.id}
            dataset={dataset}
            count={counts.get(dataset.id)}
            onStyleChange={onStyleChange}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
