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

  it("高齢化率は DADS の Orange を低い順に使う", () => {
    const aging = classificationOf("aging_rate", "mesh");
    expect(aging.colors.map(toHex)).toEqual([
      "#ffdfca",
      "#ffa66d",
      "#ff7628",
      "#e25100",
      "#ac3e00",
      "#6d2700",
    ]);
  });

  it("人口増減率は減少を Red の濃い順に塗り、増加の階級だけを Blue にする", () => {
    const change = classificationOf("pop_change", "mesh");
    expect(change.breaks).toEqual([-0.5, -0.4, -0.3, -0.2, -0.1, 0]);
    expect(change.colors.map(toHex)).toEqual([
      "#850000",
      "#ce0000",
      "#fa0000",
      "#ff5454",
      "#ff9696",
      "#ffdada",
      "#4979f5",
    ]);
    expect(classIndex(-0.05, change.breaks)).toBe(5);
    expect(classIndex(0, change.breaks)).toBe(6);
  });

  it("高齢者増加率は 0 を境に、減少を Blue、増加を Orange にする", () => {
    const change = classificationOf("elderly_change", "municipality");
    expect(change.breaks).toEqual([-0.5, -0.25, 0, 0.25, 0.5]);
    expect(change.colors.map(toHex).slice(2, 4)).toEqual(["#9db7f9", "#ffa66d"]);
  });

  it("比率と増減率は、メッシュと市区町村で同じ区切り", () => {
    for (const id of ["aging_rate", "pop_change", "elderly_change"] as const) {
      expect(classificationOf(id, "mesh")).toEqual(classificationOf(id, "municipality"));
    }
  });

  it("年齢別の4指標は同じ区切りで、人数は単位ごとに桁の違う区切りを持つ", () => {
    for (const unit of ["mesh", "municipality"] as const) {
      const ages = (["p0_14", "p15_64", "p65", "p75"] as const).map(
        (id) => classificationOf(id, unit).breaks,
      );
      expect(new Set(ages.map((b) => b.join())).size).toBe(1);
    }
    expect(classificationOf("pop", "mesh").breaks).toEqual([10, 30, 100, 300, 1000]);
    expect(classificationOf("pop", "municipality").breaks).toEqual([
      3000, 10000, 30000, 100000, 300000,
    ]);
  });
});

describe("joinedClassification", () => {
  it("0 を含む 0 以上の値では、0 だけの階級を最初に置く", () => {
    const counts = [0, 0, 0, 1, 1, 2, 3, 5, 8, 13, 21, 34];
    const { breaks, colors } = joinedClassification(counts);
    expect(breaks[0]).toBe(1);
    expect(colors).toHaveLength(breaks.length + 1);
    expect(classIndex(0, breaks)).toBe(0);
    expect(counts.filter((v) => v > 0).every((v) => classIndex(v, breaks) >= 1)).toBe(true);
  });

  it("負の値を含むときは、0 を別の階級にせず分位だけで分ける", () => {
    expect(joinedClassification([-3, -1, 0, 2, 4, 6]).breaks).toEqual(
      quantileBreaks([-3, -1, 0, 2, 4, 6], 6),
    );
  });

  it("値がすべて 0 なら、1つの階級になる", () => {
    expect(joinedClassification([0, 0, Number.NaN])).toMatchObject({ breaks: [] });
  });

  it("0 を含む 0 以上の値では、0 と正の値が同じ階級に入らない", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(1000)), (rest) => {
        const values = [0, ...rest];
        const { breaks } = joinedClassification(values);
        for (const v of values) {
          expect(classIndex(v, breaks) === 0).toBe(v === 0);
        }
      }),
    );
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
