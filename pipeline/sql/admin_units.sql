-- 行政区域のポリゴンを、地図で塗る単位にまとめる。結果は作業用のデータベースに置き、
-- admin_tiles_input.sql、admin_geom.sql、places.sql がそこから読む。
-- 入力：国土数値情報「行政区域データ」N03 の 2024 年版（2024 年 1 月 1 日時点）と、
--       municipal_indicators.parquet（地図で塗る単位の団体コード）

INSTALL spatial;
LOAD spatial;

-- N03 は1行が1つのポリゴンで、島や飛び地は別の行になる
CREATE TABLE n03 AS
SELECT N03_001 AS pref_name, N03_003 AS gun, N03_004 AS muni, N03_005 AS ward,
       N03_007 AS code, geom
FROM ST_Read(getvariable('n03_shp'));

-- 推計で値を持つ、地図で塗る単位（政令指定都市の区、東京都の特別区、それ以外の市町村、浜通り地域）
CREATE TABLE estimate_units AS
SELECT DISTINCT code, name, pref_name, area_type
FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet')
WHERE area_type IN ('0', '2', '3', '9');

-- N03 の団体コードごとの属性と、地図で塗る単位への対応
--   unassigned：所属未定地。団体コードは都道府県の 01000 の形で、市区町村の単位を持たない
--   hamadoori ：福島県で推計に団体コードがない市町村。まとめて 07999（浜通り地域）にする
--   no_estimate：推計にない市町村（北方領土の6村）。境界は描くが値はない
--   estimate  ：推計に団体コードがある
CREATE TABLE n03_codes AS
WITH c AS (
  SELECT code, any_value(pref_name) AS pref_name, any_value(gun) AS gun,
         any_value(muni) AS muni, any_value(ward) AS ward, count(*) AS polygons,
         count(DISTINCT (pref_name, gun, muni, ward)) AS name_variants
  FROM n03 GROUP BY code
)
SELECT c.*,
  CASE
    WHEN c.code LIKE '__000' THEN 'unassigned'
    WHEN e.code IS NOT NULL THEN 'estimate'
    WHEN c.code LIKE '07%' THEN 'hamadoori'
    ELSE 'no_estimate'
  END AS status,
  CASE
    WHEN c.code LIKE '__000' THEN NULL
    WHEN e.code IS NULL AND c.code LIKE '07%' THEN '07999'
    ELSE c.code
  END AS unit_code,
  -- 名前は推計と同じ形にする（「札幌市中央区」「千代田区」）
  c.muni || coalesce(c.ward, '') AS name
FROM c LEFT JOIN estimate_units e USING (code);

SELECT CASE WHEN max(name_variants) = 1 THEN 'ok'
            ELSE error('N03 で1つの団体コードに複数の名前がある') END AS name_variants
FROM n03_codes;

-- 団体コードごとに1つのジオメトリにまとめる
CREATE TEMP TABLE code_geom AS
SELECT code, ST_Union_Agg(geom) AS geom FROM n03 GROUP BY code;

-- 東京都の都心の区で、隣り合う区の境界の頂点がわずかにずれている（2026-11-07 に確かめた）。
-- 被覆（隙間も重なりもないポリゴンの集まり）に直してから、簡略化とまとめに使う。
CREATE TABLE code_geom_clean AS
WITH t AS (
  SELECT list(code ORDER BY code) AS codes,
         ST_CoverageClean(list(geom ORDER BY code)) AS g
  FROM code_geom
),
d AS (SELECT codes, unnest(ST_Dump(g)) AS x FROM t)
SELECT codes[x.path[1]] AS code, ST_Multi(ST_Collect(list(x.geom))) AS geom
FROM d GROUP BY 1;

SELECT CASE WHEN ST_CoverageInvalidEdges_Agg(geom) IS NULL THEN 'ok'
            ELSE error('被覆に直したあとも、境界のずれが残っている') END AS coverage
FROM code_geom_clean;

-- 地図で塗る単位のポリゴン（所属未定地を除く）。全精度で、タイルと places.json に使う
CREATE TABLE units AS
SELECT
  c.unit_code AS code,
  CASE WHEN c.unit_code = '07999' THEN '浜通り地域' ELSE any_value(c.name) END AS name,
  any_value(c.pref_name) AS pref_name,
  left(c.unit_code, 2) AS pref_code,
  count(*) AS n03_codes,
  ST_Multi(ST_CoverageUnion_Agg(g.geom)) AS geom
FROM n03_codes c JOIN code_geom_clean g USING (code)
WHERE c.unit_code IS NOT NULL
GROUP BY c.unit_code;

-- 都道府県のポリゴン。団体コードの上2桁でまとめ、所属未定地も含める
CREATE TABLE prefs AS
SELECT
  left(g.code, 2) AS pref_code,
  left(g.code, 2) || '000' AS code,
  any_value(c.pref_name) AS name,
  ST_Multi(ST_CoverageUnion_Agg(g.geom)) AS geom
FROM code_geom_clean g JOIN n03_codes c USING (code)
GROUP BY 1, 2;

-- admin_geom 用に、被覆を保ったまま簡略化する（許容差 0.0002 度、約 20m）。
-- 1つずつ簡略化すると隣との間に隙間や重なりができ、重なりに入った点は2つの区域に数えられてしまう。
-- 所属未定地も被覆に含めて簡略化し、隣との境界をそろえてから除く。
CREATE TABLE units_simplified AS
WITH members AS (
  SELECT code, geom FROM units
  UNION ALL
  SELECT g.code, g.geom FROM code_geom_clean g JOIN n03_codes c USING (code)
  WHERE c.status = 'unassigned'
),
t AS (
  SELECT list(code ORDER BY code) AS codes,
         ST_CoverageSimplify(list(geom ORDER BY code), 0.0002, true) AS g
  FROM members
),
d AS (SELECT codes, unnest(ST_Dump(g)) AS x FROM t)
SELECT u.code, u.name, u.pref_code, s.geom
FROM (
  SELECT codes[x.path[1]] AS code, ST_Multi(ST_Collect(list(x.geom))) AS geom
  FROM d GROUP BY 1
) s
JOIN units u USING (code);

SELECT status, count(*) AS n03_codes, sum(polygons) AS polygons
FROM n03_codes GROUP BY status ORDER BY status;

SELECT (SELECT count(*) FROM units) AS units,
       (SELECT count(*) FROM prefs) AS prefs,
       (SELECT count(*) FROM units_simplified) AS units_simplified,
       (SELECT sum(ST_NPoints(geom)) FROM units) AS points_full,
       (SELECT sum(ST_NPoints(geom)) FROM units_simplified) AS points_simplified;
