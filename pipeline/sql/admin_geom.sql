-- admin_geom/index.json を書き、都道府県ごとの GeoParquet の元になる表を作る。
-- ポリゴンは admin_units.sql で被覆を保ったまま簡略化したもの（許容差 0.0002 度）。
-- 都道府県ごとの書き出しは、admin_geom_copy.sql が組み立てる COPY 文で行う。

LOAD spatial;

CREATE OR REPLACE TABLE admin_geom AS
SELECT
  pref_code, code, name, geom,
  {xmin: ST_XMin(geom), ymin: ST_YMin(geom), xmax: ST_XMax(geom), ymax: ST_YMax(geom)} AS bbox
FROM units_simplified;

-- 都道府県ごとの範囲。小数5桁（約1m）に外向きに丸める
CREATE OR REPLACE TABLE admin_geom_index AS
SELECT
  pref_code,
  min(bbox.xmin) AS xmin, min(bbox.ymin) AS ymin, max(bbox.xmax) AS xmax, max(bbox.ymax) AS ymax,
  [floor(min(bbox.xmin) * 1e5) / 1e5, floor(min(bbox.ymin) * 1e5) / 1e5,
   ceil(max(bbox.xmax) * 1e5) / 1e5, ceil(max(bbox.ymax) * 1e5) / 1e5] AS bbox
FROM admin_geom
GROUP BY pref_code;

-- AdminGeomIndex：2桁の都道府県コードから [西, 南, 東, 北] への対応
COPY (
  SELECT '{' || string_agg(to_json(pref_code) || ':' || to_json(bbox), ',' ORDER BY pref_code) || '}'
  FROM admin_geom_index
) TO (getvariable('out_dir') || '/admin_geom/index.json')
  (FORMAT csv, HEADER false, QUOTE '', ESCAPE '');
