import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classificationOf, joinedClassification } from "../core/classify/scales";
import { formatLegendValue, legendRangeTexts, legendTicks } from "./legend-format";

const labelsOf = (ticks: readonly { readonly label: string }[]): readonly string[] =>
  ticks.map((t) => t.label);

describe("legendTicks", () => {
  it("高齢化率は 30〜70 で、最後の目盛りにだけ % を付ける（Figma の凡例と同じ）", () => {
    const ticks = legendTicks(classificationOf("aging_rate", "mesh"), "fraction");
    expect(labelsOf(ticks)).toEqual(["30", "40", "50", "60", "70%"]);
  });

  it("目盛りは色の帯の境目に置く", () => {
    const ticks = legendTicks(classificationOf("aging_rate", "mesh"), "fraction");
    expect(ticks.map((t) => t.position)).toEqual([1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);
  });

  it("人口増減率は負の数にマイナス記号を付け、0 には符号を付けない", () => {
    const ticks = legendTicks(classificationOf("pop_change", "mesh"), "fraction");
    expect(labelsOf(ticks)).toEqual(["−75", "−50", "−35", "−20", "−10", "0%"]);
    expect(ticks.map((t) => t.position)).toEqual([1, 2, 3, 4, 5, 6].map((k) => k / 7));
  });

  it("高齢者増加率は減少と増加の両方を区切りに持つので、正の数に + を付ける", () => {
    const ticks = legendTicks(classificationOf("elderly_change", "municipality"), "fraction");
    expect(labelsOf(ticks)).toEqual(["−50", "−25", "0", "+25", "+50%"]);
  });

  it("メッシュの総人口は桁区切りで書き、単位を付けない", () => {
    const ticks = legendTicks(classificationOf("pop", "mesh"), "persons");
    expect(labelsOf(ticks)).toEqual(["10", "30", "100", "300", "1,000"]);
  });

  it("市区町村の人数は、1万以上の1万の倍数を「万」で書く", () => {
    expect(labelsOf(legendTicks(classificationOf("pop", "municipality"), "persons"))).toEqual([
      "3,000",
      "1万",
      "3万",
      "10万",
      "30万",
    ]);
    expect(labelsOf(legendTicks(classificationOf("p65", "municipality"), "persons"))).toEqual([
      "1,000",
      "3,000",
      "1万",
      "3万",
      "10万",
    ]);
  });

  it("自前データの指標は区切りがなければ目盛りを置かない", () => {
    expect(legendTicks(joinedClassification([0, 0, 0]), "number")).toEqual([]);
  });

  it("小数の区切りが同じ文字列に丸まるときは、有効数字を増やして見分ける", () => {
    const ticks = legendTicks({ breaks: [1.2341, 1.2349], colors: [] }, "number");
    expect(labelsOf(ticks)).toEqual(["1.234", "1.235"]);
  });

  it("小数第3位までの異なる区切りの目盛りは、異なる文字列になる", () => {
    // 分位の区切りは取り込んだ値そのものなので、16 桁めだけが違うような区切りは考えない
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: -1e9, max: 1e9 }), { minLength: 1, maxLength: 7 }),
        (values) => {
          const breaks = values.map((v) => v / 1000).sort((a, b) => a - b);
          const labels = labelsOf(legendTicks({ breaks, colors: [] }, "number"));
          expect(new Set(labels).size).toBe(breaks.length);
        },
      ),
    );
  });
});

describe("formatLegendValue", () => {
  it("比は浮動小数点の誤差を丸めて百分率にする", () => {
    expect(formatLegendValue(0.3, "fraction", false)).toBe("30");
    expect(formatLegendValue(0.07, "fraction", false)).toBe("7");
    expect(formatLegendValue(-0.25, "fraction", true)).toBe("−25");
  });

  it("自前データの小数は有効数字3桁で書く", () => {
    expect(formatLegendValue(0.83333, "number", false)).toBe("0.833");
    expect(formatLegendValue(12.5, "number", false)).toBe("12.5");
  });
});

describe("legendRangeTexts", () => {
  it("高齢化率の範囲を、未満、〜、以上で書く", () => {
    expect(legendRangeTexts(classificationOf("aging_rate", "mesh"), "fraction")).toEqual([
      "30% 未満",
      "30〜40%",
      "40〜50%",
      "50〜60%",
      "60〜70%",
      "70% 以上",
    ]);
  });

  it("人数には「人」を付ける", () => {
    const texts = legendRangeTexts(classificationOf("pop", "mesh"), "persons");
    expect(texts[0]).toBe("10 人未満");
    expect(texts[1]).toBe("10〜30 人");
    expect(texts[5]).toBe("1,000 人以上");
  });

  it("人口増減率の最後の階級は「0% 以上」（増加）", () => {
    const texts = legendRangeTexts(classificationOf("pop_change", "mesh"), "fraction");
    expect(texts).toHaveLength(7);
    expect(texts[0]).toBe("−75% 未満");
    expect(texts[5]).toBe("−10〜0%");
    expect(texts[6]).toBe("0% 以上");
  });

  it("区切りがなければ、1つの階級を「すべての値」とする", () => {
    expect(legendRangeTexts(joinedClassification([0, 0]), "number")).toEqual(["すべての値"]);
  });
});
