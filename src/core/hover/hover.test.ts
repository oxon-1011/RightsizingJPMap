import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { indexMeshes } from "../join/per-population";
import { meshCodeToBounds } from "../mesh/mesh-code";
import type { IndicatorSelection } from "../state/state";
import {
  type ChoroplethHoverData,
  type HoverData,
  type HoverHit,
  hoverContent,
  hoverPopulationIndicator,
  type LayerHoverData,
  MAX_HOVER_ATTRIBUTES,
  meshHoverColumns,
} from "./hover";

const AGING: IndicatorSelection = { kind: "base", id: "aging_rate" };

// 東京駅（53394611）と札幌駅（64414288）のメッシュ。user-data.md の「点からメッシュコードを求める」と同じ
const TOKYO = { lat: 35.681236, lon: 139.767125 };
const SAPPORO = { lat: 43.068661, lon: 141.350755 };
const TOKYO_CODE = 53394611;
const SAPPORO_CODE = 64414288;

/** メッシュの中央の点 */
const centerOf = (code: number) => {
  const b = meshCodeToBounds(code);
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
};

const hitAt = (at: { lat: number; lon: number }, overrides: Partial<HoverHit> = {}): HoverHit => ({
  ...at,
  municipalityCode: null,
  feature: null,
  ...overrides,
});

// ベースデータの3つのメッシュ。3つめ（52350000）は架空のメッシュで、秘匿にしてある
const BASE_CODES = Uint32Array.from([TOKYO_CODE, SAPPORO_CODE, 52350000]);

type MeshHoverData = Extract<ChoroplethHoverData, { readonly unit: "mesh" }>;

const meshData = (overrides: Partial<MeshHoverData> = {}): HoverData => ({
  choropleth: {
    unit: "mesh",
    year: 2050,
    indicator: AGING,
    datasetName: null,
    valueRows: indexMeshes(BASE_CODES),
    values: Float32Array.from([0.25, Number.NaN, Number.NaN]),
    baseRows: indexMeshes(BASE_CODES),
    population: { indicator: "pop", values: Float32Array.from([120.5, 0, 30]), masked: [] },
    masked: [Uint8Array.from([0, 0, 1])],
    ...overrides,
  },
  layers: new Map(),
});

const joined = (
  perPopulation: { base: "pop" | "p65"; per: number } | null,
): IndicatorSelection => ({
  kind: "joined",
  datasetId: "d",
  measure: { kind: "count" },
  perPopulation,
});

describe("hoverPopulationIndicator", () => {
  it("2行目は総人口にし、指標が総人口なら出さない", () => {
    expect(hoverPopulationIndicator(AGING)).toBe("pop");
    expect(hoverPopulationIndicator({ kind: "base", id: "p65" })).toBe("pop");
    expect(hoverPopulationIndicator({ kind: "base", id: "pop" })).toBeNull();
    expect(hoverPopulationIndicator(joined(null))).toBe("pop");
    expect(hoverPopulationIndicator(joined({ base: "pop", per: 1000 }))).toBe("pop");
  });

  it("人口あたりの値の分母が総人口でなければ、その分母の人数にする", () => {
    expect(hoverPopulationIndicator(joined({ base: "p65", per: 1000 }))).toBe("p65");
  });
});

describe("meshHoverColumns", () => {
  const TOTAL = { indicator: "pop", value: "2050_pop", masked: [] };

  it("比の指標では、その年の総人口と秘匿の列を読む", () => {
    expect(meshHoverColumns(AGING, 2050)).toEqual({ population: TOTAL, masked: ["2050_masked"] });
  });

  it("総人口の指標では総人口を2回出さないので、総人口の列を読まない", () => {
    expect(meshHoverColumns({ kind: "base", id: "pop" }, 2050)).toEqual({
      population: null,
      masked: [],
    });
  });

  it("2時点の年齢別の指標では、両方の年の秘匿の列を読む", () => {
    expect(meshHoverColumns({ kind: "base", id: "elderly_change" }, 2050)).toEqual({
      population: TOTAL,
      masked: ["2050_masked", "2025_masked"],
    });
  });

  it("総数から計算する指標は秘匿の扱いを受けない（D7）", () => {
    expect(meshHoverColumns({ kind: "base", id: "pop_change" }, 2070).masked).toEqual([]);
  });

  it("結合した指標では、人口あたりの値の分母の人数と、その秘匿の列を読む", () => {
    expect(meshHoverColumns(joined(null), 2050)).toEqual({ population: TOTAL, masked: [] });
    expect(meshHoverColumns(joined({ base: "p65", per: 1000 }), 2050)).toEqual({
      population: { indicator: "p65", value: "2050_p65", masked: ["2050_masked"] },
      masked: ["2050_masked"],
    });
    expect(meshHoverColumns(joined({ base: "pop", per: 1000 }), 2050)).toEqual({
      population: TOTAL,
      masked: [],
    });
  });

  it("分母の年齢別の人数がない年（2020 年）には、2行目の列を読まない", () => {
    expect(meshHoverColumns(joined({ base: "p65", per: 1000 }), 2020)).toEqual({
      population: null,
      masked: [],
    });
  });
});

describe("hoverContent のメッシュ", () => {
  it("ポインタの経緯度のメッシュの値と、その年の総人口を出す", () => {
    expect(hoverContent(meshData(), hitAt(TOKYO))).toEqual({
      kind: "mesh",
      code: TOKYO_CODE,
      year: 2050,
      indicator: AGING,
      datasetName: null,
      value: { kind: "number", value: 0.25 },
      population: { indicator: "pop", value: { kind: "number", value: Math.fround(120.5) } },
    });
  });

  it("値がなく秘匿の列が立っていれば秘匿、立っていなければ値なしにする", () => {
    expect(hoverContent(meshData(), hitAt(centerOf(52350000)))).toMatchObject({
      value: { kind: "masked" },
      population: { value: { kind: "number", value: 30 } },
    });
    // 総人口が 0 のメッシュの比は値なし。総人口の 0 を添える
    expect(hoverContent(meshData(), hitAt(SAPPORO))).toMatchObject({
      code: SAPPORO_CODE,
      value: { kind: "none" },
      population: { value: { kind: "number", value: 0 } },
    });
  });

  it("秘匿の列の NaN は io の誤りなので、秘匿ではなく値なしにする", () => {
    const data = meshData({ masked: [Float32Array.from([0, Number.NaN, Number.NaN])] });
    expect(hoverContent(data, hitAt(centerOf(52350000)))).toMatchObject({
      value: { kind: "none" },
    });
  });

  it("塗り分けにもベースデータにもないメッシュには出さない", () => {
    expect(hoverContent(meshData(), hitAt({ lat: 30.0, lon: 140.0 }))).toBeNull();
  });

  it("総人口の指標では、総人口の行を出さない", () => {
    const data = meshData({ indicator: { kind: "base", id: "pop" }, population: null });
    expect(hoverContent(data, hitAt(TOKYO))).toMatchObject({ population: null });
  });

  it("結合した指標で、ベースデータにないメッシュの総人口は値なしにする", () => {
    const joinedCodes = Uint32Array.from([52350001]);
    const data = meshData({
      indicator: {
        kind: "joined",
        datasetId: "d",
        measure: { kind: "count" },
        perPopulation: null,
      },
      datasetName: "診療所",
      valueRows: indexMeshes(joinedCodes),
      values: Float64Array.from([3]),
      masked: [],
    });
    expect(hoverContent(data, hitAt(centerOf(52350001)))).toMatchObject({
      code: 52350001,
      datasetName: "診療所",
      value: { kind: "number", value: 3 },
      population: { indicator: "pop", value: { kind: "none" } },
    });
    // 集計していないメッシュは塗っていないので、値なしにする
    expect(hoverContent(data, hitAt(TOKYO))).toMatchObject({
      value: { kind: "none" },
      population: { value: { kind: "number", value: Math.fround(120.5) } },
    });
  });

  it("人口あたりの値の分母の人数を2行目に出し、秘匿の列が立っていれば秘匿にする", () => {
    const data = meshData({
      indicator: joined({ base: "p65", per: 1000 }),
      datasetName: "診療所",
      values: Float32Array.from([2.5, Number.NaN, Number.NaN]),
      population: {
        indicator: "p65",
        values: Float32Array.from([40, 0, 0]),
        masked: [Uint8Array.from([0, 0, 1])],
      },
    });
    expect(hoverContent(data, hitAt(TOKYO))).toMatchObject({
      value: { kind: "number", value: 2.5 },
      population: { indicator: "p65", value: { kind: "number", value: 40 } },
    });
    expect(hoverContent(data, hitAt(centerOf(52350000)))).toMatchObject({
      value: { kind: "masked" },
      population: { indicator: "p65", value: { kind: "masked" } },
    });
  });

  it("メッシュの中のどの点でも、そのメッシュのコードを出す", () => {
    const codes = [...BASE_CODES];
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        (code, fy, fx) => {
          const b = meshCodeToBounds(code);
          const at = {
            lat: b.south + (b.north - b.south) * fy,
            lon: b.west + (b.east - b.west) * fx,
          };
          expect(hoverContent(meshData(), hitAt(at))).toMatchObject({ kind: "mesh", code });
        },
      ),
    );
  });
});

const municipalData = (): HoverData => ({
  choropleth: {
    unit: "municipality",
    year: 2050,
    indicator: AGING,
    datasetName: null,
    values: new Map([
      ["31201", 0.38],
      ["31202", Number.NaN],
    ]),
    population: {
      indicator: "pop",
      values: new Map([
        ["31201", 150000],
        ["31202", 140000],
      ]),
    },
    names: {
      areas: new Map([
        ["31000", "鳥取県"],
        ["31201", "鳥取市"],
        ["31202", "米子市"],
      ]),
      prefectures: new Map([["31", "鳥取県"]]),
    },
  },
  layers: new Map(),
});

describe("hoverContent の市区町村", () => {
  it("区域の名前と都道府県、値、その年の総人口を出す", () => {
    const hit = hitAt(TOKYO, { municipalityCode: "31201" });
    expect(hoverContent(municipalData(), hit)).toEqual({
      kind: "municipality",
      code: "31201",
      name: "鳥取市",
      prefecture: "鳥取県",
      year: 2050,
      indicator: AGING,
      datasetName: null,
      value: { kind: "number", value: 0.38 },
      population: { indicator: "pop", value: { kind: "number", value: 150000 } },
    });
  });

  it("値のない区域は値なしにする", () => {
    const nan = hitAt(TOKYO, { municipalityCode: "31202" });
    expect(hoverContent(municipalData(), nan)).toMatchObject({
      name: "米子市",
      value: { kind: "none" },
      population: { indicator: "pop", value: { kind: "number", value: 140000 } },
    });
  });

  it("区域の外と、値の表にない区域（値のない北方領土の村）には出さない", () => {
    expect(hoverContent(municipalData(), hitAt(TOKYO))).toBeNull();
    expect(hoverContent(municipalData(), hitAt(TOKYO, { municipalityCode: "01695" }))).toBeNull();
  });
});

const POINTS: LayerHoverData = {
  datasetId: "clinics",
  name: "診療所",
  pointAttributes: {
    names: ["beds", "staff"],
    columns: { beds: Float64Array.from([19, Number.NaN]), staff: Float64Array.from([3, 4]) },
  },
};

const SHAPES: LayerHoverData = { datasetId: "areas", name: "管轄", pointAttributes: null };

const withLayers = (data: HoverData): HoverData => ({
  ...data,
  layers: new Map([
    ["rjm-dataset-clinics", POINTS],
    ["rjm-dataset-areas", SHAPES],
  ]),
});

describe("hoverContent の自前データ", () => {
  it("点のレイヤーは、メモリに持つ数値の属性を点の番号で引く。NaN は null にする", () => {
    const hit = hitAt(TOKYO, {
      feature: { layerId: "rjm-dataset-clinics", index: 1, properties: undefined },
    });
    expect(hoverContent(withLayers(meshData()), hit)).toEqual({
      kind: "feature",
      datasetId: "clinics",
      layerName: "診療所",
      attributes: [
        { name: "beds", value: null },
        { name: "staff", value: 4 },
      ],
      omitted: 0,
    });
  });

  it("線と面は地物の properties を先頭から出し、出さなかった数を数える", () => {
    const properties = { a: "あ", b: 2, c: true, d: null, e: { nested: 1 }, f: 6, g: 7 };
    const hit = hitAt(TOKYO, { feature: { layerId: "rjm-dataset-areas", index: 0, properties } });
    expect(hoverContent(withLayers(meshData()), hit)).toEqual({
      kind: "feature",
      datasetId: "areas",
      layerName: "管轄",
      attributes: [
        { name: "a", value: "あ" },
        { name: "b", value: 2 },
        { name: "c", value: true },
        { name: "d", value: null },
        { name: "e", value: '{"nested":1}' },
      ],
      omitted: 2,
    });
    expect(MAX_HOVER_ATTRIBUTES).toBe(5);
  });

  it("properties がオブジェクトでなければ、レイヤーの名前だけを出す", () => {
    const hit = hitAt(TOKYO, {
      feature: { layerId: "rjm-dataset-areas", index: 0, properties: null },
    });
    expect(hoverContent(withLayers(meshData()), hit)).toMatchObject({
      attributes: [],
      omitted: 0,
    });
  });

  it("自前データの地物は、下の市区町村より先に出す", () => {
    const hit = hitAt(TOKYO, {
      municipalityCode: "31201",
      feature: { layerId: "rjm-dataset-areas", index: 0, properties: {} },
    });
    expect(hoverContent(withLayers(municipalData()), hit)).toMatchObject({ kind: "feature" });
  });

  it("知らないレイヤーの地物（消したばかりのデータなど）は、下の塗り分けを出す", () => {
    const hit = hitAt(TOKYO, {
      feature: { layerId: "rjm-dataset-gone", index: 0, properties: {} },
    });
    expect(hoverContent(withLayers(meshData()), hit)).toMatchObject({ kind: "mesh" });
  });

  it("塗り分けを作る前は、自前データの地物だけを出す", () => {
    const empty = withLayers({ choropleth: null, layers: new Map() });
    expect(hoverContent(empty, hitAt(TOKYO))).toBeNull();
    const hit = hitAt(TOKYO, {
      feature: { layerId: "rjm-dataset-areas", index: 0, properties: {} },
    });
    expect(hoverContent(empty, hit)).toMatchObject({ kind: "feature" });
  });
});
