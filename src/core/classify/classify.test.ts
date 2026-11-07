import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INDICATOR_IDS } from "../indicators/definitions";
import { classIndex, isWellFormed, legendEntries, NO_CLASS } from "./classify";
import { hex, parseHexColor, toHex } from "./color";
import { CLASSIFICATIONS, classificationOf, joinedClassification, quantileBreaks } from "./scales";

describe("classIndex", () => {
  const breaks = [0.3, 0.4, 0.5, 0.6, 0.7];

  it("高齢化率は 30、40、50、60、70% で6階級に分かれ、区切りの値は上の階級に入る", () => {
    expect(classIndex(0.29, breaks)).toBe(0);
    expect(classIndex(0.3, breaks)).toBe(1);
    expect(classIndex(0.45, breaks)).toBe(2);
    expect(classIndex(0.69, breaks)).toBe(4);
    expect(classIndex(0.7, breaks)).toBe(5);
    expect(classIndex(1.5, breaks)).toBe(5);
  });

  it("NaN は値なし", () => {
    expect(classIndex(Number.NaN, breaks)).toBe(NO_CLASS);
  });

  it("値について単調で、階級の番号は色の範囲に収まる", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...INDICATOR_IDS),
        fc.constantFrom("mesh" as const, "municipality" as const),
        fc.double({ noNaN: true }),
        fc.double({ noNaN: true }),
        (id, unit, a, b) => {
          const { breaks, colors } = classificationOf(id, unit);
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const kLo = classIndex(lo, breaks);
          const kHi = classIndex(hi, breaks);
          expect(kLo).toBeLessThanOrEqual(kHi);
          expect(kLo).toBeGreaterThanOrEqual(0);
          expect(kHi).toBeLessThan(colors.length);
        },
      ),
    );
  });
});

describe("CLASSIFICATIONS", () => {
  it("どの指標と単位も、区切りが昇順で、色が区切りより1つ多い", () => {
    for (const id of INDICATOR_IDS) {
      expect(isWellFormed(CLASSIFICATIONS[id].mesh)).toBe(true);
      expect(isWellFormed(CLASSIFICATIONS[id].municipality)).toBe(true);
    }
  });

  it("高齢化率だけが確定で、DADS の Orange を低い順に使う", () => {
    const aging = classificationOf("aging_rate", "mesh");
    expect(aging.tentative).toBe(false);
    expect(aging.colors.map(toHex)).toEqual([
      "#ffdfca",
      "#ffa66d",
      "#ff7628",
      "#e25100",
      "#ac3e00",
      "#6d2700",
    ]);
    const others = INDICATOR_IDS.filter((id) => id !== "aging_rate");
    expect(others.every((id) => classificationOf(id, "mesh").tentative)).toBe(true);
  });

  it("増減率は 0 を区切りに持つ2方向", () => {
    expect(classificationOf("pop_change", "mesh").breaks).toContain(0);
    expect(classificationOf("elderly_change", "municipality").breaks).toContain(0);
  });
});

describe("legendEntries", () => {
  it("両端の段は開いている", () => {
    const entries = legendEntries(classificationOf("aging_rate", "mesh"));
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ from: null, to: 0.3 });
    expect(entries[1]).toMatchObject({ from: 0.3, to: 0.4 });
    expect(entries[5]).toMatchObject({ from: 0.7, to: null });
  });
});

describe("quantileBreaks", () => {
  it("NaN を除き、重なった区切りをまとめる", () => {
    expect(quantileBreaks([1, 2, 3, 4, Number.NaN], 2)).toEqual([3]);
    expect(quantileBreaks([5, 5, 5, 5], 4)).toEqual([5]);
    expect(quantileBreaks([], 4)).toEqual([]);
  });

  it("作った階級区分は、いつも形が正しい", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ noNaN: true, noDefaultInfinity: true })), (values) => {
        expect(isWellFormed(joinedClassification(values))).toBe(true);
      }),
    );
  });
});

describe("color", () => {
  it("16進の色と Rgba を往復できる", () => {
    expect(hex("#FF7628")).toEqual([255, 118, 40, 255]);
    expect(toHex(hex("#6d2700"))).toBe("#6d2700");
    expect(parseHexColor("ff7628")).toBeNull();
    expect(parseHexColor("#ff762")).toBeNull();
  });
});
