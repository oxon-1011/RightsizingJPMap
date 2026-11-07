-- 行政区域の生成物（admin_geom、admin.pmtiles）と、N03 と推計の団体コードの対応を検証する。
-- 条件を満たさないと error() で止まる。tiles の検証は build.sh が書き出した GeoJSON を読む。

INSTALL spatial;
LOAD spatial;

CREATE MACRO must(ok, msg) AS CASE WHEN ok THEN 'ok' ELSE error('検証に失敗：' || msg) END;

-- N03 の団体コード（ポリゴンは読まない）
CREATE TEMP TABLE n03 AS
SELECT N03_007 AS code, any_value(N03_004 || coalesce(N03_005, '')) AS muni, count(*) AS polygons
FROM ST_Read(getvariable('n03_shp'))
GROUP BY N03_007;

-- 推計で値を持つ、地図で塗る単位
CREATE TEMP TABLE estimate AS
SELECT DISTINCT code, name
FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet')
WHERE area_type IN ('0', '2', '3', '9');

-- 所属未定地は団体コードが 13000 のような都道府県の形で、市区町村の単位を持たない
CREATE TEMP TABLE n03_munis AS SELECT * FROM n03 WHERE code NOT LIKE '__000';
CREATE TEMP TABLE n03_only AS SELECT code, muni FROM n03_munis ANTI JOIN estimate USING (code);
CREATE TEMP TABLE estimate_only AS SELECT code, name FROM estimate ANTI JOIN n03_munis USING (code);

CREATE TEMP TABLE admin_geom AS
SELECT parse_filename(filename, true) AS file_pref, code, name, geometry, bbox
FROM read_parquet(getvariable('out_dir') || '/admin_geom/*.parquet', filename = true);

CREATE TEMP TABLE admin_geom_index AS
SELECT unnest(map_entries(j::MAP(VARCHAR, DOUBLE[]))) AS e
FROM read_json_objects(getvariable('out_dir') || '/admin_geom/index.json', format = 'unstructured') AS t(j);

SELECT 'admin: N03 にあって推計にないのは、浜通り地域の 13 市町村と北方領土の6村だけ' AS "check",
  string_agg(code || ' ' || muni, '、' ORDER BY code) AS value,
  must(
    count(*) FILTER (WHERE code LIKE '07%') = 13
    AND list(code ORDER BY code) FILTER (WHERE code NOT LIKE '07%')
        = ['01695', '01696', '01697', '01698', '01699', '01700'],
    'N03 にあって推計にない団体コードが想定と違う'
  ) AS result
FROM n03_only
UNION ALL
SELECT 'admin: 推計にあって N03 にないのは、浜通り地域（07999）だけ',
  string_agg(code || ' ' || name, '、' ORDER BY code),
  must(list(code) = ['07999'], '推計にあって N03 にない団体コードが想定と違う')
FROM estimate_only
UNION ALL
SELECT 'admin: 福島県は N03 で 59 市町村、推計で 46 市町村と浜通り地域',
  (SELECT count(*) FROM n03_munis WHERE code LIKE '07%') || ' / '
    || (SELECT count(*) FROM estimate WHERE code LIKE '07%' AND code <> '07999'),
  must(
    (SELECT count(*) FROM n03_munis WHERE code LIKE '07%') = 59
    AND (SELECT count(*) FROM estimate WHERE code LIKE '07%' AND code <> '07999') = 46,
    '福島県の市町村の数が想定と違う'
  )
UNION ALL
SELECT 'admin: 浜松市は N03 でも再編後の3区（22138〜22140）で、旧7区がない',
  (SELECT string_agg(code || ' ' || muni, '、' ORDER BY code) FROM n03 WHERE code LIKE '2213_' OR code = '22140'),
  must(
    (SELECT list(code ORDER BY code) FROM n03 WHERE code BETWEEN '22130' AND '22149')
      = ['22138', '22139', '22140'],
    'N03 の浜松市の区が想定と違う'
  )
UNION ALL
SELECT 'admin: 所属未定地（参考。団体コードと N03 のポリゴンの数）',
  (SELECT string_agg(code || ':' || polygons, '、' ORDER BY code) FROM n03 WHERE code LIKE '__000'),
  'ok';

-- admin_geom
SELECT 'admin_geom: 47 ファイルで、各ファイルにはその都道府県の区域だけがある' AS "check",
  count(DISTINCT file_pref)::VARCHAR AS value,
  must(count(DISTINCT file_pref) = 47 AND bool_and(left(code, 2) = file_pref), 'admin_geom のファイルの分け方が違う') AS result
FROM admin_geom
UNION ALL
SELECT 'admin_geom: 区域は推計の塗る単位と北方領土の6村で、重複がない（所属未定地を含まない）',
  count(*)::VARCHAR,
  must(
    count(*) = count(DISTINCT code)
    AND list(code ORDER BY code) = (
      SELECT list(code ORDER BY code) FROM (
        SELECT code FROM estimate
        UNION ALL SELECT unnest(['01695', '01696', '01697', '01698', '01699', '01700'])
      )
    ),
    'admin_geom の区域の集合が想定と違う'
  )
FROM admin_geom
UNION ALL
SELECT 'admin_geom: 浜通り地域（07999）の名前と、構成市町村が残っていないこと',
  (SELECT name FROM admin_geom WHERE code = '07999'),
  must(
    (SELECT name FROM admin_geom WHERE code = '07999') = '浜通り地域'
    AND (SELECT count(*) FROM admin_geom SEMI JOIN n03_only USING (code) WHERE code LIKE '07%') = 0,
    '浜通り地域のまとめ方が違う'
  )
UNION ALL
SELECT 'admin_geom: ジオメトリは空でない有効な MultiPolygon で、bbox の列と一致する',
  count(*)::VARCHAR,
  must(
    bool_and(ST_GeometryType(geometry) = 'MULTIPOLYGON' AND ST_IsValid(geometry) AND NOT ST_IsEmpty(geometry)
             AND bbox.xmin = ST_XMin(geometry) AND bbox.ymin = ST_YMin(geometry)
             AND bbox.xmax = ST_XMax(geometry) AND bbox.ymax = ST_YMax(geometry)),
    'admin_geom のジオメトリか bbox の列が違う'
  )
FROM admin_geom
UNION ALL
SELECT 'admin_geom: 隣り合う区域の間に隙間も重なりもない（被覆が保たれている）',
  coalesce(ST_Length(ST_CoverageInvalidEdges_Agg(geometry))::VARCHAR, '0'),
  must(ST_CoverageInvalidEdges_Agg(geometry) IS NULL, 'admin_geom の区域の間に隙間か重なりがある')
FROM admin_geom
UNION ALL
SELECT 'admin_geom: 点の割り当て（東京駅は千代田区、札幌駅は札幌市北区、浜松駅は浜松市中央区）',
  string_agg(p.label || '→' || coalesce(g.code, 'なし'), '、' ORDER BY p.label),
  must(bool_and(g.code = p.expected) AND count(g.code) = 3, '点が想定の区域に入らない')
FROM (VALUES ('東京駅', 139.767125, 35.681236, '13101'),
             ('札幌駅', 141.350755, 43.068661, '01102'),
             ('浜松駅', 137.734590, 34.703830, '22138')) AS p(label, lon, lat, expected)
LEFT JOIN admin_geom g ON ST_Contains(g.geometry, ST_Point(p.lon, p.lat))
UNION ALL
SELECT 'admin_geom: GeoParquet 1.1 のメタデータ（WKB、bbox の列を covering に宣言）',
  count(*)::VARCHAR,
  must(
    count(*) = 47
    AND bool_and(
      (decode(value)::JSON->>'version') = '1.1.0'
      AND (decode(value)::JSON->>'primary_column') = 'geometry'
      AND (decode(value)::JSON->'columns'->'geometry'->>'encoding') = 'WKB'
      AND (decode(value)::JSON->'columns'->'geometry'->'covering'->'bbox'->'xmin')::VARCHAR[] = ['bbox', 'xmin']
    ),
    'GeoParquet のメタデータが違う'
  )
FROM parquet_kv_metadata(getvariable('out_dir') || '/admin_geom/*.parquet')
WHERE key = 'geo'
UNION ALL
SELECT 'admin_geom: index.json は 47 都道府県の [西, 南, 東, 北] で、各ファイルの区域を囲む',
  count(*)::VARCHAR,
  must(
    count(*) = 47
    AND bool_and(len(i.e.value) = 4 AND i.e.value[1] <= g.xmin AND i.e.value[2] <= g.ymin
                 AND i.e.value[3] >= g.xmax AND i.e.value[4] >= g.ymax
                 AND i.e.value[3] - g.xmax < 1e-4 AND g.xmin - i.e.value[1] < 1e-4),
    'index.json の範囲が違う'
  )
FROM admin_geom_index i
JOIN (
  SELECT file_pref, min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin, max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax
  FROM admin_geom GROUP BY 1
) g ON g.file_pref = i.e.key;

-- admin.pmtiles（z0、z1、z5、z10）。build.sh が tippecanoe-decode の出力から、
-- 地物ごとのズーム、レイヤー、属性だけを抜き出した TSV と、タイルごとの地物数を読む。
-- GeoJSON をそのまま読むと z10 だけで 9GB ほどのメモリを使うため、この形にした。
CREATE TEMP TABLE tile_features AS
SELECT z, layer, p
FROM read_csv(getvariable('work_dir') || '/tiles_properties.tsv',
              delim = '\t', header = false, quote = '', escape = '',
              columns = {z: 'INTEGER', layer: 'VARCHAR', p: 'JSON'});

CREATE TEMP TABLE tile_stats AS
SELECT zoom AS z, l.key AS layer, sum(l.value.polygons) AS polygons
FROM (
  SELECT zoom, unnest(map_entries(layers)) AS l
  FROM read_json(getvariable('work_dir') || '/tiles_stats.json',
                 columns = {zoom: 'INTEGER', layers: 'MAP(VARCHAR, STRUCT(polygons BIGINT))'})
)
GROUP BY ALL;

SELECT 'tiles: 抜き出した地物の数が、tippecanoe-decode の統計の地物の数と一致する' AS "check",
  (SELECT string_agg(z || ' ' || layer || ':' || polygons, '、' ORDER BY z, layer) FROM tile_stats
   WHERE z IN (0, 1, 5, 10)) AS value,
  must(
    (SELECT list(z || layer || n ORDER BY z, layer) FROM (SELECT z, layer, count(*) AS n FROM tile_features GROUP BY ALL))
    = (SELECT list(z || layer || polygons ORDER BY z, layer) FROM tile_stats WHERE z IN (0, 1, 5, 10)),
    'タイルの地物を抜き出しきれていない'
  ) AS result
UNION ALL
SELECT 'tiles: レイヤーは pref と muni だけで、属性は code（5桁の文字列）と name',
  string_agg(DISTINCT layer, '、')::VARCHAR AS value,
  must(
    list_sort(list(DISTINCT layer)) = ['muni', 'pref']
    AND bool_and(list_sort(json_keys(p)) = ['code', 'name']
                 AND json_type(p->'code') = 'VARCHAR' AND regexp_full_match(p->>'code', '[0-9]{5}')),
    'タイルのレイヤーか属性が契約と違う'
  ) AS result
FROM tile_features
UNION ALL
SELECT 'tiles: z1、z5、z10 の pref に 47 都道府県（01000 の形）がそろう',
  string_agg(z || ':' || n, '、' ORDER BY z),
  must(count(*) = 3 AND bool_and(n = 47 AND all_pref_form), 'タイルの都道府県がそろっていない')
FROM (SELECT z, count(DISTINCT p->>'code') AS n, bool_and((p->>'code') LIKE '__000') AS all_pref_form
      FROM tile_features WHERE layer = 'pref' AND z IN (1, 5, 10) GROUP BY z)
UNION ALL
SELECT 'tiles: z1、z5、z10 の muni に admin_geom と同じ区域がそろう',
  string_agg(z || ':' || n, '、' ORDER BY z),
  must(count(*) = 3 AND bool_and(same), 'タイルの市区町村がそろっていない')
FROM (
  SELECT z, count(DISTINCT p->>'code') AS n,
    list(DISTINCT p->>'code' ORDER BY p->>'code') = (SELECT list(code ORDER BY code) FROM admin_geom) AS same
  FROM tile_features WHERE layer = 'muni' AND z IN (1, 5, 10) GROUP BY z
);
