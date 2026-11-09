// 年次スライダー。DADS にないので自作し、5年刻みの目盛りと、選んだ年の大きな数字を付ける（Figma の「Control / 年次スライダー」）。
// キーボードの操作とスクリーンリーダーへの伝え方は、WAI-ARIA APG のスライダーの作りに合わせる。
// トラックには単位の年をすべて並べ、選べない年（年齢別の指標でのメッシュの 2020 年）の目盛りは薄くする。

import type { KeyboardEvent, PointerEvent } from "react";
import { yearAtRatio, yearForKey, yearRatio } from "./year-slider";

type YearSliderProps = {
  /** トラックに並べる年（year-slider.ts の trackYears） */
  years: readonly number[];
  /** つまみを止められる年（core の selectableYears） */
  selectableYears: readonly number[];
  value: number;
  onChange: (year: number) => void;
};

const percent = (ratio: number): string => `${ratio * 100}%`;

export const YearSlider = ({ years, selectableYears, value, onChange }: YearSliderProps) => {
  const ratio = yearRatio(value, years);
  const first = years[0];
  const last = years[years.length - 1];

  const change = (year: number): void => {
    if (year !== value) {
      onChange(year);
    }
  };

  const changeAt = (e: PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    change(yearAtRatio((e.clientX - rect.left) / rect.width, years, selectableYears));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const year = yearForKey(e.key, value, selectableYears);
    if (year !== null) {
      e.preventDefault();
      change(year);
    }
  };

  return (
    <div className="flex items-center gap-6 rounded-8 bg-white px-6 py-3 shadow-2">
      <p aria-hidden={true} className="text-std-24B-150 text-solid-gray-800 tabular-nums">
        {value}
      </p>
      {/* トラックのどこを押しても、その位置に最も近い年へ動かす。キーボードではつまみを操作する */}
      <div
        className="relative h-11 w-110 touch-none select-none"
        onPointerDown={(e) => {
          if (e.button !== 0) {
            return;
          }
          // 既定の動作のままだと、フォーカスのない要素を押したことになり、つまみからフォーカスが外れる
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.querySelector<HTMLElement>("[role=slider]")?.focus();
          changeAt(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            changeAt(e);
          }
        }}
      >
        <div className="absolute top-3 h-1 w-full rounded-full bg-solid-gray-100" />
        <div
          className="absolute top-3 h-1 rounded-full bg-key-900"
          style={{ width: percent(ratio) }}
        />
        {years.map((year) => {
          const selectable = selectableYears.includes(year);
          const passed = year <= value;
          return (
            <div
              key={year}
              className={`absolute top-5 h-1.5 w-0.5 -translate-x-1/2 ${
                !selectable ? "bg-solid-gray-200" : passed ? "bg-key-900" : "bg-solid-gray-420"
              }`}
              style={{ left: percent(yearRatio(year, years)) }}
            />
          );
        })}
        <div
          role="slider"
          tabIndex={0}
          aria-label="年次"
          aria-valuemin={selectableYears[0]}
          aria-valuemax={selectableYears[selectableYears.length - 1]}
          aria-valuenow={value}
          aria-valuetext={`${value}年`}
          aria-orientation="horizontal"
          className={`
            absolute top-1 size-5 -translate-x-1/2 cursor-pointer rounded-full border-2 border-key-900 bg-white shadow-1
            focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300
          `}
          style={{ left: percent(ratio) }}
          onKeyDown={handleKeyDown}
        />
        <span
          aria-hidden={true}
          className="absolute top-[calc(30/16*1rem)] left-0 text-oln-14N-100 text-solid-gray-600"
        >
          {first}
        </span>
        <span
          aria-hidden={true}
          className="absolute top-[calc(30/16*1rem)] right-0 text-oln-14N-100 text-solid-gray-600"
        >
          {last}
        </span>
      </div>
    </div>
  );
};
