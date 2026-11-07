// 鳥取県のテスト用データ（tests/fixtures/、トラック A が生成物から書き出したもの）で、指標の計算を確かめる。
// 小さく組み立てたデータでの境界の確認は mesh.test.ts と municipal.test.ts に置いている。

import { asyncBufferFromFile } from "hyparquet";
import { describe, expect, it } from "vitest";
import { openParquetBuffer, type ParquetFile, readParquetColumns } from "../../io/parquet";
import { MESH_AGE_YEARS, MESH_YEARS, MUNICIPAL_YEARS } from "../data/schema";
import { type Columns, isNumericColumn } from "./columns";
import {
  availableYears,
  INDICATOR_IDS,
  type IndicatorId,
  meshColumnsToRead,
  POPULATION_INDICATOR_IDS,
  usesAgeGroups,
} from "./definitions";
import { computeMeshIndicator } from "./mesh";
import { computeMunicipalIndicator, paintedMunicipalCodes, parseMunicipalTable } from "./municipal";

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

const numbers = (columns: Columns, name: string): ArrayLike<number> => {
  const column = columns[name];
  if (column === undefined || !isNumericColumn(column)) {
    throw new Error(`${name} は数値の列ではない`);
  }
  return column;
};

const strings = (columns: Columns, name: string): readonly string[] => {
  const column = columns[name];
  if (column === undefined || isNumericColumn(column)) {
    throw new Error(`${name} は文字列の列ではない`);
  }
  return column;
};

const meshFile = await openFixture("mesh_indicators.tottori.parquet");
const meshCount = meshFile.numRows;
const mesh = await readColumns(
  meshFile,
  meshFile.columns.map((c) => c.name),
);
const municipalColumns = await readColumns(
  await openFixture("municipal_indicators.tottori.parquet"),
  ["code", "name", "pref_name", "area_type", "year", "pop", "p0_14", "p15_64", "p65", "p75"],
);
const municipal = unwrap(parseMunicipalTable(municipalColumns));

const meshValues = (id: IndicatorId, year: number): Float32Array =>
  unwrap(computeMeshIndicator(id, year, mesh, meshCount));

/** その年に秘匿のメッシュの番号の集合 */
const maskedAt = (year: number): ReadonlySet<number> => {
  const masked = numbers(mesh, `${year}_masked`);
  const out = new Set<number>();
  for (let i = 0; i < meshCount; i++) {
    if (masked[i] !== 0) {
      out.add(i);
    }
  }
  return out;
};

const AGE_INDICATORS = INDICATOR_IDS.filter(usesAgeGroups);

describe("鳥取県のメッシュ", () => {
  it("meshColumnsToRead の列だけを読めば、どの指標とどの選べる年も計算できる", async () => {
    for (const id of INDICATOR_IDS) {
      for (const year of availableYears("mesh", id)) {
        const columns = await readColumns(meshFile, meshColumnsToRead(id, year));
        const values = computeMeshIndicator(id, year, columns, meshCount);
        expect(values.ok, `${id} ${year}`).toBe(true);
      }
    }
  });

  it("年齢別の値と秘匿の列は 2020 年にない", () => {
    expect(meshColumnsToRead("p65", 2020)).toEqual([]);
    expect(Object.keys(mesh).filter((name) => name.startsWith("2020_"))).toEqual(["2020_pop"]);
  });

  it("その年に秘匿のメッシュは、合算先も含めて、年齢別の指標がすべて NaN になる（D7）", () => {
    for (const year of MESH_AGE_YEARS) {
      const masked = maskedAt(year);
      const baseMasked = maskedAt(2025);
      // 秘匿対象（年齢別が 0）と合算先（年齢別に値がある）の両方がデータに含まれることを確かめておく
      const p65 = numbers(mesh, `${year}_p65`);
      const p15_64 = numbers(mesh, `${year}_p15_64`);
      const withAges = [...masked].filter((i) => (p65[i] ?? 0) + (p15_64[i] ?? 0) > 0);
      expect(withAges.length, `${year} の合算先`).toBeGreaterThan(0);
      expect(masked.size - withAges.length, `${year} の秘匿対象`).toBeGreaterThan(0);

      for (const id of AGE_INDICATORS) {
        const values = meshValues(id, year);
        for (const i of masked) {
          expect(values[i], `${id} ${year} の ${i} 行め`).toBeNaN();
        }
        if (id === "elderly_change") {
          for (const i of baseMasked) {
            expect(values[i], `${id} ${year} の ${i} 行め（2025 年が秘匿）`).toBeNaN();
          }
        }
      }
    }
  });

  it("合算先には 65 歳以上人口が総人口を超えるメッシュがあり、その高齢化率も NaN にしている", () => {
    // 合算先の年齢別の値には、隣の秘匿対象のメッシュの人口が足し込まれている（docs/design/base-data.md）
    for (const year of MESH_AGE_YEARS) {
      const pop = numbers(mesh, `${year}_pop`);
      const p65 = numbers(mesh, `${year}_p65`);
      const over = [...maskedAt(year)].filter((i) => (p65[i] ?? 0) > (pop[i] ?? 0));
      expect(over.length, String(year)).toBeGreaterThan(0);
      const values = meshValues("aging_rate", year);
      expect(
        over.every((i) => Number.isNaN(values[i])),
        String(year),
      ).toBe(true);
    }
  });

  it("総人口はどの年も、秘匿のメッシュを含む全メッシュに値がある（D7）", () => {
    for (const year of MESH_YEARS) {
      const values = meshValues("pop", year);
      expect(values.some(Number.isNaN), String(year)).toBe(false);
    }
  });

  it("人口増減率が NaN になるのは、2025 年の総人口が 0 のメッシュだけ", () => {
    const base = numbers(mesh, "2025_pop");
    const zeros = Array.from({ length: meshCount }, (_, i) => i).filter((i) => base[i] === 0);
    expect(zeros.length).toBeGreaterThan(0);
    for (const year of MESH_YEARS) {
      const values = meshValues("pop_change", year);
      const nan = Array.from({ length: meshCount }, (_, i) => i).filter((i) =>
        Number.isNaN(values[i]),
      );
      expect(nan, String(year)).toEqual(zeros);
    }
  });

  it("秘匿でないメッシュでは、年齢別の3区分の和が総人口と一致し、75歳以上は65歳以上を超えない", () => {
    // 値は 32 ビットの浮動小数点数なので、丸めの分（0.01 人）だけ許す
    for (const year of MESH_AGE_YEARS) {
      const pop = meshValues("pop", year);
      const young = meshValues("p0_14", year);
      const working = meshValues("p15_64", year);
      const elderly = meshValues("p65", year);
      const oldOld = meshValues("p75", year);
      const masked = maskedAt(year);
      for (let i = 0; i < meshCount; i++) {
        if (masked.has(i)) {
          continue;
        }
        const sum = (young[i] ?? 0) + (working[i] ?? 0) + (elderly[i] ?? 0);
        expect(Math.abs(sum - (pop[i] ?? 0)), `${year} の ${i} 行め`).toBeLessThan(0.01);
        expect(oldOld[i] ?? 0, `${year} の ${i} 行め`).toBeLessThanOrEqual(
          (elderly[i] ?? 0) + 0.01,
        );
      }
    }
  });

  it("高齢化率の値は 0 以上 1 以下で、NaN は秘匿か総人口 0 のメッシュだけ", () => {
    for (const year of MESH_AGE_YEARS) {
      const values = meshValues("aging_rate", year);
      const pop = numbers(mesh, `${year}_pop`);
      const masked = maskedAt(year);
      for (let i = 0; i < meshCount; i++) {
        const v = values[i] ?? Number.NaN;
        if (Number.isNaN(v)) {
          expect(masked.has(i) || pop[i] === 0, `${year} の ${i} 行め`).toBe(true);
        } else {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("メッシュの総人口の合計は、県境のメッシュを含む分だけ、市町村の合計よりわずかに多い（1% 以内）", () => {
    for (const year of MUNICIPAL_YEARS) {
      const meshTotal = meshValues("pop", year).reduce((a, b) => a + b, 0);
      const municipalTotal = [
        ...unwrap(computeMunicipalIndicator(municipal, "pop", year)).values(),
      ].reduce((a, b) => a + b, 0);
      expect(meshTotal, String(year)).toBeGreaterThanOrEqual(municipalTotal);
      expect(meshTotal / municipalTotal - 1, String(year)).toBeLessThan(0.01);
    }
  });
});

describe("鳥取県の市町村", () => {
  const codes = strings(municipalColumns, "code");
  const areaTypes = strings(municipalColumns, "area_type");
  const years = numbers(municipalColumns, "year");

  /** 都道府県の行（31000）の、ある年のある列の値 */
  const prefectureValue = (column: string, year: number): number => {
    const values = numbers(municipalColumns, column);
    const i = codes.findIndex((code, k) => code === "31000" && years[k] === year);
    return values[i] ?? Number.NaN;
  };

  it("地図で塗る単位は県内の 19 市町村で、県の行（31000）を含まない", () => {
    const painted = paintedMunicipalCodes(municipal);
    expect(painted.size).toBe(19);
    expect(painted.has("31000")).toBe(false);
    expect([...painted].every((code) => /^31\d{3}$/.test(code))).toBe(true);
  });

  it("どの指標もどの年も、19 市町村すべてに値がある（分母が 0 の市町村はない）", () => {
    for (const id of INDICATOR_IDS) {
      for (const year of MUNICIPAL_YEARS) {
        const values = unwrap(computeMunicipalIndicator(municipal, id, year));
        expect(values.size, `${id} ${year}`).toBe(19);
        expect([...values.values()].some(Number.isNaN), `${id} ${year}`).toBe(false);
      }
    }
  });

  it("人数の指標は団体コードで引け、その団体コードと年の行の値と一致する", () => {
    for (const id of POPULATION_INDICATOR_IDS) {
      const column = numbers(municipalColumns, id);
      for (const year of MUNICIPAL_YEARS) {
        const values = unwrap(computeMunicipalIndicator(municipal, id, year));
        for (let i = 0; i < codes.length; i++) {
          if (years[i] === year && areaTypes[i] !== "a") {
            expect(values.get(codes[i] ?? ""), `${id} ${year} ${codes[i]}`).toBe(column[i]);
          }
        }
      }
    }
  });

  it("人数の指標の 19 市町村の合計は、県の行の値と一致する", () => {
    for (const id of POPULATION_INDICATOR_IDS) {
      for (const year of MUNICIPAL_YEARS) {
        const values = unwrap(computeMunicipalIndicator(municipal, id, year));
        const total = [...values.values()].reduce((a, b) => a + b, 0);
        expect(total, `${id} ${year}`).toBe(prefectureValue(id, year));
      }
    }
  });

  it("鳥取市の 2050 年の高齢化率と高齢者増加率", () => {
    const pop2050 = unwrap(computeMunicipalIndicator(municipal, "pop", 2050)).get("31201") ?? 0;
    const p65_2050 = unwrap(computeMunicipalIndicator(municipal, "p65", 2050)).get("31201") ?? 0;
    const p65_2025 = unwrap(computeMunicipalIndicator(municipal, "p65", 2025)).get("31201") ?? 0;
    expect(unwrap(computeMunicipalIndicator(municipal, "aging_rate", 2050)).get("31201")).toBe(
      p65_2050 / pop2050,
    );
    expect(unwrap(computeMunicipalIndicator(municipal, "elderly_change", 2050)).get("31201")).toBe(
      p65_2050 / p65_2025 - 1,
    );
    // 2025 年の値そのものとの比なので、2025 年の増減率は 0
    const base = unwrap(computeMunicipalIndicator(municipal, "pop_change", 2025));
    expect([...base.values()].every((v) => v === 0)).toBe(true);
  });
});
