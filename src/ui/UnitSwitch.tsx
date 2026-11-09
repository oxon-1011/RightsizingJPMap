// 塗る単位の切り替え。DADS のボタン（X-Small）2つで明示的に選ばせる（docs/design/ui.md の「単位の切り替え」）。
// 選んでいる単位を塗りつぶしのボタン、もう一方を枠線のボタンにし、aria-pressed で状態を伝える。

import type { Unit } from "../core/indicators/definitions";
import { Button } from "./dads/Button";

type UnitSwitchProps = {
  unit: Unit;
  onChange: (unit: Unit) => void;
};

const UNITS: readonly { readonly unit: Unit; readonly label: string }[] = [
  { unit: "mesh", label: "メッシュ" },
  { unit: "municipality", label: "市区町村" },
];

export const UnitSwitch = ({ unit, onChange }: UnitSwitchProps) => (
  <fieldset className="flex gap-1">
    <legend className="sr-only">塗る単位</legend>
    {UNITS.map((u) => (
      <Button
        key={u.unit}
        type="button"
        size="xs"
        variant={u.unit === unit ? "solid-fill" : "outline"}
        // 塗りつぶし（枠 4px）と枠線（枠 1px）で幅が変わり、切り替えるたびにボタンが動くので、幅をそろえる
        className="min-w-21"
        aria-pressed={u.unit === unit}
        onClick={() => {
          if (u.unit !== unit) {
            onChange(u.unit);
          }
        }}
      >
        {u.label}
      </Button>
    ))}
  </fieldset>
);
