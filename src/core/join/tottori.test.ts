// 鳥取県のテスト用データ（tests/fixtures/）のメッシュと市町村に、自前データを受け入れてから結合するまでを確かめる。
// 小さく組み立てたデータでの集計の確認は join.test.ts に置いている。

import { asyncBufferFromFile } from "hyparquet";
import { describe, expect, it } from "vitest";
import { openParquetBuffer, type ParquetFile, readParquetColumns } from "../../io/parquet";
import { checkTableValues, planTableJoin } from "../accept/table";
import type { Columns } from "../indicators/columns";
import { computeMeshIndicator } from "../indicators/mesh";
import {
  computeMunicipalIndicator,
  paintedMunicipalCodes,
  parseMunicipalTable,
} from "../indicators/municipal";
import { meshCodeToBounds } from "../mesh/mesh-code";
import { aggregateByCode, aggregateByMesh, aggregatePointsByMesh } from "./aggregate";
import {
  completeCodeValues,
  indexMeshes,
  perPopulationByCode,
  perPopulationByMesh,
} from "./per-population";

// fixtures は app と同じ io のアダプタで読む。ファイルのバイト列は hyparquet の Node 版（fs を使う）で得る
const openFixture = async (name: string): Promise<ParquetFile> => {
  const url = new URL(`../../../tests/fixtures/${name}`, import.meta.url);
  const file = await asyncBufferFromFile(decodeURIComponent(url.pathname));
  const opened = await openParquetBuffer(await file.slice(0, file.byteLength));
  if (!opened.ok) {
    throw new Error(`${name} を開けない: ${JSON.stringify(opened.error)}`);
  }
  return opened.value;
};

const readColumns = async (file: ParquetFile, names: readonly string[]): Promise<Columns> => {
  const read = await readParquetColumns(file, names);
  if (!read.ok) {
    throw new Error(`列を読めない: ${JSON.stringify(read.error)}`);
  }
  return Object.fromEntries(read.value.columns);
};

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) {
    throw new Error(`失敗した: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const meshFile = await openFixture("mesh_indicators.tottori.parquet");
const meshCount = meshFile.numRows;
const mesh = await readColumns(meshFile, ["mesh", "2050_pop", "2050_p65", "2050_masked"]);
const { mesh: meshCodesColumn } = mesh;
if (!(meshCodesColumn instanceof Uint32Array)) {
  throw new Error("mesh 列が UINTEGER（Uint32Array）で読めない");
}
const meshCodes: Uint32Array = meshCodesColumn;
const lookup = indexMeshes(meshCodes);
const p65In2050 = unwrap(computeMeshIndicator("p65", 2050, mesh, meshCount));

const municipal = unwrap(
  parseMunicipalTable(
    await readColumns(await openFixture("municipal_indicators.tottori.parquet"), [
      "code",
      "area_type",
      "year",
      "pop",
      "p0_14",
      "p15_64",
      "p65",
      "p75",
    ]),
  ),
);
const paintedCodes = paintedMunicipalCodes(municipal);
const municipalP65In2050 = unwrap(computeMunicipalIndicator(municipal, "p65", 2050));

/** メッシュの中の位置（fy、fx は 0〜1 の割合）を、CSV と同じ十進数の文字列にする */
const pointIn = (code: number, fy: number, fx: number): readonly [string, string] => {
  const { south, west, north, east } = meshCodeToBounds(code);
  return [String(south + (north - south) * fy), String(west + (east - west) * fx)];
};

describe("鳥取県のメッシュへの点の結合", () => {
  // どのメッシュにも、内側の3か所に点を置く
  const offsets = [
    [0.1, 0.1],
    [0.5, 0.5],
    [0.9, 0.8],
  ] as const;
  const points = [...meshCodes].flatMap((code) => offsets.map(([fy, fx]) => pointIn(code, fy, fx)));

  it("CSV の lat と lon の文字列を受け入れ、すべての点を、置いたメッシュに集計する", () => {
    const plan = unwrap(
      planTableJoin([
        { name: "lat", type: "string" },
        { name: "lon", type: "string" },
        { name: "beds", type: "integer" },
      ]),
    );
    const accepted = unwrap(
      checkTableValues(
        "csv",
        plan,
        {
          lat: { type: "string", values: points.map(([lat]) => lat) },
          lon: { type: "string", values: points.map(([, lon]) => lon) },
        },
        paintedCodes,
      ),
    );
    if (accepted.join.kind !== "point") {
      throw new Error("点として受け入れられなかった");
    }
    const beds = Float64Array.from(points, (_, i) => i % 3);
    const aggregate = aggregatePointsByMesh(accepted.join.lat, accepted.join.lon, { beds });
    expect([...aggregate.keys]).toEqual([...meshCodes]);
    expect(aggregate.counts.every((c) => c === 3)).toBe(true);
    expect(new Map(Object.entries(aggregate.sums)).get("beds")?.every((s) => s === 0 + 1 + 2)).toBe(
      true,
    );
  });

  it("65 歳以上人口あたりの件数は、2050 年に秘匿か 65 歳以上が 0 のメッシュで NaN、それ以外で件数 ÷ 人口", () => {
    const aggregate = aggregatePointsByMesh(
      points.map(([lat]) => Number(lat)),
      points.map(([, lon]) => Number(lon)),
      {},
    );
    const values = perPopulationByMesh({
      meshes: aggregate.keys,
      numerators: aggregate.counts,
      lookup,
      baseValues: p65In2050,
      per: 1000,
    });
    const masked = mesh["2050_masked"];
    let finite = 0;
    for (let k = 0; k < aggregate.keys.length; k++) {
      const row = lookup.get(aggregate.keys[k] ?? 0) ?? -1;
      const denominator = p65In2050[row] ?? Number.NaN;
      const v = values[k] ?? Number.NaN;
      if (masked?.[row] === 1 || denominator === 0) {
        expect(v, `${aggregate.keys[k]}`).toBeNaN();
      } else {
        finite++;
        const expected = (3 / denominator) * 1000;
        expect(Math.abs(v - expected) / expected, `${aggregate.keys[k]}`).toBeLessThan(1e-6);
      }
    }
    expect(finite).toBeGreaterThan(0);
    expect(finite).toBeLessThan(meshCount);
  });

  it("mesh 列の表を、メッシュの文字列で受け入れて集計できる", () => {
    const codes = [...meshCodes, ...meshCodes].map(String);
    const accepted = unwrap(
      checkTableValues(
        "csv",
        unwrap(planTableJoin([{ name: "mesh", type: "string" }])),
        { mesh: { type: "string", values: codes } },
        paintedCodes,
      ),
    );
    if (accepted.join.kind !== "mesh") {
      throw new Error("メッシュの表として受け入れられなかった");
    }
    const aggregate = aggregateByMesh(accepted.join.meshes, {});
    expect([...aggregate.keys]).toEqual([...meshCodes]);
    expect(aggregate.counts.every((c) => c === 2)).toBe(true);
  });
});

describe("鳥取県の市町村への結合", () => {
  const codes = [...paintedCodes].sort();

  it("19 市町村の団体コードを受け入れ、県のコード（31000）と先頭の 0 が落ちていない4桁のコードは拒否する", () => {
    const plan = unwrap(planTableJoin([{ name: "code", type: "string" }]));
    const check = (values: readonly string[]) =>
      checkTableValues("csv", plan, { code: { type: "string", values } }, paintedCodes);
    expect(check(codes).ok).toBe(true);
    expect(check([...codes, "31000", "3120"])).toEqual({
      ok: false,
      error: {
        kind: "invalid-values",
        violation: { condition: "code", positions: [19, 20], count: 2 },
      },
    });
  });

  it("市町村ごとの件数を 65 歳以上人口あたりにし、値のない市町村は 0 で埋める", () => {
    // 鳥取市に2件、米子市に1件、どこにも入らなかった点が1件
    const aggregate = aggregateByCode(["31201", "31202", null, "31201"], {});
    expect(aggregate.skipped).toBe(1);
    const perPopulation = perPopulationByCode({
      codes: aggregate.keys,
      numerators: aggregate.counts,
      baseValues: municipalP65In2050,
      per: 1000,
    });
    expect(perPopulation.get("31201")).toBe((2 / (municipalP65In2050.get("31201") ?? 0)) * 1000);
    expect(perPopulation.get("31202")).toBe((1 / (municipalP65In2050.get("31202") ?? 0)) * 1000);

    const counts = completeCodeValues(aggregate.keys, aggregate.counts, paintedCodes, 0);
    expect(counts.size).toBe(19);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });
});
