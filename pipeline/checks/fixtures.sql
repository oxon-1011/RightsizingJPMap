-- tests/fixtures/ の鳥取県の分を検証する。列は生成物と同じで、行は鳥取県の分だけであること。
-- 条件を満たさないと error() で止まる。

CREATE MACRO must(ok, msg) AS CASE WHEN ok THEN 'ok' ELSE error('検証に失敗：' || msg) END;

CREATE TEMP TABLE mesh AS SELECT * FROM read_parquet(getvariable('out_dir') || '/mesh_indicators.parquet');
CREATE TEMP TABLE mesh_fx AS SELECT * FROM read_parquet(getvariable('fixtures_dir') || '/mesh_indicators.tottori.parquet');
CREATE TEMP TABLE muni AS SELECT * FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet');
CREATE TEMP TABLE muni_fx AS SELECT * FROM read_parquet(getvariable('fixtures_dir') || '/municipal_indicators.tottori.parquet');

CREATE MACRO columns_of(t) AS (
  SELECT list(column_name || ' ' || data_type ORDER BY column_index) FROM duckdb_columns() WHERE table_name = t
);

-- 鳥取県のファイル（pref_code = 31）に現れるメッシュ。県境のメッシュも含む
CREATE TEMP TABLE tottori_mesh AS
SELECT DISTINCT mesh_code::UINTEGER AS mesh
FROM read_parquet(getvariable('population_dir') || '/mlit_pop_proj_mesh1km_base2020/*.parquet')
WHERE pref_code = 31;

SELECT 'fixtures: 列の名前、型、順が生成物と同じ' AS "check",
  NULL AS value,
  must(columns_of('mesh_fx') = columns_of('mesh') AND columns_of('muni_fx') = columns_of('muni'),
       'テスト用データの列が生成物と違う') AS result
UNION ALL
SELECT 'fixtures: mesh_indicators.tottori は、鳥取県のファイルに現れるメッシュの行そのもの',
  (SELECT count(*) FROM mesh_fx)::VARCHAR,
  must(
    (SELECT count(*) FROM mesh_fx) = (SELECT count(*) FROM tottori_mesh)
    AND (SELECT count(*) FROM (FROM mesh_fx EXCEPT FROM mesh SEMI JOIN tottori_mesh USING (mesh))) = 0
    AND (SELECT count(*) FROM (FROM mesh SEMI JOIN tottori_mesh USING (mesh) EXCEPT FROM mesh_fx)) = 0,
    'メッシュのテスト用データが鳥取県の分と一致しない'
  )
UNION ALL
SELECT 'fixtures: municipal_indicators.tottori は、鳥取県と県内 19 市町村の 7 時点',
  (SELECT count(*) FROM muni_fx)::VARCHAR,
  must(
    (SELECT count(*) FROM muni_fx) = 20 * 7
    AND (SELECT count(*) FROM (FROM muni_fx EXCEPT FROM muni WHERE starts_with(code, '31'))) = 0
    AND (SELECT count(*) FROM (FROM muni WHERE starts_with(code, '31') EXCEPT FROM muni_fx)) = 0,
    '行政区域のテスト用データが鳥取県の分と一致しない'
  );
