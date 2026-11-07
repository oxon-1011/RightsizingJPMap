import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ColumnSchema,
  type ColumnValues,
  checkTableValues,
  isMeshCode,
  numericAttributes,
  planTableJoin,
  type TableJoinPlan,
} from "./table";
import { displayPosition, MAX_REPORTED_POSITIONS } from "./violation";

const str = (name: string): ColumnSchema => ({ name, type: "string" });
const int = (name: string): ColumnSchema => ({ name, type: "integer" });
const flt = (name: string): ColumnSchema => ({ name, type: "float" });

const strings = (...values: (string | null)[]): ColumnValues => ({ type: "string", values });
const integers = (...values: number[]): ColumnValues => ({
  type: "integer",
  values: Float64Array.from(values),
});

const VALID_CODES: ReadonlySet<string> = new Set(["01101", "13101", "22138", "31201", "07999"]);

const plan = (columns: readonly ColumnSchema[]): TableJoinPlan => {
  const result = planTableJoin(columns);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
};

describe("planTableJoin", () => {
  it("結合用の列の組が1つなら、その組と属性の列を返す", () => {
    expect(planTableJoin([str("name"), str("code"), int("beds")])).toEqual({
      ok: true,
      value: {
        kind: "code",
        joinColumns: [str("code")],
        attributes: [str("name"), int("beds")],
      },
    });
  });

  it("lat と lon は列の並びによらず lat、lon の順にする", () => {
    expect(plan([flt("lon"), str("name"), flt("lat")]).joinColumns).toEqual([
      flt("lat"),
      flt("lon"),
    ]);
  });

  it("結合用の列の組が0個か2個以上なら拒否する", () => {
    expect(planTableJoin([str("name")])).toEqual({ ok: false, error: { kind: "no-join-columns" } });
    expect(planTableJoin([str("code"), str("mesh")])).toEqual({
      ok: false,
      error: { kind: "multiple-join-columns", found: ["code", "mesh"] },
    });
    expect(planTableJoin([str("mesh"), str("lat"), str("lon")])).toEqual({
      ok: false,
      error: { kind: "multiple-join-columns", found: ["mesh", "point"] },
    });
  });

  it("lat と lon の片方だけなら拒否する", () => {
    expect(planTableJoin([str("code"), str("lat")])).toEqual({
      ok: false,
      error: { kind: "incomplete-lat-lon", present: "lat" },
    });
  });

  it("列名は大文字と小文字を区別する", () => {
    expect(planTableJoin([str("Code")])).toEqual({ ok: false, error: { kind: "no-join-columns" } });
  });

  it("整数型の code 列は拒否する", () => {
    expect(planTableJoin([int("code")])).toEqual({
      ok: false,
      error: { kind: "code-not-string", type: "integer" },
    });
  });

  it("mesh 列は整数型か文字列型だけ、lat と lon は文字列か数", () => {
    expect(planTableJoin([int("mesh")]).ok).toBe(true);
    expect(planTableJoin([flt("mesh")])).toEqual({
      ok: false,
      error: { kind: "unsupported-join-column-type", column: "mesh", type: "float" },
    });
    expect(planTableJoin([{ name: "lat", type: "other" }, flt("lon")])).toEqual({
      ok: false,
      error: { kind: "unsupported-join-column-type", column: "lat", type: "other" },
    });
  });

  it("同じ名前の列が2つあれば拒否する", () => {
    expect(planTableJoin([str("code"), str("code")])).toEqual({
      ok: false,
      error: { kind: "duplicate-column-names", names: ["code"] },
    });
  });
});

describe("checkTableValues（code）", () => {
  const codePlan = plan([str("code"), int("beds")]);

  it("地図で塗る単位の5桁の団体コードだけを受け付ける", () => {
    const result = checkTableValues(
      "csv",
      codePlan,
      { code: strings("01101", "31201") },
      VALID_CODES,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        format: "csv",
        rowCount: 2,
        join: { kind: "code", codes: ["01101", "31201"] },
        attributes: [int("beds")],
      },
    });
  });

  it("先頭の 0 が落ちたコード、政令指定都市のコード、6桁のコード、空の値を補わずに拒否する", () => {
    const result = checkTableValues(
      "csv",
      codePlan,
      { code: strings("1101", "01100", "131016", null, "13101") },
      VALID_CODES,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-values",
        violation: { condition: "code", positions: [0, 1, 2, 3], count: 4 },
      },
    });
  });

  it("行が1つもなければ拒否する", () => {
    expect(checkTableValues("parquet", codePlan, { code: strings() }, VALID_CODES)).toEqual({
      ok: false,
      error: { kind: "no-rows" },
    });
  });
});

describe("checkTableValues（mesh）", () => {
  it("8桁の文字列も整数も受け付ける", () => {
    const fromString = checkTableValues(
      "csv",
      plan([str("mesh")]),
      { mesh: strings("53394611") },
      VALID_CODES,
    );
    const fromInteger = checkTableValues(
      "parquet",
      plan([int("mesh")]),
      { mesh: integers(64414288) },
      VALID_CODES,
    );
    expect(fromString).toMatchObject({ ok: true, value: { join: { kind: "mesh" } } });
    expect(fromInteger).toMatchObject({ ok: true, value: { join: { kind: "mesh" } } });
    if (fromString.ok && fromString.value.join.kind === "mesh") {
      expect([...fromString.value.join.meshes]).toEqual([53394611]);
    }
  });

  it("8桁でない値、2次メッシュの番号が 8 以上の値を拒否する", () => {
    const result = checkTableValues(
      "csv",
      plan([str("mesh")]),
      { mesh: strings("5339461", "533946111", "53398611", "53394811", "5339461a", " 53394611") },
      VALID_CODES,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-values",
        violation: { condition: "mesh", positions: [0, 1, 2, 3, 4], count: 6 },
      },
    });
  });

  it("isMeshCode は 5桁めと6桁めが 0〜7 の8桁の整数だけを認める", () => {
    expect(isMeshCode(53394611)).toBe(true);
    expect(isMeshCode(53398611)).toBe(false);
    expect(isMeshCode(53394811)).toBe(false);
    expect(isMeshCode(5339461.5)).toBe(false);
    expect(isMeshCode(Number.NaN)).toBe(false);
  });
});

describe("checkTableValues（lat と lon）", () => {
  it("CSV の十進数の文字列を読み、範囲の両端を含む", () => {
    const result = checkTableValues(
      "csv",
      plan([str("lat"), str("lon")]),
      { lat: strings("35.681236", "20", "46.0"), lon: strings("139.767125", "122", "154") },
      VALID_CODES,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.join.kind === "point") {
      expect([...result.value.join.lat]).toEqual([35.681236, 20, 46]);
      expect([...result.value.join.lon]).toEqual([139.767125, 122, 154]);
    }
  });

  it("入れ違い、指数の表記、空白、空の値、範囲の外を拒否する", () => {
    const result = checkTableValues(
      "csv",
      plan([str("lat"), str("lon")]),
      {
        lat: strings("139.76", "3.5e1", " 35.6", null, "19.9", "35.6"),
        lon: strings("35.68", "139.7", "139.7", "139.7", "139.7", "154.01"),
      },
      VALID_CODES,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-values",
        violation: { condition: "lat-lon", positions: [0, 1, 2, 3, 4], count: 6 },
      },
    });
  });

  it("Parquet の数の列は、NULL（NaN）と範囲の外を拒否する", () => {
    const result = checkTableValues(
      "parquet",
      plan([flt("lat"), flt("lon")]),
      {
        lat: { type: "float", values: Float64Array.from([35.6, Number.NaN]) },
        lon: { type: "float", values: Float64Array.from([139.7, 139.7]) },
      },
      VALID_CODES,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { violation: { positions: [1], count: 1 } },
    });
  });
});

describe("違反の報告の性質", () => {
  it("条件を満たさない行はすべて数えられ、先頭から5件が報告される", () => {
    const validCode = fc.constantFrom(...VALID_CODES);
    const invalidCode = fc.oneof(
      fc.constant(null),
      fc.string(),
      fc.integer({ min: 0, max: 9999 }).map(String),
      fc.constantFrom("01100", "13100", "99999"),
    );
    const row = fc.oneof(
      validCode.map((code) => ({ code, valid: true })),
      invalidCode
        .filter((code) => code === null || !VALID_CODES.has(code))
        .map((code) => ({ code, valid: false })),
    );
    fc.assert(
      fc.property(fc.array(row, { minLength: 1, maxLength: 50 }), (rows) => {
        const result = checkTableValues(
          "csv",
          plan([str("code")]),
          { code: strings(...rows.map((r) => r.code)) },
          VALID_CODES,
        );
        const invalid = rows.flatMap((r, i) => (r.valid ? [] : [i]));
        if (invalid.length === 0) {
          expect(result.ok).toBe(true);
        } else {
          expect(result).toEqual({
            ok: false,
            error: {
              kind: "invalid-values",
              violation: {
                condition: "code",
                positions: invalid.slice(0, MAX_REPORTED_POSITIONS),
                count: invalid.length,
              },
            },
          });
        }
      }),
    );
  });
});

describe("displayPosition", () => {
  it("CSV は列名の行を1行目に数え、Parquet と GeoJSON は1から数える", () => {
    expect(displayPosition("csv", 0)).toBe(2);
    expect(displayPosition("parquet", 0)).toBe(1);
    expect(displayPosition("geojson", 4)).toBe(5);
  });
});

describe("numericAttributes", () => {
  it("整数と浮動小数点数の列だけを返す", () => {
    expect(numericAttributes([str("name"), int("beds"), flt("area")])).toEqual(["beds", "area"]);
  });
});
