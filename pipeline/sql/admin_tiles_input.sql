-- admin.pmtiles の入力にする GeoJSONSeq（1行1地物）を書き出す。
-- レイヤーは pref と muni（src/core/data/schema.ts の ADMIN_TILE_LAYERS）、
-- 属性は code と name で、code は5桁の文字列（ADMIN_TILE_CODE_PROPERTY）。
-- 所属未定地は市区町村の単位を持たないので muni に入れず、pref にだけ含める。

LOAD spatial;
-- 座標は経度、緯度の順で扱う（DuckDB 2.0 では明示が要る）
SET geometry_always_xy = true;

-- N03 の測地系は JGD2011 である。WGS84 との差は1m未満なので、変換せずに経度緯度として書く。
COPY (
  SELECT code, name, ST_SetCRS(geom::GEOMETRY, 'OGC:CRS84') AS geom
  FROM prefs ORDER BY code
) TO (getvariable('work_dir') || '/pref.geojsonl')
  WITH (FORMAT gdal, DRIVER 'GeoJSONSeq', LAYER_CREATION_OPTIONS 'COORDINATE_PRECISION=7');

COPY (
  SELECT code, name, ST_SetCRS(geom::GEOMETRY, 'OGC:CRS84') AS geom
  FROM units ORDER BY code
) TO (getvariable('work_dir') || '/muni.geojsonl')
  WITH (FORMAT gdal, DRIVER 'GeoJSONSeq', LAYER_CREATION_OPTIONS 'COORDINATE_PRECISION=7');
