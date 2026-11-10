import { describe, expect, it } from "vitest";
import type { HoverContent } from "../core/hover/hover";
import {
  HOVER_CARD_MAX_HEIGHT,
  HOVER_CARD_MAX_WIDTH,
  HOVER_CARD_OFFSET,
  hoverCardPlacement,
  hoverCardText,
} from "./hover-format";

const mesh = (overrides: Partial<Extract<HoverContent, { kind: "mesh" }>> = {}): HoverContent => ({
  kind: "mesh",
  code: 53394611,
  year: 2050,
  indicator: { kind: "base", id: "aging_rate" },
  datasetName: null,
  value: { kind: "number", value: 0.48234 },
  population: { indicator: "pop", value: { kind: "number", value: 1234.56 } },
  ...overrides,
});

describe("hoverCardText のメッシュと市区町村", () => {
  it("見出しはメッシュコードと年、行は指標と総人口にする。指標は凡例と同じ書き方、総人口は整数で全部の桁を出す", () => {
    expect(hoverCardText(mesh())).toEqual({
      title: "53394611",
      titlePrefix: null,
      year: "2050年",
      rows: [
        { label: "高齢化率", note: null, value: "48.2%" },
        { label: "総人口", note: null, value: "1,235 人" },
      ],
      more: null,
    });
  });

  it("増減率は凡例と同じく、負の数にマイナス記号、正の数に + を付ける", () => {
    const change = (value: number) =>
      hoverCardText(
        mesh({ indicator: { kind: "base", id: "pop_change" }, value: { kind: "number", value } }),
      ).rows[0]?.value;
    expect(change(-0.351)).toBe("−35.1%");
    expect(change(0.12)).toBe("+12%");
    expect(change(0)).toBe("0%");
  });

  it("秘匿は「秘匿」、値なしは凡例と同じ「なし」にする", () => {
    const text = hoverCardText(
      mesh({
        value: { kind: "masked" },
        population: { indicator: "pop", value: { kind: "none" } },
      }),
    );
    expect(text.rows.map((r) => r.value)).toEqual(["秘匿", "なし"]);
    expect(hoverCardText(mesh({ value: { kind: "none" } })).rows[0]?.value).toBe("なし");
  });

  it("総人口の指標では、総人口の行を1つだけにし、2行目と同じく整数で書く", () => {
    const text = (value: number) =>
      hoverCardText(
        mesh({
          indicator: { kind: "base", id: "pop" },
          value: { kind: "number", value },
          population: null,
        }),
      ).rows;
    expect(text(0.4)).toEqual([{ label: "総人口", note: null, value: "0 人" }]);
    expect(text(1283.5)).toEqual([{ label: "総人口", note: null, value: "1,284 人" }]);
  });

  it("市区町村は、都道府県を添えた区域の名前を見出しにする", () => {
    const text = hoverCardText({
      kind: "municipality",
      code: "31201",
      name: "鳥取市",
      prefecture: "鳥取県",
      year: 2030,
      indicator: { kind: "base", id: "p65" },
      datasetName: null,
      value: { kind: "number", value: 60000 },
      population: { indicator: "pop", value: { kind: "number", value: 60000 } },
    });
    expect(text).toMatchObject({ title: "鳥取市", titlePrefix: "鳥取県", year: "2030年" });
    // 年齢別の人数の指標は凡例と同じ書き方（「万」）、2行目の総人口は「万」を使わない
    expect(text.rows.map((r) => r.value)).toEqual(["6万 人", "60,000 人"]);
  });

  it("結合した指標は、データの名前と件数か合計にし、人口あたりの分母を添える", () => {
    const count = hoverCardText(
      mesh({
        indicator: {
          kind: "joined",
          datasetId: "d",
          measure: { kind: "count" },
          perPopulation: { base: "p65", per: 1000 },
        },
        datasetName: "診療所",
        value: { kind: "number", value: 2.3456 },
        population: { indicator: "p65", value: { kind: "number", value: 21234.4 } },
      }),
    );
    // 分母が総人口でなければ、2行目は分母の人数にする
    expect(count.rows).toEqual([
      { label: "診療所 件数", note: "65歳以上人口 1,000 人あたり", value: "2.35" },
      { label: "65歳以上人口", note: null, value: "21,234 人" },
    ]);
    const masked = hoverCardText(
      mesh({ population: { indicator: "p65", value: { kind: "masked" } } }),
    );
    expect(masked.rows[1]).toEqual({ label: "65歳以上人口", note: null, value: "秘匿" });
    const sum = hoverCardText(
      mesh({
        indicator: {
          kind: "joined",
          datasetId: "d",
          measure: { kind: "sum", column: "beds" },
          perPopulation: null,
        },
        datasetName: "診療所",
        value: { kind: "number", value: 19 },
      }),
    );
    expect(sum.rows[0]).toEqual({ label: "診療所 beds の合計", note: null, value: "19" });
  });
});

describe("hoverCardText の自前データ", () => {
  it("レイヤーの名前を見出しにし、属性をそのまま並べ、出さなかった数を添える", () => {
    const text = hoverCardText({
      kind: "feature",
      datasetId: "d",
      layerName: "路線",
      attributes: [
        { name: "name", value: "中央新幹線" },
        { name: "length", value: 285.6 },
        { name: "open", value: false },
        { name: "note", value: null },
      ],
      omitted: 2,
    });
    expect(text).toEqual({
      title: "路線",
      titlePrefix: null,
      year: null,
      rows: [
        { label: "name", note: null, value: "中央新幹線" },
        { label: "length", note: null, value: "285.6" },
        { label: "open", note: null, value: "false" },
        { label: "note", note: null, value: "なし" },
      ],
      more: "ほか 2 項目",
    });
  });
});

describe("hoverCardPlacement", () => {
  const size = { width: 1340, height: 806 };

  it("ふだんはポインタの右下に置く", () => {
    expect(hoverCardPlacement({ x: 100, y: 200, ...size })).toEqual({
      left: 100 + HOVER_CARD_OFFSET,
      top: 200 + HOVER_CARD_OFFSET,
      flipX: false,
      flipY: false,
    });
  });

  it("右端と下端からはみ出すときは、ポインタの左と上に置く", () => {
    const x = size.width - HOVER_CARD_MAX_WIDTH;
    const y = size.height - HOVER_CARD_MAX_HEIGHT;
    expect(hoverCardPlacement({ x, y, ...size })).toEqual({
      left: x - HOVER_CARD_OFFSET,
      top: y - HOVER_CARD_OFFSET,
      flipX: true,
      flipY: true,
    });
    // 収まるぎりぎりの位置では裏返さない
    const fits = hoverCardPlacement({
      x: size.width - HOVER_CARD_MAX_WIDTH - HOVER_CARD_OFFSET,
      y: size.height - HOVER_CARD_MAX_HEIGHT - HOVER_CARD_OFFSET,
      ...size,
    });
    expect(fits).toMatchObject({ flipX: false, flipY: false });
  });
});
