-- mesh_pref/<2桁の都道府県コード>.parquet を検証する。条件を満たさないと error() で止まる。

CREATE MACRO must(ok, msg) AS CASE WHEN ok THEN 'ok' ELSE error('検証に失敗：' || msg) END;

SET VARIABLE mesh_file = getvariable('out_dir') || '/mesh_indicators.parquet';
SET VARIABLE pref_files = getvariable('out_dir') || '/mesh_pref/*.parquet';
SET VARIABLE mesh_src = getvariable('population_dir') || '/mlit_pop_proj_mesh1km_base2020/*.parquet';

CREATE TEMP TABLE m AS SELECT * FROM read_parquet(getvariable('mesh_file'));

-- ファイルの名前から都道府県コードを取り出す。行の順を見るために、ファイルの中の行の番号も読む
CREATE TEMP TABLE p AS
SELECT * EXCLUDE (filename), regexp_extract(filename, '([^/]+)\.parquet$', 1) AS pref_code
FROM read_parquet(getvariable('pref_files'), filename = true, file_row_number = true);

-- 元の推計から、メッシュと都道府県の組を作り直す
CREATE TEMP TABLE member AS
SELECT DISTINCT mesh_code::UINTEGER AS mesh, left(unnest(string_split(shicode, '_')), 2) AS pref_code
FROM read_parquet(getvariable('mesh_src'));

SELECT 'mesh_pref: 01〜47 の 47 ファイルがある' AS "check",
  must(
    (SELECT list(DISTINCT pref_code ORDER BY pref_code) FROM p)
    = (SELECT list(format('{:02d}', i) ORDER BY i) FROM range(1, 48) AS t(i)),
    'mesh_pref のファイルが 01〜47 でない'
  ) AS result
UNION ALL
SELECT 'mesh_pref: どのファイルも、列の名前、型、順が mesh_indicators.parquet と同じ',
  must(
    -- 列の順は Parquet のメタデータの column_id で見る。論理型（UINTEGER など）は、合わせて読んだ表で見る
    (SELECT count(*) FROM (
      SELECT list(path_in_schema || ' ' || type ORDER BY column_id) AS columns
      FROM parquet_metadata(getvariable('pref_files')) WHERE row_group_id = 0
      GROUP BY file_name
    ) WHERE columns <> (
      SELECT list(path_in_schema || ' ' || type ORDER BY column_id)
      FROM parquet_metadata(getvariable('mesh_file')) WHERE row_group_id = 0
    )) = 0
    AND (SELECT list(column_name || ' ' || data_type ORDER BY column_index)
         FROM duckdb_columns() WHERE table_name = 'p' AND column_name NOT IN ('pref_code', 'file_row_number'))
      = (SELECT list(column_name || ' ' || data_type ORDER BY column_index)
         FROM duckdb_columns() WHERE table_name = 'm'),
    'mesh_pref の列が mesh_indicators.parquet と違う'
  )
UNION ALL
SELECT 'mesh_pref: どのファイルも、mesh は重複せずに昇順',
  must(
    (SELECT count(*) FROM (
      SELECT mesh, lag(mesh) OVER (PARTITION BY pref_code ORDER BY file_row_number) AS prev FROM p
    ) WHERE prev >= mesh) = 0,
    'mesh_pref の行の並びが違う'
  )
UNION ALL
SELECT 'mesh_pref: 行は、その都道府県の shicode を持つメッシュと一致',
  must(
    (SELECT count(*) FROM (
      (SELECT mesh, pref_code FROM p EXCEPT SELECT mesh, pref_code FROM member)
      UNION ALL
      (SELECT mesh, pref_code FROM member EXCEPT SELECT mesh, pref_code FROM p)
    )) = 0,
    'mesh_pref の行が、元の推計の shicode と一致しない'
  )
UNION ALL
SELECT 'mesh_pref: どの行も、mesh_indicators.parquet の同じメッシュの行と値が同じ',
  must(
    (SELECT count(*) FROM (
      SELECT * EXCLUDE (pref_code, file_row_number) FROM p EXCEPT SELECT * FROM m
    )) = 0,
    'mesh_pref の値が mesh_indicators.parquet と違う'
  );

-- 件数は docs/design/base-data.md の「前処理と生成物」に書いた値
SELECT 'mesh_pref: 177,791 行で、メッシュは 176,896、2県にまたがるメッシュは 895' AS "check",
  (SELECT count(*) FROM p)::VARCHAR || ' / ' || (SELECT count(DISTINCT mesh) FROM p)::VARCHAR
    || ' / ' || (SELECT count(*) FROM (SELECT mesh FROM p GROUP BY mesh HAVING count(*) = 2))::VARCHAR AS value,
  must(
    (SELECT count(*) FROM p) = 177791
    AND (SELECT count(DISTINCT mesh) FROM p) = 176896
    AND (SELECT count(*) FROM (SELECT mesh FROM p GROUP BY mesh HAVING count(*) = 2)) = 895
    AND (SELECT count(*) FROM (SELECT mesh FROM p GROUP BY mesh HAVING count(*) > 2)) = 0,
    'mesh_pref の行数か、県境のメッシュの数が違う'
  ) AS result;

SELECT 'mesh_pref: 大きさ（参考）' AS "check",
  count(*)::VARCHAR || ' ファイル、最小 ' || min(n) || ' 行（' || arg_min(pref_code, n) || '）、最大 '
    || max(n) || ' 行（' || arg_max(pref_code, n) || '）' AS value
FROM (SELECT pref_code, count(*) AS n FROM p GROUP BY pref_code);
