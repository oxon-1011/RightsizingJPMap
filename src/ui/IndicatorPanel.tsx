// 左上のパネル。指標のセレクトボックス、凡例、単位の切り替えを縦に並べる（Figma の「Panel / 指標」）。
// 見出しや説明文は置かない。自前データの指標を選んだときだけ、分母のセレクトボックスを出す（D24）。
// 単位の切り替えの右に、背景地図の設定を開く歯車を置く（段階 7.5 の 5.。Figma の画面にはまだない）。

import type { Classification } from "../core/classify/classify";
import { classificationOf } from "../core/classify/scales";
import { INDICATORS, type Unit } from "../core/indicators/definitions";
import type { BasemapLayerGroup, BasemapVisibility } from "../core/render/basemap";
import type { IndicatorSelection } from "../core/state/state";
import type { DatasetEntry } from "../core/storage/manifest";
import { BasemapSettings } from "./BasemapSettings";
import { Select } from "./dads/Select";
import {
  DENOMINATOR_OPTIONS,
  denominatorKey,
  indicatorOptionGroups,
  selectionKey,
  withDenominator,
} from "./indicator-options";
import { Legend } from "./Legend";
import type { LegendScale } from "./legend-format";
import { UnitSwitch } from "./UnitSwitch";

type IndicatorPanelProps = {
  unit: Unit;
  indicator: IndicatorSelection;
  datasets: readonly DatasetEntry[];
  /**
   * 自前データの指標の階級区分。取り込んだ値の分位で区切るので、app が core の joinedClassification で作って渡す。
   * まだ作れていなければ null で、凡例を出さない。ベースデータの指標では使わない。
   */
  joinedClassification: Classification | null;
  /** 背景地図の鉄道、道路、川を表示するか */
  basemap: BasemapVisibility;
  onIndicatorChange: (indicator: IndicatorSelection) => void;
  onUnitChange: (unit: Unit) => void;
  onBasemapChange: (group: BasemapLayerGroup, visible: boolean) => void;
};

/** 凡例に使う階級区分と数字の種類 */
const legendOf = (
  unit: Unit,
  indicator: IndicatorSelection,
  joined: Classification | null,
): { readonly classification: Classification; readonly scale: LegendScale } | null => {
  switch (indicator.kind) {
    case "base":
      return {
        classification: classificationOf(indicator.id, unit),
        scale: INDICATORS[indicator.id].scale,
      };
    case "joined":
      return joined === null ? null : { classification: joined, scale: "number" };
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};

export const IndicatorPanel = ({
  unit,
  indicator,
  datasets,
  joinedClassification,
  basemap,
  onIndicatorChange,
  onUnitChange,
  onBasemapChange,
}: IndicatorPanelProps) => {
  const groups = indicatorOptionGroups(unit, datasets, indicator);
  const options = groups.flatMap((g) => g.options);
  const legend = legendOf(unit, indicator, joinedClassification);
  return (
    <section
      aria-label="指標"
      className="flex w-80 flex-col items-start gap-4 rounded-8 bg-white p-4 shadow-2"
    >
      <Select
        aria-label="指標"
        blockSize="sm"
        className="w-full"
        value={selectionKey(indicator)}
        onChange={(e) => {
          const selected = options.find((o) => o.key === e.currentTarget.value);
          if (selected !== undefined) {
            onIndicatorChange(selected.selection);
          }
        }}
      >
        {groups.map((group) =>
          group.label === null ? (
            group.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))
          ) : (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </Select>
      {indicator.kind === "joined" && (
        <Select
          aria-label="分母"
          blockSize="sm"
          className="w-full"
          value={denominatorKey(indicator)}
          onChange={(e) => {
            const selected = DENOMINATOR_OPTIONS.find((o) => o.key === e.currentTarget.value);
            if (selected !== undefined) {
              onIndicatorChange(withDenominator(indicator, selected.base));
            }
          }}
        >
          {DENOMINATOR_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
      {legend !== null && <Legend classification={legend.classification} scale={legend.scale} />}
      <div className="flex w-full items-center justify-between">
        <UnitSwitch unit={unit} onChange={onUnitChange} />
        <BasemapSettings visibility={basemap} onChange={onBasemapChange} />
      </div>
    </section>
  );
};
