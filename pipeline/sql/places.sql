-- places.json を作る。場所への移動の候補で、要素は src/core/data/schema.ts の Place。
-- 範囲は N03 の全精度のポリゴンから求める（docs/design/ui.md の「場所への移動」）。
--   prefecture     ：都道府県。code は 01000 の形
--   designated-city：政令指定都市。範囲はその区の範囲を合わせたもの。code は推計の団体コード
--   ward           ：政令指定都市の区。名前は「浜松市中央区」の形
--   municipality   ：それ以外の市町村と東京都の特別区
-- 移動の候補なので、浜通り地域の構成市町村は推計の単位にまとめず、N03 の名前とコードで個別に載せる。
-- 所属未定地は市区町村の単位を持たないので載せない。北方領土の6村は N03 にあるので載せる。

LOAD spatial;

-- 範囲を小数5桁（約1m）に外向きに丸める。順は西、南、東、北（BBox）
CREATE MACRO bbox_of(xmin, ymin, xmax, ymax) AS
  [floor(xmin * 1e5) / 1e5, floor(ymin * 1e5) / 1e5, ceil(xmax * 1e5) / 1e5, ceil(ymax * 1e5) / 1e5];

CREATE TEMP TABLE code_extent AS
SELECT c.code, c.pref_name, c.muni, c.ward, c.name, c.status,
  ST_XMin(g.geom) AS xmin, ST_YMin(g.geom) AS ymin, ST_XMax(g.geom) AS xmax, ST_YMax(g.geom) AS ymax
FROM n03_codes c JOIN code_geom_clean g USING (code)
WHERE c.status <> 'unassigned';

-- 政令指定都市の団体コードは N03 にないので、推計の area_type 1 から名前で引く
CREATE TEMP TABLE designated_cities AS
SELECT DISTINCT code, name, pref_name
FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet')
WHERE area_type = '1';

CREATE TEMP TABLE places AS
SELECT code, name, name AS pref_name, 'prefecture' AS kind,
  bbox_of(ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom)) AS bbox
FROM prefs
UNION ALL
SELECT d.code, d.name, d.pref_name, 'designated-city' AS kind,
  bbox_of(min(w.xmin), min(w.ymin), max(w.xmax), max(w.ymax)) AS bbox
FROM code_extent w
JOIN designated_cities d ON d.pref_name = w.pref_name AND d.name = w.muni
WHERE w.ward IS NOT NULL
GROUP BY d.code, d.name, d.pref_name
UNION ALL
SELECT code, name, pref_name, CASE WHEN ward IS NOT NULL THEN 'ward' ELSE 'municipality' END AS kind,
  bbox_of(xmin, ymin, xmax, ymax) AS bbox
FROM code_extent;

COPY (
  SELECT code, name, pref_name, kind, bbox FROM places ORDER BY code
) TO (getvariable('out_dir') || '/places.json') (FORMAT json, ARRAY true);

SELECT kind, count(*) AS places FROM places GROUP BY kind ORDER BY kind;
