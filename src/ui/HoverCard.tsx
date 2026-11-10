// ホバーのカード。ポインタの横に、ポインタの下のもの（メッシュ、市区町村、自前データの地物）の値を出す。
// マウスで見るだけの表示なので、ポインタの操作を受けない（pointer-events-none）。
// クリックでの固定とキーボードでの操作は足さない（D27）。

import type { HoverCard as HoverCardState } from "../app/hover";
import { hoverCardPlacement, hoverCardText } from "./hover-format";

type HoverCardProps = {
  card: HoverCardState;
};

export const HoverCard = ({ card }: HoverCardProps) => {
  const text = hoverCardText(card.content);
  const { left, top, flipX, flipY } = hoverCardPlacement(card);
  return (
    <div
      className="pointer-events-none absolute z-20 flex w-max max-w-72 flex-col gap-1 rounded-8 bg-white px-3 py-2 shadow-2"
      style={{
        left,
        top,
        transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
      }}
    >
      <div className="flex items-baseline gap-3">
        <p className="min-w-0 flex-1 truncate text-dns-14B-130 text-solid-gray-800">
          {text.titlePrefix !== null && (
            <span className="mr-1 font-normal text-solid-gray-600">{text.titlePrefix}</span>
          )}
          {text.title}
        </p>
        {text.year !== null && (
          <p className="shrink-0 text-dns-14N-130 text-solid-gray-600">{text.year}</p>
        )}
      </div>
      {text.rows.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 text-dns-14N-130 text-solid-gray-800">
          {text.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="min-w-0 break-words">
                {row.label}
                {row.note !== null && <span className="block text-solid-gray-600">{row.note}</span>}
              </dt>
              <dd className="max-w-40 truncate text-right tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {text.more !== null && <p className="text-dns-14N-130 text-solid-gray-600">{text.more}</p>}
    </div>
  );
};
