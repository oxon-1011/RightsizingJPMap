-- municipal_indicators.parquet を検証する。条件を満たさないと error() で止まる。

CREATE MACRO must(ok, msg) AS CASE WHEN ok THEN 'ok' ELSE error('検証に失敗：' || msg) END;

SET VARIABLE muni_file = getvariable('out_dir') || '/municipal_indicators.parquet';

CREATE TEMP TABLE m AS
SELECT * FROM read_parquet(getvariable('muni_file'), file_row_number = true);

-- 地図で塗る単位（政令指定都市の区、東京都の特別区、それ以外の市町村、浜通り地域）
CREATE TEMP TABLE units AS SELECT * FROM m WHERE area_type IN ('0', '2', '3', '9');

SELECT 'municipal: 列の名前、型、順（MUNICIPAL_COLUMNS と AGE_GROUPS）' AS "check",
  must(
    (SELECT list(column_name || ' ' || data_type ORDER BY column_index)
     FROM duckdb_columns() WHERE table_name = 'm' AND column_name <> 'file_row_number')
    = ['code VARCHAR', 'name VARCHAR', 'pref_name VARCHAR', 'area_type VARCHAR', 'year INTEGER',
       'pop BIGINT', 'p0_14 BIGINT', 'p15_64 BIGINT', 'p65 BIGINT', 'p75 BIGINT'],
    'municipal_indicators の列が契約と違う'
  ) AS result
UNION ALL
SELECT 'municipal: どの列にも NULL がない',
  must(
    (SELECT max(value) FROM (
      UNPIVOT (SELECT count(*) - count(COLUMNS(* EXCLUDE (file_row_number))) FROM m) ON COLUMNS(*)
    )) = 0,
    'municipal_indicators に NULL がある'
  )
UNION ALL
SELECT 'municipal: code は5桁の数字で、(code, year) は重複せず、その順に並ぶ',
  must(
    (SELECT bool_and(regexp_full_match(code, '[0-9]{5}')) FROM m)
    AND (SELECT count(*) = count(DISTINCT (code, "year")) FROM m)
    AND (SELECT count(*) FROM (
      SELECT code, "year", lag((code, "year")) OVER (ORDER BY file_row_number) AS prev FROM m
    ) WHERE prev >= (code, "year")) = 0,
    'code の形、重複、並びのいずれかが違う'
  )
UNION ALL
SELECT 'municipal: どの地域も 2020〜2050 年の7時点をそろえて持つ',
  must(
    (SELECT bool_and(years = [2020, 2025, 2030, 2035, 2040, 2045, 2050])
     FROM (SELECT code, list("year" ORDER BY "year") AS years FROM m GROUP BY code)),
    '年次がそろっていない地域がある'
  )
UNION ALL
SELECT 'municipal: area_type ごとの件数（a 47、1 20、0 194、2 769、3 916、9 1）',
  must(
    (SELECT list(area_type || ':' || n ORDER BY area_type)
     FROM (SELECT area_type, count(DISTINCT code) AS n FROM m GROUP BY area_type))
    = ['0:194', '1:20', '2:769', '3:916', '9:1', 'a:47'],
    'area_type ごとの件数が違う'
  )
UNION ALL
SELECT 'municipal: 都道府県は code が 01000 の形で、name は都道府県名',
  must(
    (SELECT bool_and(code LIKE '__000' AND name = pref_name) FROM m WHERE area_type = 'a')
    AND (SELECT bool_and(code NOT LIKE '__000') FROM m WHERE area_type <> 'a'),
    '都道府県の行の code か name が違う'
  )
UNION ALL
SELECT 'municipal: 浜松市の旧7区（22131〜22137）が残っていない',
  must(
    (SELECT count(*) FROM m WHERE code BETWEEN '22131' AND '22137') = 0,
    '浜松市の旧7区が残っている'
  )
UNION ALL
SELECT 'municipal: 浜松市の3区（22138〜22140）は静岡県の区で、合計が浜松市と一致',
  must(
    (SELECT list(code || ' ' || name || ' ' || pref_name || ' ' || area_type ORDER BY code)
     FROM (SELECT DISTINCT code, name, pref_name, area_type FROM m WHERE code BETWEEN '22138' AND '22140'))
    = ['22138 浜松市中央区 静岡県 0', '22139 浜松市浜名区 静岡県 0', '22140 浜松市天竜区 静岡県 0']
    AND (SELECT bool_and(w.pop = c.pop AND w.p65 = c.p65)
         FROM (SELECT "year", sum(pop) AS pop, sum(p65) AS p65 FROM m WHERE code BETWEEN '22138' AND '22140' GROUP BY 1) w
         JOIN (SELECT "year", pop, p65 FROM m WHERE code = '22130') c USING ("year")),
    '浜松市の3区の行が違う'
  )
UNION ALL
SELECT 'municipal: 0〜14、15〜64、65 以上の和が総人口に一致し、75 歳以上は 65 歳以上を超えない',
  must(
    (SELECT bool_and(p0_14 + p15_64 + p65 = pop AND p75 <= p65 AND p0_14 >= 0) FROM m),
    '年齢区分の和が総人口と一致しない'
  );

-- 全国と都道府県の合計
SELECT 'municipal: 全国合計（2025 年 123,262,450、2050 年 104,686,386）' AS "check",
  list("year" || ':' || pop ORDER BY "year")::VARCHAR AS value,
  must(
    any_value(pop) FILTER (WHERE "year" = 2025) = 123262450
    AND any_value(pop) FILTER (WHERE "year" = 2050) = 104686386,
    '都道府県の合計が想定と違う'
  ) AS result
FROM (SELECT "year", sum(pop) AS pop FROM m WHERE area_type = 'a' GROUP BY 1)
UNION ALL
SELECT 'municipal: 都道府県の値が、県内の塗る単位の合計と一致（全年、全年齢区分）',
  count(*)::VARCHAR || ' 組',
  must(
    count(*) = 47 * 7
    AND bool_and(p.pop = u.pop AND p.p0_14 = u.p0_14 AND p.p15_64 = u.p15_64 AND p.p65 = u.p65 AND p.p75 = u.p75),
    '都道府県の値と、県内の区市町村の合計が一致しない'
  )
FROM (SELECT left(code, 2) AS pref, "year", pop, p0_14, p15_64, p65, p75 FROM m WHERE area_type = 'a') p
JOIN (
  SELECT left(code, 2) AS pref, "year", sum(pop) AS pop, sum(p0_14) AS p0_14, sum(p15_64) AS p15_64,
         sum(p65) AS p65, sum(p75) AS p75
  FROM units GROUP BY 1, 2
) u USING (pref, "year");
