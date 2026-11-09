import { describe, expect, it } from "vitest";
import { INDICATOR_IDS } from "../core/indicators/definitions";
import type { IndicatorSelection } from "../core/state/state";
import type { DatasetEntry } from "../core/storage/manifest";
import {
  DENOMINATOR_OPTIONS,
  denominatorKey,
  indicatorOptionGroups,
  selectionKey,
  summableColumns,
  withDenominator,
} from "./indicator-options";

const entry = (fields: Partial<DatasetEntry> & Pick<DatasetEntry, "id">): DatasetEntry => ({
  name: fields.id,
  source: { name: `${fields.id}.csv`, size: 100 },
  imported_at: "2026-11-09T00:00:00Z",
  kind: "point",
  join: ["mesh", "municipality"],
  columns: [],
  style: { color: "#0072b2", size: 4, visible: true },
  stored_format: "parquet",
  ...fields,
});

/** CSV の施設の一覧。lat と lon は結合用の列 */
const clinics = entry({
  id: "clinics",
  name: "医療機関",
  columns: [
    { name: "lat", type: "float" },
    { name: "lon", type: "float" },
    { name: "病床数", type: "integer" },
    { name: "名称", type: "string" },
  ],
});

/** 市区町村別の統計。code で結合するので市区町村にだけ重なる */
const stats = entry({
  id: "stats",
  name: "統計",
  kind: "table",
  join: ["municipality"],
  columns: [
    { name: "code", type: "string" },
    { name: "予算", type: "float" },
  ],
});

/** GeoJSON の点。properties に lat という名前の属性があれば、それは結合用の列ではない */
const geoPoints = entry({
  id: "geo",
  kind: "point",
  stored_format: "geojson",
  columns: [{ name: "lat", type: "float" }],
});

const AGING: IndicatorSelection = { kind: "base", id: "aging_rate" };

describe("summableColumns", () => {
  it("表の点は lat と lon を除いた数値の列だけを合計できる", () => {
    expect(summableColumns(clinics)).toEqual(["病床数"]);
  });

  it("GeoJSON の properties は、名前が lat でも合計できる", () => {
    expect(summableColumns(geoPoints)).toEqual(["lat"]);
  });

  it("mesh の表は mesh の列を除く", () => {
    const meshTable = entry({
      id: "m",
      kind: "table",
      join: ["mesh"],
      columns: [
        { name: "mesh", type: "integer" },
        { name: "件数", type: "integer" },
      ],
    });
    expect(summableColumns(meshTable)).toEqual(["件数"]);
  });
});

describe("indicatorOptionGroups", () => {
  it("データがなければ、ベースデータの8指標だけを並べる", () => {
    const groups = indicatorOptionGroups("mesh", [], AGING);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBeNull();
    expect(groups[0]?.options.map((o) => o.selection)).toEqual(
      INDICATOR_IDS.map((id) => ({ kind: "base", id })),
    );
    expect(groups[0]?.options.find((o) => o.key === "base:aging_rate")?.label).toBe("高齢化率");
  });

  it("データごとに件数と合計を並べ、その単位に結合できないデータは出さない", () => {
    const groups = indicatorOptionGroups("mesh", [clinics, stats], AGING);
    expect(groups.map((g) => g.label)).toEqual([null, "医療機関"]);
    expect(groups[1]?.options.map((o) => o.label)).toEqual(["件数", "病床数 の合計"]);

    const municipal = indicatorOptionGroups("municipality", [clinics, stats], AGING);
    expect(municipal.map((g) => g.label)).toEqual([null, "医療機関", "統計"]);
  });

  it("結合した指標を選んでいるときは、分母を引き継ぐ", () => {
    const current: IndicatorSelection = {
      kind: "joined",
      datasetId: "clinics",
      measure: { kind: "count" },
      perPopulation: { base: "p65", per: 1000 },
    };
    const groups = indicatorOptionGroups("mesh", [clinics], current);
    const sum = groups[1]?.options[1]?.selection;
    expect(sum).toEqual({
      kind: "joined",
      datasetId: "clinics",
      measure: { kind: "sum", column: "病床数" },
      perPopulation: { base: "p65", per: 1000 },
    });
  });

  it("キーはどの選択肢でも異なり、selectionKey と一致する", () => {
    const groups = indicatorOptionGroups("municipality", [clinics, stats, geoPoints], AGING);
    const options = groups.flatMap((g) => g.options);
    expect(new Set(options.map((o) => o.key)).size).toBe(options.length);
    for (const option of options) {
      expect(selectionKey(option.selection)).toBe(option.key);
    }
  });
});

describe("分母", () => {
  it("選択肢は「分母なし」と人数の5指標", () => {
    expect(DENOMINATOR_OPTIONS.map((o) => o.base)).toEqual([
      null,
      "pop",
      "p0_14",
      "p15_64",
      "p65",
      "p75",
    ]);
    expect(DENOMINATOR_OPTIONS[1]?.label).toBe("総人口 1,000 人あたり");
  });

  it("分母を選ぶと 1,000 人あたりにし、「分母なし」で外す", () => {
    const count: IndicatorSelection = {
      kind: "joined",
      datasetId: "clinics",
      measure: { kind: "count" },
      perPopulation: null,
    };
    const perAged = withDenominator(count, "p65");
    expect(perAged).toEqual({ ...count, perPopulation: { base: "p65", per: 1000 } });
    expect(denominatorKey(perAged)).toBe("p65");
    expect(withDenominator(perAged, null)).toEqual(count);
    expect(denominatorKey(count)).toBe("none");
  });

  it("ベースデータの指標には分母を付けない", () => {
    expect(withDenominator(AGING, "pop")).toBe(AGING);
  });
});
