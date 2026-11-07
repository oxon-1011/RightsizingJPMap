-- municipal_indicators.parquet を作る。
-- 1行が1地域の1年の縦持ち（docs/design/base-data.md の「前処理と生成物」）。
-- 入力：社人研「日本の地域別将来推計人口（令和5（2023）年推計）」と、浜松市の参考資料（2024 年の区再編後）

SET VARIABLE base_src = getvariable('population_dir') || '/ipss_pop_proj_municipal_base2020/*.parquet';
SET VARIABLE hamamatsu_src = getvariable('population_dir') || '/ipss_pop_proj_municipal_hamamatsu2024_base2020/*.parquet';

-- 推計の year 列は "2020年" の形の文字列である。形が違えば止める。
CREATE MACRO year_of(s) AS
  CASE WHEN regexp_full_match(s, '[0-9]{4}年') THEN left(s, 4)::INTEGER
       ELSE error('year の形が想定と違う：' || coalesce(s, 'NULL')) END;

CREATE TEMP TABLE src AS
SELECT * EXCLUDE (_source_url, _source_sha256, _source_sheet, _source_row)
FROM read_parquet(getvariable('base_src'))
-- 浜松市の再編前の7区は、参考資料の3区に差し替える
WHERE area_code NOT IN ('22131', '22132', '22133', '22134', '22135', '22136', '22137')
UNION ALL BY NAME
-- 参考資料には pref_name と area_type の列がないので補う
SELECT * EXCLUDE (_source_url, _source_sha256, _source_sheet, _source_row),
  '静岡県' AS pref_name, '0' AS area_type
FROM read_parquet(getvariable('hamamatsu_src'));

COPY (
  SELECT
    area_code::VARCHAR AS code,
    -- 都道府県の行は municipality_name が NULL なので、都道府県名を入れる
    (CASE WHEN area_type = 'a' THEN pref_name ELSE municipality_name END)::VARCHAR AS name,
    pref_name::VARCHAR AS pref_name,
    area_type::VARCHAR AS area_type,
    year_of("year")::INTEGER AS "year",
    total::BIGINT AS pop,
    -- 年齢区分（AGE_GROUPS）は5歳階級の列の合計で作る。区分はメッシュと同じ
    (total_00_04 + total_05_09 + total_10_14)::BIGINT AS p0_14,
    (total_15_19 + total_20_24 + total_25_29 + total_30_34 + total_35_39
      + total_40_44 + total_45_49 + total_50_54 + total_55_59 + total_60_64)::BIGINT AS p15_64,
    (total_65_69 + total_70_74 + total_75_79 + total_80_84 + total_85_89
      + total_90_94 + total_95_over)::BIGINT AS p65,
    (total_75_79 + total_80_84 + total_85_89 + total_90_94 + total_95_over)::BIGINT AS p75
  FROM src
  ORDER BY code, "year"
) TO (getvariable('out_dir') || '/municipal_indicators.parquet')
  (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19);

SELECT area_type, count(DISTINCT code) AS codes, count(*) AS rows
FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet')
GROUP BY ALL ORDER BY area_type;
