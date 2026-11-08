import { describe, expect, it } from "vitest";
import { adminGeomFile, DATA_FILES } from "./schema";
import { DATA_DIR, dataUrl } from "./url";

describe("dataUrl", () => {
  const base = "https://oxon-1011.github.io/RightsizingJPMap/";

  it("アプリの base の下の data/<版>/ を指す", () => {
    expect(DATA_DIR).toBe("data/v1/");
    expect(dataUrl(base, DATA_FILES.meshIndicators)).toBe(
      "https://oxon-1011.github.io/RightsizingJPMap/data/v1/mesh_indicators.parquet",
    );
  });

  it("都道府県ごとの admin_geom のファイルも組み立てられる", () => {
    expect(dataUrl(base, adminGeomFile("31"))).toBe(
      "https://oxon-1011.github.io/RightsizingJPMap/data/v1/admin_geom/31.parquet",
    );
  });

  it("base の末尾に / がなくても同じ URL になる", () => {
    expect(dataUrl("http://localhost:5173/RightsizingJPMap", DATA_FILES.adminTiles)).toBe(
      dataUrl("http://localhost:5173/RightsizingJPMap/", DATA_FILES.adminTiles),
    );
  });
});
