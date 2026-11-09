// 自前データの取り込みと、点の割り当てに使う DuckDB の SQL を組み立てる（docs/design/user-data.md）。
// 文字列を組み立てるだけの純粋な関数で、実行は duckdb-engine.ts が io の query で行う。
// 列の名前は利用者のデータなので、すべて識別子として引用する。

import { type ColumnSchema, type ColumnType, JOIN_COLUMN_NAMES } from "../core/accept/table";

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const quoteString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const INTEGER_TYPES: readonly string[] = [
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
];

/** DuckDB の型の名前（DESCRIBE の column_type）を、受け入れ検査の4つの型にまとめる */
export const columnTypeOfDuckDb = (type: string): ColumnType => {
  if (type === "VARCHAR") {
    return "string";
  }
  if (INTEGER_TYPES.includes(type)) {
    return "integer";
  }
  return type === "FLOAT" || type === "DOUBLE" || /^DECIMAL\(\d+,\d+\)$/.test(type)
    ? "float"
    : "other";
};

/** 結合用の列になりうる名前（code、mesh、lat、lon）。大文字と小文字を区別する */
const JOIN_NAMES: readonly string[] = Object.values(JOIN_COLUMN_NAMES).flat();

/** CSV の列名のうち、文字列として読む結合用の列 */
export const csvJoinColumnNames = (names: readonly string[]): readonly string[] =>
  names.filter((n) => JOIN_NAMES.includes(n));

/**
 * 表の列。name は利用者のファイルの列名そのもので、受け入れ検査と目録に使う。
 * sqlName は DuckDB が付けた列名で、SQL で列を指すのに使う。
 * DuckDB は CSV の列名の前後の空白を除き、空の列名や重なった列名を付け替えるので、2つが違うことがある。
 */
export type SqlColumn = ColumnSchema & { readonly sqlName: string };

/**
 * CSV の読み方の共通の指定。区切りはカンマ、1行目は列名に固定する（受け入れ条件）。
 * skip = 0 は、DuckDB が先頭の行を飛ばして読む推定を止めるためである。
 * 推定に任せると、1行目が列名でないファイルや列の数がそろわないファイルでも、途中の行から読めてしまう。
 */
const CSV_DIALECT = ["delim = ','", "skip = 0"] as const;

/**
 * CSV を読む read_csv の式。属性の列の型は全行から推定する（sample_size = -1）。
 * 先頭の行だけで推定すると、後ろの行に推定と違う値がある属性の列で、ファイル全体を読めなくなるからである。
 * varcharColumns（DuckDB の列名）の列は文字列として読む。ファイルにない列を書くとエラーになるので、ある列だけを渡す。
 */
export const csvSource = (fileName: string, varcharColumns: readonly string[]): string => {
  const options = ["header = true", ...CSV_DIALECT, "sample_size = -1"];
  if (varcharColumns.length > 0) {
    const types = varcharColumns.map((n) => `${quoteString(n)}: 'VARCHAR'`).join(", ");
    options.push(`types = {${types}}`);
  }
  return `read_csv(${quoteString(fileName)}, ${options.join(", ")})`;
};

/** 列名だけを得るための read_csv の式。列名は1行目から決まるので、型の推定は既定の行数で済ませる */
export const csvNamesSource = (fileName: string): string =>
  `read_csv(${quoteString(fileName)}, header = true, ${CSV_DIALECT.join(", ")})`;

/** CSV の1行目を、そのまま文字列として読む SQL。DuckDB が付け替える前の列名を知るのに使う */
export const csvHeaderSql = (fileName: string): string =>
  `SELECT * FROM read_csv(${quoteString(fileName)}, header = false, ${CSV_DIALECT.join(", ")}, all_varchar = true) LIMIT 1`;

export const parquetSource = (fileName: string): string => `read_parquet(${quoteString(fileName)})`;

export const describeSql = (source: string): string => `DESCRIBE SELECT * FROM ${source}`;

/** DuckDB の列を、利用者の列名で取り出す式。type を渡すとその型にする */
const selectColumn = (column: SqlColumn, type: string | null): string => {
  const value =
    type === null
      ? quoteIdentifier(column.sqlName)
      : `CAST(${quoteIdentifier(column.sqlName)} AS ${type})`;
  return `${value} AS ${quoteIdentifier(column.name)}`;
};

/**
 * 結合用の列の値を読む SQL。文字列の列はそのまま、数の列は DOUBLE にして読む。
 * DOUBLE にするのは、UBIGINT などが BigInt で届かないようにするためである（io の query は BIGINT だけを数にする）。
 */
export const joinValuesSql = (source: string, joinColumns: readonly SqlColumn[]): string => {
  const columns = joinColumns.map((c) => selectColumn(c, c.type === "string" ? null : "DOUBLE"));
  return `SELECT ${columns.join(", ")} FROM ${source}`;
};

/**
 * 正規化した Parquet での結合用の列の DuckDB の型。core の STORED_JOIN_COLUMNS と同じで、
 * code は先頭の 0 を保つため VARCHAR、mesh は UINTEGER、lat と lon は DOUBLE にする。
 */
const STORED_JOIN_TYPES: Readonly<Record<string, string>> = {
  code: "VARCHAR",
  mesh: "UINTEGER",
  lat: "DOUBLE",
  lon: "DOUBLE",
};

/**
 * 正規化した Parquet を書き出す SQL。結合用の列を先に並べ、属性の列をそのあとに元の順で並べる。
 * 列名は利用者のファイルの列名にする。数値の属性の列は DOUBLE にする。
 * hyparquet で読み戻すとき、どの整数型も同じように数として読めるからである。
 * 全行を読むので、型の推定より後ろにある UTF-8 でない行も、ここで失敗として分かる。
 */
export const normalizeSql = (args: {
  readonly source: string;
  readonly joinColumns: readonly SqlColumn[];
  readonly attributes: readonly SqlColumn[];
  readonly outFile: string;
}): string => {
  const join = args.joinColumns.map((c) => selectColumn(c, STORED_JOIN_TYPES[c.name] ?? "VARCHAR"));
  const attributes = args.attributes.map((c) =>
    selectColumn(c, c.type === "integer" || c.type === "float" ? "DOUBLE" : null),
  );
  return `COPY (SELECT ${[...join, ...attributes].join(", ")} FROM ${args.source}) TO ${quoteString(args.outFile)} (FORMAT parquet, COMPRESSION zstd)`;
};

/**
 * 点の座標を DuckDB に渡す CSV。i は点の番号で、割り当ての結果を点の順に戻すのに使う。
 * 数は JavaScript の既定の書き方（往復で同じ値に戻る最短の表記）で書く。
 */
export const pointsCsv = (lat: ArrayLike<number>, lon: ArrayLike<number>): string => {
  const lines = ["i,lat,lon"];
  for (let i = 0; i < lat.length; i++) {
    lines.push(`${i},${lat[i]},${lon[i]}`);
  }
  return `${lines.join("\n")}\n`;
};

/**
 * 点を行政区域に割り当てる SQL（docs/design/user-data.md の「点から行政区域を求める」）。
 * admin_geom の geometry 列は BLOB（WKB）で読まれるので、ST_GeomFromWKB で形に直す。
 * どの区域にも入らない点は結果に出ない。区域は重ならないが、境界上の点が2つに入った場合に備えて小さいほうのコードを取る。
 */
export const assignPointsSql = (pointsFile: string, geometryFiles: readonly string[]): string =>
  [
    "SELECT p.i AS i, min(a.code) AS code",
    `FROM read_csv(${quoteString(pointsFile)}, header = true, delim = ',', columns = {'i': 'UINTEGER', 'lat': 'DOUBLE', 'lon': 'DOUBLE'}) AS p`,
    `JOIN (SELECT code, ST_GeomFromWKB(geometry) AS geom FROM read_parquet([${geometryFiles.map(quoteString).join(", ")}])) AS a`,
    "ON ST_Contains(a.geom, ST_Point(p.lon, p.lat))",
    "GROUP BY p.i",
    "ORDER BY p.i",
  ].join("\n");
