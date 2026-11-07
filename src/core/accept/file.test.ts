import { describe, expect, it } from "vitest";
import { detectFormat, isLargeFile, LARGE_FILE_BYTES } from "./file";

describe("detectFormat", () => {
  it("拡張子から形式を決め、大文字と小文字を区別しない", () => {
    expect(detectFormat("施設.CSV")).toEqual({ ok: true, value: "csv" });
    expect(detectFormat("a.b.parquet")).toEqual({ ok: true, value: "parquet" });
    expect(detectFormat("area.geojson")).toEqual({ ok: true, value: "geojson" });
    expect(detectFormat("area.json")).toEqual({ ok: true, value: "geojson" });
  });

  it("Excel、Shapefile、拡張子なし、Object.prototype の名前は拒否する", () => {
    expect(detectFormat("a.xlsx")).toEqual({
      ok: false,
      error: { stage: "format", extension: "xlsx" },
    });
    expect(detectFormat("a.shp")).toEqual({
      ok: false,
      error: { stage: "format", extension: "shp" },
    });
    expect(detectFormat("README")).toEqual({
      ok: false,
      error: { stage: "format", extension: "" },
    });
    expect(detectFormat("a.constructor")).toEqual({
      ok: false,
      error: { stage: "format", extension: "constructor" },
    });
  });
});

describe("isLargeFile", () => {
  it("目安の大きさを超えたら警告する", () => {
    expect(isLargeFile(LARGE_FILE_BYTES)).toBe(false);
    expect(isLargeFile(LARGE_FILE_BYTES + 1)).toBe(true);
  });
});
