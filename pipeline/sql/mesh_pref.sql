-- mesh_pref/<2桁の都道府県コード>.parquet の元になる表を作る（docs/design/base-data.md の「前処理と生成物」）。
-- 都道府県ごとの書き出しは、mesh_pref_copy.sql が組み立てる COPY 文で行う。
-- 入力：国土数値情報「1kmメッシュ別将来推計人口（R6国政局推計）」の縦持ちの Parquet と、mesh_indicators.parquet

SET VARIABLE mesh_src = getvariable('population_dir') || '/mlit_pop_proj_mesh1km_base2020/*.parquet';

-- メッシュと、そのメッシュに shicode の行がある都道府県の組。県境のメッシュは、またぐ県の数だけ行を持つ。
-- shicode には 22131_22132 のように複数のコードをつないだ値もあるので、分けてから上2桁を見る。
CREATE OR REPLACE TABLE mesh_pref_member AS
SELECT DISTINCT mesh_code::UINTEGER AS mesh, left(unnest(string_split(shicode, '_')), 2) AS pref_code
FROM read_parquet(getvariable('mesh_src'));

-- 値は全国のファイルの行をそのまま使う。県境のメッシュの値も、メッシュ全体の合計のままにする
CREATE OR REPLACE TABLE mesh_indicators AS
SELECT * FROM read_parquet(getvariable('out_dir') || '/mesh_indicators.parquet');

SELECT count(DISTINCT pref_code) AS prefs, count(*) AS members, count(DISTINCT mesh) AS meshes
FROM mesh_pref_member;
