// 凡例。色の帯と目盛りの数字だけにし、見出しは置かない（docs/design/ui.md の「凡例」）。
// 値なしを表す白い四角に「なし」と添える。スクリーンリーダーには階級の範囲を一覧で読ませる。

import type { Classification } from "../core/classify/classify";
import type { Rgba } from "../core/classify/color";
import { type LegendScale, legendRangeTexts, legendTicks, NO_VALUE_TEXT } from "./legend-format";

type LegendProps = {
  classification: Classification;
  scale: LegendScale;
};

const cssColor = ([r, g, b, a]: Rgba): string => `rgb(${r} ${g} ${b} / ${a / 255})`;

/** 「なし」の四角の幅と、色の帯とのあいだ（どちらも 12px）。目盛りの位置の計算に使う */
const NO_VALUE_AREA = "1.5rem";

/** 1階級の色の幅（Figma の凡例と同じ 40px）。パネルに収まらない階級の数（人口増減率の7階級）では縮める */
const CLASS_WIDTH_REM = 2.5;

export const Legend = ({ classification, scale }: LegendProps) => {
  const ticks = legendTicks(classification, scale);
  const ranges = legendRangeTexts(classification, scale);
  const width = `min(100%, calc(${classification.colors.length * CLASS_WIDTH_REM}rem + ${NO_VALUE_AREA}))`;
  return (
    <div className="flex flex-col gap-1" style={{ width }}>
      <div className="flex items-start" aria-hidden={true}>
        <div className="flex flex-1">
          {classification.colors.map((color) => (
            // 1つの配色の中で色は重ならないので、色をキーにする
            <div
              key={cssColor(color)}
              className="h-3 flex-1"
              style={{ backgroundColor: cssColor(color) }}
            />
          ))}
        </div>
        <div className="ml-3 size-3 shrink-0 border border-solid-gray-420 bg-white" />
      </div>
      <div className="relative h-4 text-oln-14N-100 text-solid-gray-600" aria-hidden={true}>
        {ticks.map((tick) => (
          <span
            key={tick.label}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
            style={{ left: `calc((100% - ${NO_VALUE_AREA}) * ${tick.position})` }}
          >
            {tick.label}
          </span>
        ))}
        <span className="absolute top-0 left-[calc(100%-0.375rem)] -translate-x-1/2 whitespace-nowrap">
          なし
        </span>
      </div>
      <ul className="sr-only" aria-label="凡例">
        {ranges.map((range) => (
          <li key={range}>{range}</li>
        ))}
        <li>なし：{NO_VALUE_TEXT}</li>
      </ul>
    </div>
  );
};
