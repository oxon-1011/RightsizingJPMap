-- mesh_indicators.parquet と、その元の推計を検証する。条件を満たさないと error() で止まる。

CREATE MACRO must(ok, msg) AS CASE WHEN ok THEN 'ok' ELSE error('検証に失敗：' || msg) END;

SET VARIABLE mesh_file = getvariable('out_dir') || '/mesh_indicators.parquet';
SET VARIABLE mesh_src = getvariable('population_dir') || '/mlit_pop_proj_mesh1km_base2020/*.parquet';
SET VARIABLE base_src = getvariable('population_dir') || '/ipss_pop_proj_municipal_base2020/*.parquet';

CREATE TEMP TABLE m AS
SELECT * FROM read_parquet(getvariable('mesh_file'), file_row_number = true);

-- 社人研の都道府県の合計（全国）。2020〜2050 年
CREATE TEMP TABLE ipss AS
SELECT left("year", 4)::INTEGER AS yr,
  sum(total) AS pop,
  sum(total_00_04) AS a00_04,
  sum(total_95_over) AS a95_over,
  sum(total_00_04 + total_05_09 + total_10_14) AS p0_14,
  sum(total_15_19 + total_20_24 + total_25_29 + total_30_34 + total_35_39
      + total_40_44 + total_45_49 + total_50_54 + total_55_59 + total_60_64) AS p15_64,
  sum(total_65_69 + total_70_74 + total_75_79 + total_80_84 + total_85_89
      + total_90_94 + total_95_over) AS p65,
  sum(total_75_79 + total_80_84 + total_85_89 + total_90_94 + total_95_over) AS p75
FROM read_parquet(getvariable('base_src'))
WHERE area_type = 'a'
GROUP BY 1;

-- 元の推計を、メッシュ、年、項目ごとに合計する（境界をまたぐメッシュの按分行もここで合計される）
CREATE TEMP TABLE src AS
SELECT mesh_code::UINTEGER AS mesh, "year"::INTEGER AS yr, item,
  sum(value) AS v, bool_or(hitoku IS NOT NULL) AS masked
FROM read_parquet(getvariable('mesh_src'))
GROUP BY ALL;

CREATE TEMP TABLE src_mesh_year AS
SELECT mesh, yr,
  sum(v) FILTER (WHERE item = 'PTN') AS ptn,
  sum(v) FILTER (WHERE item = 'PT00') AS pt00,
  sum(v) FILTER (WHERE item BETWEEN 'PT01' AND 'PT20') AS pt01_20,
  bool_or(masked) AS masked
FROM src GROUP BY ALL;

-- 列の名前、型、順
CREATE TEMP TABLE expected_columns AS
SELECT row_number() OVER (ORDER BY y, k) - 1 AS pos, name, type FROM (
  SELECT 0 AS y, 0 AS k, 'mesh' AS name, 'UINTEGER' AS type
  UNION ALL
  SELECT y, k, y || '_' || col, CASE WHEN col = 'masked' THEN 'BOOLEAN' ELSE 'FLOAT' END
  FROM range(2020, 2071, 5) AS t(y),
       (VALUES ('pop', 1), ('p0_14', 2), ('p15_64', 3), ('p65', 4), ('p75', 5), ('masked', 6)) AS c(col, k)
  WHERE y >= 2025 OR col = 'pop'
);

SELECT 'mesh: 列の名前、型、順（62 列）' AS "check",
  must(
    (SELECT list(column_name || ' ' || data_type ORDER BY column_index)
     FROM duckdb_columns() WHERE table_name = 'm' AND column_name <> 'file_row_number')
    = (SELECT list(name || ' ' || type ORDER BY pos) FROM expected_columns),
    'mesh_indicators の列が契約と違う'
  ) AS result
UNION ALL
SELECT 'mesh: 176,896 行で、mesh は重複せずに昇順',
  must(
    (SELECT count(*) FROM m) = 176896
    AND (SELECT count(*) FROM (
      SELECT mesh, lag(mesh) OVER (ORDER BY file_row_number) AS prev FROM m
    ) WHERE prev >= mesh) = 0,
    'mesh の行数か並びが違う'
  )
UNION ALL
SELECT 'mesh: どの列にも NULL がない（io は数値の NULL を NaN にするため）',
  must(
    (SELECT max(value) FROM (
      UNPIVOT (SELECT count(*) - count(COLUMNS(* EXCLUDE (file_row_number))) FROM m) ON COLUMNS(*)
    )) = 0,
    'mesh_indicators に NULL がある'
  )
UNION ALL
SELECT 'mesh: 人口の値は 0 以上の有限の数',
  must(
    (SELECT min(value) >= 0 AND bool_and(isfinite(value)) FROM (
      UNPIVOT (SELECT min(COLUMNS('_(pop|p0_14|p15_64|p65|p75)$')) FROM m) ON COLUMNS(*)
    ))
    AND (SELECT bool_and(isfinite(value)) FROM (
      UNPIVOT (SELECT max(COLUMNS('_(pop|p0_14|p15_64|p65|p75)$')) FROM m) ON COLUMNS(*)
    )),
    '負の値か NaN がある'
  );

-- 全国合計の一致（FLOAT に落とす前）。2025 年と 2050 年は値でも確かめる
SELECT 'mesh: 全国合計（元の推計の PTN）が社人研の都道府県の合計と一致' AS "check",
  list(s.yr || ':' || round(s.ptn, 6) ORDER BY s.yr) AS value,
  must(
    count(*) = 7 AND max(abs(s.ptn - i.pop)) < 1e-3
    AND any_value(s.ptn) FILTER (WHERE s.yr = 2025) BETWEEN 123262450 - 1e-3 AND 123262450 + 1e-3
    AND any_value(s.ptn) FILTER (WHERE s.yr = 2050) BETWEEN 104686386 - 1e-3 AND 104686386 + 1e-3,
    'メッシュの全国合計が社人研と一致しない'
  ) AS result
FROM (SELECT yr, sum(ptn) AS ptn FROM src_mesh_year GROUP BY yr) s
JOIN ipss i USING (yr);

-- 年齢の割り当て（元の推計）
SELECT 'mesh: PT00 は PT01〜PT20 の合計（0〜4 歳ではない）' AS "check",
  max(abs(pt00 - pt01_20))::VARCHAR AS value,
  must(max(abs(pt00 - pt01_20)) < 1e-6, 'PT00 が PT01〜PT20 の合計と一致しない') AS result
FROM src_mesh_year WHERE yr >= 2025
UNION ALL
SELECT 'mesh: 秘匿のないメッシュでは PT00 と PTN が一致',
  max(abs(pt00 - ptn))::VARCHAR,
  must(max(abs(pt00 - ptn)) < 1e-6, '秘匿のないメッシュで PT00 と PTN が一致しない')
FROM src_mesh_year WHERE yr >= 2025 AND NOT masked
UNION ALL
SELECT 'mesh: PT01 は 0〜4 歳、PT20 は 95 歳以上（全国合計が社人研と一致）',
  max(abs(s.pt01 - i.a00_04))::VARCHAR || ' / ' || max(abs(s.pt20 - i.a95_over))::VARCHAR,
  must(count(*) = 6 AND max(abs(s.pt01 - i.a00_04)) < 1e-3 AND max(abs(s.pt20 - i.a95_over)) < 1e-3,
        'PT01 か PT20 の全国合計が社人研の 0〜4 歳、95 歳以上と一致しない')
FROM (
  SELECT yr, sum(v) FILTER (WHERE item = 'PT01') AS pt01, sum(v) FILTER (WHERE item = 'PT20') AS pt20
  FROM src WHERE yr >= 2025 GROUP BY yr
) s JOIN ipss i USING (yr);

-- 出力の Parquet（FLOAT）を年ごとの縦持ちに戻して確かめる
CREATE TEMP TABLE out_long AS
PIVOT (
  SELECT mesh, left(col, 4)::INTEGER AS yr, substr(col, 6) AS metric, val
  FROM (UNPIVOT (SELECT mesh, COLUMNS('^20[0-9]{2}_')::DOUBLE FROM m) ON COLUMNS('^20') INTO NAME col VALUE val)
)
ON metric IN ('pop', 'p0_14', 'p15_64', 'p65', 'p75', 'masked')
USING first(val)
GROUP BY mesh, yr;

-- 許容差：FLOAT の丸めで全国合計は 0.01 人ほどずれる（2026-11-07 に確かめた）。1 人までを許す
SELECT 'mesh: 出力の全国合計が社人研と 1 人以内で一致（2020〜2050 年）' AS "check",
  max(abs(o.pop - i.pop))::VARCHAR AS value,
  must(count(*) = 7 AND max(abs(o.pop - i.pop)) < 1, '出力の総人口の全国合計が社人研とずれている') AS result
FROM (SELECT yr, sum(pop) AS pop FROM out_long GROUP BY yr) o JOIN ipss i USING (yr)
UNION ALL
SELECT 'mesh: 出力の年齢区分の全国合計が社人研と 1 人以内で一致（2025〜2050 年）',
  max(greatest(abs(o.p0_14 - i.p0_14), abs(o.p15_64 - i.p15_64), abs(o.p65 - i.p65), abs(o.p75 - i.p75)))::VARCHAR,
  must(count(*) = 6 AND max(greatest(abs(o.p0_14 - i.p0_14), abs(o.p15_64 - i.p15_64),
                                       abs(o.p65 - i.p65), abs(o.p75 - i.p75))) < 1,
        '出力の年齢区分の全国合計が社人研とずれている')
FROM (
  SELECT yr, sum(p0_14) AS p0_14, sum(p15_64) AS p15_64, sum(p65) AS p65, sum(p75) AS p75
  FROM out_long WHERE yr >= 2025 GROUP BY yr
) o JOIN ipss i USING (yr)
UNION ALL
SELECT 'mesh: 秘匿のないメッシュでは 0〜14、15〜64、65 以上の和が総人口に一致（FLOAT の丸めの範囲）',
  max(abs(p0_14 + p15_64 + p65 - pop))::VARCHAR,
  must(bool_and(abs(p0_14 + p15_64 + p65 - pop) <= 0.05 + 1e-6 * pop),
        '年齢区分の和が総人口と一致しない')
FROM out_long WHERE yr >= 2025 AND masked = 0
UNION ALL
SELECT 'mesh: 75 歳以上は 65 歳以上を超えない',
  max(p75 - p65)::VARCHAR,
  must(bool_and(p75 <= p65 + 1e-3), '75 歳以上が 65 歳以上より多い')
FROM out_long WHERE yr >= 2025
UNION ALL
-- 件数は docs/design/base-data.md の「秘匿と合算」に書いた値
SELECT 'mesh: 秘匿記号の付いたメッシュは 2025 年 14,087、2050 年 4,037、2070 年 5,242',
  list(yr || ':' || n ORDER BY yr)::VARCHAR,
  must(list(n ORDER BY yr) = [14087, 4037, 5242], '秘匿記号の付いたメッシュの数が違う')
FROM (SELECT yr, count(*) FILTER (WHERE masked = 1) AS n FROM out_long WHERE yr IN (2025, 2050, 2070) GROUP BY yr);

SELECT 'mesh: 行グループ（参考）' AS "check",
  count(*)::VARCHAR || ' 個、' || min(row_group_num_rows) || '〜' || max(row_group_num_rows) || ' 行' AS value
FROM (SELECT DISTINCT row_group_id, row_group_num_rows FROM parquet_metadata(getvariable('mesh_file')));
