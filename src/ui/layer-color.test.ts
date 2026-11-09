import { describe, expect, it } from "vitest";
import { LAYER_COLORS } from "../core/storage/manifest";
import { layerColorName } from "./layer-color";

describe("layerColorName", () => {
  it("候補の色にはすべて、16 進数の表記でない名前がある", () => {
    for (const color of LAYER_COLORS) {
      expect(layerColorName(color)).not.toBe(color);
    }
  });

  it("大文字の表記でも同じ名前を返し、候補にない色は表記のまま返す", () => {
    expect(layerColorName("#0072B2")).toBe("青");
    expect(layerColorName("#123456")).toBe("#123456");
  });
});
