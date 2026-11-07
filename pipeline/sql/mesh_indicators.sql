-- mesh_indicators.parquet を作る。
-- 1行1メッシュで、年と指標の組を列に展開する（docs/design/base-data.md の「前処理と生成物」）。
-- 入力：国土数値情報「1kmメッシュ別将来推計人口（R6国政局推計）」の縦持ちの Parquet

SET VARIABLE mesh_src = getvariable('population_dir') || '/mlit_pop_proj_mesh1km_base2020/*.parquet';

-- 項目コードの番号は 00 から始まるが、PT00 は 0〜4 歳ではなく PT01〜PT20 の合計である。
-- PT01 が 0〜4 歳、PT20 が 95 歳以上なので、年齢区分は PT01〜PT20 から作る。
-- 境界をまたぐメッシュは shicode ごとに行が分かれて按分されているので、同じ mesh_code の行を合計する。
CREATE TEMP TABLE agg AS
SELECT
  mesh_code::UINTEGER AS mesh,
  "year"::INTEGER AS yr,
  sum(value) FILTER (WHERE item = 'PTN') AS pop,
  sum(value) FILTER (WHERE item BETWEEN 'PT01' AND 'PT03') AS p0_14,
  sum(value) FILTER (WHERE item BETWEEN 'PT04' AND 'PT13') AS p15_64,
  sum(value) FILTER (WHERE item BETWEEN 'PT14' AND 'PT20') AS p65,
  sum(value) FILTER (WHERE item BETWEEN 'PT16' AND 'PT20') AS p75,
  -- 秘匿記号（* は秘匿対象、@ は合算先）は年ごとに付く
  bool_or(hitoku IS NOT NULL) AS masked
FROM read_parquet(getvariable('mesh_src'))
GROUP BY ALL;

CREATE TEMP TABLE wide AS
PIVOT (
  SELECT mesh, yr,
    pop::FLOAT AS pop, p0_14::FLOAT AS p0_14, p15_64::FLOAT AS p15_64,
    p65::FLOAT AS p65, p75::FLOAT AS p75, masked
  FROM agg
)
ON yr IN (2020, 2025, 2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065, 2070)
USING first(pop) AS pop, first(p0_14) AS p0_14, first(p15_64) AS p15_64,
      first(p65) AS p65, first(p75) AS p75, first(masked) AS masked
GROUP BY mesh;

-- 2020 年は総数（PTN）だけで、年齢別の値と秘匿記号がない。
-- 行はメッシュコードの順に並べる（保留中の地域モードのため。docs/design/map-and-hosting.md）。
-- 行グループは既定の大きさ（122,880 行）のままにする。1次メッシュにそろえない理由は pipeline/README.md に書いた。
COPY (
  SELECT * EXCLUDE ("2020_p0_14", "2020_p15_64", "2020_p65", "2020_p75", "2020_masked")
  FROM wide
  ORDER BY mesh
) TO (getvariable('out_dir') || '/mesh_indicators.parquet')
  (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19);

SELECT count(*) AS rows, count(*) FILTER (WHERE "2050_masked") AS masked_2050
FROM read_parquet(getvariable('out_dir') || '/mesh_indicators.parquet');
