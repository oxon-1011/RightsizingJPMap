import { describe, expect, it } from "vitest";
import {
  assignPointsSql,
  columnTypeOfDuckDb,
  csvHeaderSql,
  csvJoinColumnNames,
  csvSource,
  joinValuesSql,
  normalizeSql,
  pointsCsv,
  quoteIdentifier,
  quoteString,
} from "./sql";

describe("引用", () => {
  it("識別子の二重引用符と、文字列の一重引用符を重ねる", () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteString("it's")).toBe("'it''s'");
  });
});

describe("columnTypeOfDuckDb", () => {
  it("DuckDB の型を、文字列、整数、浮動小数点数、その他にまとめる", () => {
    expect(columnTypeOfDuckDb("VARCHAR")).toBe("string");
    expect(columnTypeOfDuckDb("BIGINT")).toBe("integer");
    expect(columnTypeOfDuckDb("UBIGINT")).toBe("integer");
    expect(columnTypeOfDuckDb("DOUBLE")).toBe("float");
    expect(columnTypeOfDuckDb("DECIMAL(18,3)")).toBe("float");
    expect(columnTypeOfDuckDb("DATE")).toBe("other");
    expect(columnTypeOfDuckDb("BOOLEAN")).toBe("other");
  });
});

describe("CSV の読み方", () => {
  it("結合用の列の名前は、大文字と小文字を区別して選ぶ", () => {
    expect(csvJoinColumnNames(["code", "Code", "lat", "lon", "beds"])).toEqual([
      "code",
      "lat",
      "lon",
    ]);
  });

  it("区切りをカンマ、1行目を列名に固定し、行を飛ばす推定を止める", () => {
    const source = csvSource("a.csv", ["code"]);
    expect(source).toContain("header = true");
    expect(source).toContain("delim = ','");
    expect(source).toContain("skip = 0");
    expect(source).toContain("sample_size = -1");
    expect(source).toContain("types = {'code': 'VARCHAR'}");
    expect(csvSource("a.csv", [])).not.toContain("types");
    expect(csvHeaderSql("a.csv")).toContain("header = false");
    expect(csvHeaderSql("a.csv")).toContain("skip = 0");
  });
});

describe("joinValuesSql", () => {
  it("文字列の列はそのまま、数の列は DOUBLE にして、利用者の列名で取り出す", () => {
    const sql = joinValuesSql("src", [
      { name: "lat", sqlName: "lat", type: "float" },
      { name: "lon", sqlName: "lon_1", type: "string" },
    ]);
    expect(sql).toBe('SELECT CAST("lat" AS DOUBLE) AS "lat", "lon_1" AS "lon" FROM src');
  });
});

describe("normalizeSql", () => {
  it("結合用の列を保存の型に、数値の属性を DOUBLE にし、ほかの列はそのまま並べる", () => {
    const sql = normalizeSql({
      source: "src",
      joinColumns: [{ name: "mesh", sqlName: "mesh", type: "string" }],
      attributes: [
        { name: " 病床数", sqlName: "病床数", type: "integer" },
        { name: "名称", sqlName: "名称", type: "string" },
      ],
      outFile: "out.parquet",
    });
    expect(sql).toBe(
      `COPY (SELECT CAST("mesh" AS UINTEGER) AS "mesh", CAST("病床数" AS DOUBLE) AS " 病床数", "名称" AS "名称" FROM src) TO 'out.parquet' (FORMAT parquet, COMPRESSION zstd)`,
    );
  });
});

describe("点の割り当て", () => {
  it("点の番号と座標の CSV を作る", () => {
    expect(pointsCsv([35.5, 35.25], [134.2, 133.125])).toBe(
      "i,lat,lon\n0,35.5,134.2\n1,35.25,133.125\n",
    );
  });

  it("admin_geom の geometry を WKB から形に直して判定する", () => {
    const sql = assignPointsSql("p.csv", ["g31.parquet", "g32.parquet"]);
    expect(sql).toContain("read_parquet(['g31.parquet', 'g32.parquet'])");
    expect(sql).toContain("ST_GeomFromWKB(geometry)");
    expect(sql).toContain("ST_Contains(a.geom, ST_Point(p.lon, p.lat))");
  });
});
