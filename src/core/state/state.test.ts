import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MESH_YEARS } from "../data/schema";
import { INDICATOR_IDS, POPULATION_INDICATOR_IDS } from "../indicators/definitions";
import type { DatasetEntry } from "../storage/manifest";
import {
  type Action,
  type AppState,
  DEFAULT_INDICATOR,
  INITIAL_STATE,
  isIndicatorAvailable,
  nearestYear,
  reduce,
  selectableYears,
} from "./state";

const dataset = (id: string, join: DatasetEntry["join"]): DatasetEntry => ({
  id,
  name: id,
  source: { name: `${id}.csv`, size: 1 },
  imported_at: "2026-11-07T10:00:00Z",
  kind: join.length === 2 ? "point" : "table",
  join,
  columns: [{ name: "beds", type: "integer" }],
  count: 1,
  style: { color: "#0072b2", size: 4, visible: true },
  stored_format: "parquet",
});

const run = (state: AppState, ...actions: Action[]): AppState => actions.reduce(reduce, state);

const writer = run(INITIAL_STATE, { type: "access-changed", access: "writer" });

describe("単位の切り替え", () => {
  it("市区町村に切り替えたとき、2050 年より後なら 2050 年にして通知する", () => {
    const state = run(
      writer,
      { type: "year-selected", year: 2070 },
      { type: "unit-selected", unit: "municipality" },
    );
    expect(state.year).toBe(2050);
    expect(state.notices).toEqual([{ id: 1, kind: "year-adjusted", from: 2070, to: 2050 }]);
  });

  it("2050 年以下なら年を変えず、通知もしない", () => {
    const state = run(writer, { type: "unit-selected", unit: "municipality" });
    expect(state.year).toBe(2050);
    expect(state.notices).toEqual([]);
  });

  it("行政区域で 2020 年の年齢別の指標からメッシュに切り替えると、2025 年にして通知する", () => {
    const state = run(
      writer,
      { type: "unit-selected", unit: "municipality" },
      { type: "year-selected", year: 2020 },
      { type: "unit-selected", unit: "mesh" },
    );
    expect(state.year).toBe(2025);
    expect(state.notices.at(-1)).toMatchObject({ kind: "year-adjusted", from: 2020, to: 2025 });
  });
});

describe("指標の切り替え", () => {
  it("メッシュの 2020 年で年齢別の指標を選ぶと、2025 年にして通知する", () => {
    const state = run(
      writer,
      { type: "indicator-selected", indicator: { kind: "base", id: "pop" } },
      { type: "year-selected", year: 2020 },
      { type: "indicator-selected", indicator: { kind: "base", id: "p65" } },
    );
    expect(state.year).toBe(2025);
    expect(state.notices).toEqual([{ id: 1, kind: "year-adjusted", from: 2020, to: 2025 }]);
  });

  it("メッシュで年齢別の指標のとき、2020 年は選べない", () => {
    const state = run(writer, { type: "year-selected", year: 2020 });
    expect(state.year).toBe(2050);
  });

  it("その単位に結合できないデータの指標は選べない", () => {
    const state = run(
      writer,
      { type: "dataset-added", entry: dataset("codes", ["municipality"]) },
      {
        type: "indicator-selected",
        indicator: {
          kind: "joined",
          datasetId: "codes",
          measure: { kind: "count" },
          perPopulation: null,
        },
      },
    );
    expect(state.indicator).toEqual(DEFAULT_INDICATOR);
  });

  it("選んでいた結合した指標が単位の切り替えで塗れなくなったら、既定の指標に戻して通知する", () => {
    const joined = {
      kind: "joined",
      datasetId: "codes",
      measure: { kind: "sum", column: "beds" },
      perPopulation: { base: "p65", per: 1000 },
    } as const;
    const state = run(
      writer,
      { type: "unit-selected", unit: "municipality" },
      { type: "dataset-added", entry: dataset("codes", ["municipality"]) },
      { type: "indicator-selected", indicator: joined },
    );
    expect(state.indicator).toEqual(joined);
    const back = reduce(state, { type: "unit-selected", unit: "mesh" });
    expect(back.indicator).toEqual(DEFAULT_INDICATOR);
    expect(back.notices.at(-1)).toMatchObject({ kind: "indicator-reset", reason: "unit" });
  });

  it("選んでいたデータを消すと、既定の指標に戻して通知する", () => {
    const state = run(
      writer,
      { type: "dataset-added", entry: dataset("pts", ["mesh", "municipality"]) },
      {
        type: "indicator-selected",
        indicator: {
          kind: "joined",
          datasetId: "pts",
          measure: { kind: "count" },
          perPopulation: null,
        },
      },
      { type: "dataset-removed", id: "pts" },
    );
    expect(state.indicator).toEqual(DEFAULT_INDICATOR);
    expect(state.datasets).toEqual([]);
    expect(state.notices.at(-1)).toMatchObject({
      kind: "indicator-reset",
      reason: "dataset-removed",
    });
  });

  it("結合用の列（lat、lon、mesh）の合計は塗れる指標にしない", () => {
    const points: DatasetEntry = {
      ...dataset("points", ["mesh", "municipality"]),
      columns: [
        { name: "lat", type: "float" },
        { name: "lon", type: "float" },
        { name: "beds", type: "integer" },
      ],
    };
    const sum = (column: string) =>
      ({
        kind: "joined",
        datasetId: "points",
        measure: { kind: "sum", column },
        perPopulation: null,
      }) as const;
    expect(isIndicatorAvailable("mesh", sum("beds"), [points])).toBe(true);
    expect(isIndicatorAvailable("mesh", sum("lat"), [points])).toBe(false);
    expect(isIndicatorAvailable("municipality", sum("lon"), [points])).toBe(false);
  });
});

describe("書き込みの権利", () => {
  it("閲覧専用のタブでは、データの追加と削除をせずに通知する", () => {
    const readOnly = run(INITIAL_STATE, { type: "access-changed", access: "read-only" });
    expect(readOnly.notices).toMatchObject([{ kind: "read-only" }]);
    const state = run(readOnly, { type: "dataset-added", entry: dataset("a", ["mesh"]) });
    expect(state.datasets).toEqual([]);
    expect(state.notices.at(-1)).toMatchObject({ kind: "write-blocked" });
  });

  it("閲覧専用のタブでも、目録の読み直しは反映する", () => {
    const state = run(
      INITIAL_STATE,
      { type: "access-changed", access: "read-only" },
      { type: "datasets-loaded", datasets: [dataset("a", ["mesh"])] },
    );
    expect(state.datasets.map((d) => d.id)).toEqual(["a"]);
  });

  it("閲覧専用から書き込みできる状態に移ったら、閲覧専用の通知を消して知らせる", () => {
    const state = run(
      INITIAL_STATE,
      { type: "access-changed", access: "read-only" },
      { type: "dataset-added", entry: dataset("a", ["mesh"]) },
      { type: "access-changed", access: "writer" },
    );
    expect(state.access).toBe("writer");
    expect(state.notices.map((n) => n.kind)).toEqual(["became-writer"]);
  });
});

describe("通知", () => {
  it("同じ種類の通知は置き換え、取り込みの通知は積み重ね、番号で消す", () => {
    const rejected = {
      type: "notified",
      notice: {
        kind: "import-rejected",
        fileName: "a.xlsx",
        rejection: { stage: "format", extension: "xlsx" },
      },
    } as const;
    const state = run(
      writer,
      { type: "year-selected", year: 2070 },
      { type: "unit-selected", unit: "municipality" },
      { type: "unit-selected", unit: "mesh" },
      { type: "year-selected", year: 2070 },
      { type: "unit-selected", unit: "municipality" },
      rejected,
      rejected,
    );
    expect(state.notices.map((n) => n.kind)).toEqual([
      "year-adjusted",
      "import-rejected",
      "import-rejected",
    ]);
    const [first] = state.notices;
    const dismissed = reduce(state, { type: "notice-dismissed", id: first?.id ?? -1 });
    expect(dismissed.notices).toHaveLength(2);
  });
});

describe("背景地図の表示", () => {
  it("はじめはすべて表示し、単位ごとに切り替える", () => {
    expect(INITIAL_STATE.basemap).toEqual({ rail: true, road: true, river: true });
    const state = run(
      INITIAL_STATE,
      { type: "basemap-visibility-changed", group: "rail", visible: false },
      { type: "basemap-visibility-changed", group: "river", visible: false },
      { type: "basemap-visibility-changed", group: "rail", visible: true },
    );
    expect(state.basemap).toEqual({ rail: true, road: true, river: false });
    expect({ ...state, basemap: INITIAL_STATE.basemap }).toEqual(INITIAL_STATE);
  });

  it("同じ表示を選んだら、同じ状態を返す", () => {
    const state = reduce(INITIAL_STATE, {
      type: "basemap-visibility-changed",
      group: "road",
      visible: true,
    });
    expect(state).toBe(INITIAL_STATE);
  });

  it("閲覧専用のタブでも切り替える", () => {
    const readOnly = run(INITIAL_STATE, { type: "access-changed", access: "read-only" });
    const state = reduce(readOnly, {
      type: "basemap-visibility-changed",
      group: "road",
      visible: false,
    });
    expect(state.basemap.road).toBe(false);
    expect(state.notices).toEqual(readOnly.notices);
  });
});

describe("nearestYear", () => {
  it("最も近い年を選び、同じ近さなら後の年にする", () => {
    expect(nearestYear(2070, [2020, 2025, 2050])).toBe(2050);
    expect(nearestYear(2020, [2025, 2030])).toBe(2025);
    expect(nearestYear(2027.5, [2025, 2030])).toBe(2030);
  });
});

describe("状態の性質", () => {
  const indicator = fc.oneof(
    fc.constantFrom(...INDICATOR_IDS).map((id) => ({ kind: "base", id }) as const),
    fc
      .record({
        datasetId: fc.constantFrom("mesh-table", "code-table", "points", "missing"),
        measure: fc.constantFrom(
          { kind: "count" } as const,
          { kind: "sum", column: "beds" } as const,
          { kind: "sum", column: "name" } as const,
        ),
        perPopulation: fc.option(
          fc.record({ base: fc.constantFrom(...POPULATION_INDICATOR_IDS), per: fc.constant(1000) }),
        ),
      })
      .map((r) => ({ kind: "joined", ...r }) as const),
  );
  const datasets = [
    dataset("mesh-table", ["mesh"]),
    dataset("code-table", ["municipality"]),
    dataset("points", ["mesh", "municipality"]),
  ];
  const action: fc.Arbitrary<Action> = fc.oneof(
    fc
      .constantFrom("mesh", "municipality")
      .map((unit) => ({ type: "unit-selected", unit }) as const),
    fc.constantFrom(...MESH_YEARS).map((year) => ({ type: "year-selected", year }) as const),
    indicator.map((i) => ({ type: "indicator-selected", indicator: i }) as const),
    fc.constantFrom(...datasets).map((entry) => ({ type: "dataset-added", entry }) as const),
    fc.constantFrom(...datasets).map((d) => ({ type: "dataset-removed", id: d.id }) as const),
    fc.subarray(datasets).map((ds) => ({ type: "datasets-loaded", datasets: ds }) as const),
    fc
      .constantFrom("writer", "read-only")
      .map((access) => ({ type: "access-changed", access }) as const),
  );

  it("どの操作の後も、市区町村の年は 2050 年以下で、年は選べる年、指標は塗れる指標", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
        let state = INITIAL_STATE;
        for (const a of actions) {
          state = reduce(state, a);
          if (state.unit === "municipality") {
            expect(state.year).toBeLessThanOrEqual(2050);
          }
          expect(selectableYears(state.unit, state.indicator)).toContain(state.year);
          expect(isIndicatorAvailable(state.unit, state.indicator, state.datasets)).toBe(true);
          expect(new Set(state.notices.map((n) => n.id)).size).toBe(state.notices.length);
        }
      }),
    );
  });
});
