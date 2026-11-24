import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatPositionHash, type MapPosition, parsePositionHash } from "./hash";

const RANGE = { minZoom: 4, maxZoom: 16 };

const MATSUMOTO: MapPosition = { zoom: 11.5, lat: 36.2381, lon: 137.972, bearing: 0 };

describe("parsePositionHash", () => {
  it("ズーム、緯度、経度を読み、向きがなければ北を上にする", () => {
    expect(parsePositionHash("#map=11.5/36.2381/137.972", "map", RANGE)).toEqual(MATSUMOTO);
  });

  it("4つめの数を向きとして読む", () => {
    expect(parsePositionHash("#map=11.5/36.2381/137.972/-30.5", "map", RANGE)).toEqual({
      ...MATSUMOTO,
      bearing: -30.5,
    });
  });

  it("ほかの名前の値があっても、名前の値だけを読む", () => {
    expect(parsePositionHash("#year=2050&map=11.5/36.2381/137.972&x=1", "map", RANGE)).toEqual(
      MATSUMOTO,
    );
    expect(parsePositionHash("#mapx=11.5/36.2381/137.972", "map", RANGE)).toBeNull();
  });

  it("名前の値がない、数の個数が違う、数でないものがある URL は読まない", () => {
    for (const hash of [
      "",
      "#",
      "#sources",
      "#11.5/36.2381/137.972",
      "#map=",
      "#map=11.5/36.2381",
      "#map=11.5/36.2381/137.972/0/60",
      "#map=11.5/36.2381/abc",
      "#map=11.5/36.2381/",
      "#map=1e1/36.2381/137.972",
      "#map=11.5/ 36.2381/137.972",
      "#map=11.5/NaN/137.972",
      "#map=11.5/Infinity/137.972",
    ]) {
      expect(parsePositionHash(hash, "map", RANGE), hash).toBeNull();
    }
  });

  it("範囲の外の値は、範囲の中に寄せずに、読まない", () => {
    for (const hash of [
      "#map=3.9/36/138",
      "#map=16.1/36/138",
      "#map=10/90.1/138",
      "#map=10/-91/138",
      "#map=10/36/180.5",
      "#map=10/36/-181",
      "#map=10/36/138/180.1",
      "#map=10/36/138/-200",
    ]) {
      expect(parsePositionHash(hash, "map", RANGE), hash).toBeNull();
    }
    expect(parsePositionHash("#map=4/-90/-180/180", "map", RANGE)).toEqual({
      zoom: 4,
      lat: -90,
      lon: -180,
      bearing: 180,
    });
  });
});

describe("formatPositionHash", () => {
  it("北が上なら、ズーム、緯度、経度だけを書く", () => {
    expect(formatPositionHash("", "map", MATSUMOTO)).toBe("#map=11.5/36.2381/137.972");
  });

  it("北が上でなければ、向きを小数1桁で続ける", () => {
    expect(formatPositionHash("", "map", { ...MATSUMOTO, bearing: -30.46 })).toBe(
      "#map=11.5/36.2381/137.972/-30.5",
    );
    // 丸めて 0 になる向きは書かない
    expect(formatPositionHash("", "map", { ...MATSUMOTO, bearing: -0.04 })).toBe(
      "#map=11.5/36.2381/137.972",
    );
  });

  it("ズームは小数2桁に、緯度と経度はズームに応じた桁数に丸める", () => {
    const position = { zoom: 4.123456, lat: 36.123456789, lon: 138.123456789, bearing: 0 };
    expect(formatPositionHash("", "map", position)).toBe("#map=4.12/36.12/138.12");
    expect(formatPositionHash("", "map", { ...position, zoom: 16 })).toBe(
      "#map=16/36.123457/138.123457",
    );
  });

  it("名前の値を置き換え、ほかの名前の値と並びは変えない", () => {
    expect(formatPositionHash("#year=2050&map=4/0/0&x=1", "map", MATSUMOTO)).toBe(
      "#year=2050&map=11.5/36.2381/137.972&x=1",
    );
    expect(formatPositionHash("#year=2050", "map", MATSUMOTO)).toBe(
      "#year=2050&map=11.5/36.2381/137.972",
    );
  });

  it("書いたものを読むと、丸めの幅の中で元の位置に戻る", () => {
    fc.assert(
      fc.property(
        fc.record({
          zoom: fc.double({ min: 4, max: 16, noNaN: true }),
          lat: fc.double({ min: -85, max: 85, noNaN: true }),
          lon: fc.double({ min: -180, max: 180, noNaN: true }),
          bearing: fc.double({ min: -180, max: 180, noNaN: true }),
        }),
        (position) => {
          const parsed = parsePositionHash(formatPositionHash("", "map", position), "map", RANGE);
          expect(parsed).not.toBeNull();
          // 丸めの幅の半分。緯度と経度は、桁数が最も少ない z4（小数2桁）の幅で確かめる
          const EPSILON = 1e-9;
          expect(Math.abs((parsed?.zoom ?? 0) - position.zoom)).toBeLessThanOrEqual(
            0.005 + EPSILON,
          );
          expect(Math.abs((parsed?.lat ?? 0) - position.lat)).toBeLessThanOrEqual(0.005 + EPSILON);
          expect(Math.abs((parsed?.lon ?? 0) - position.lon)).toBeLessThanOrEqual(0.005 + EPSILON);
          expect(Math.abs((parsed?.bearing ?? 0) - position.bearing)).toBeLessThanOrEqual(
            0.05 + EPSILON,
          );
        },
      ),
    );
  });
});
