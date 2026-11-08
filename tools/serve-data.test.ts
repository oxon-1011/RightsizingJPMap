import { describe, expect, it } from "vitest";
import { toPipelineOutUrl } from "./serve-data";

describe("toPipelineOutUrl", () => {
  const base = "/RightsizingJPMap/";

  it("生成物の URL を pipeline/out/ の下に書き換える", () => {
    expect(toPipelineOutUrl("/RightsizingJPMap/data/v1/mesh_indicators.parquet", base)).toBe(
      "/RightsizingJPMap/pipeline/out/mesh_indicators.parquet",
    );
    expect(toPipelineOutUrl("/RightsizingJPMap/data/v1/admin_geom/31.parquet", base)).toBe(
      "/RightsizingJPMap/pipeline/out/admin_geom/31.parquet",
    );
  });

  it("生成物でない URL と、版の違う URL は書き換えない", () => {
    expect(toPipelineOutUrl("/RightsizingJPMap/src/main.tsx", base)).toBeNull();
    expect(toPipelineOutUrl("/RightsizingJPMap/data/v0/mesh_indicators.parquet", base)).toBeNull();
    expect(toPipelineOutUrl("/data/v1/mesh_indicators.parquet", base)).toBeNull();
  });
});
