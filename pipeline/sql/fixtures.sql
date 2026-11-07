-- tests/fixtures/ に鳥取県の分を書き出す（tests/fixtures/README.md）。
-- 列は生成物と同じにし、行を絞るだけにする。

SET VARIABLE mesh_src = getvariable('population_dir') || '/mlit_pop_proj_mesh1km_base2020/*.parquet';

-- 鳥取県（31）の市町村の shicode を持つメッシュ。県境のメッシュも含む。
-- shicode には 31201_31202 のように複数のコードをつないだ値もあるので、分けてから見る。
CREATE TEMP TABLE tottori_mesh AS
SELECT DISTINCT mesh_code::UINTEGER AS mesh
FROM read_parquet(getvariable('mesh_src'))
WHERE list_bool_or(list_transform(string_split(shicode, '_'), lambda c: starts_with(c, '31')));

COPY (
  SELECT m.*
  FROM read_parquet(getvariable('out_dir') || '/mesh_indicators.parquet') m
  SEMI JOIN tottori_mesh USING (mesh)
  ORDER BY mesh
) TO (getvariable('fixtures_dir') || '/mesh_indicators.tottori.parquet')
  (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19);

-- 鳥取県（31000）と県内の市町村
COPY (
  SELECT *
  FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet')
  WHERE starts_with(code, '31')
  ORDER BY code, "year"
) TO (getvariable('fixtures_dir') || '/municipal_indicators.tottori.parquet')
  (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19);

SELECT
  (SELECT count(*) FROM read_parquet(getvariable('fixtures_dir') || '/mesh_indicators.tottori.parquet')) AS mesh_rows,
  (SELECT count(*) FROM read_parquet(getvariable('fixtures_dir') || '/municipal_indicators.tottori.parquet')) AS municipal_rows;
