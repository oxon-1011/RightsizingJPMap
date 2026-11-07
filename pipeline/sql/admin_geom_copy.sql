-- 都道府県ごとに admin_geom/<2桁の都道府県コード>.parquet を書く SQL を組み立てて出力する。
-- build.sh がこの出力を別の DuckDB に流す。
--
-- GeoParquet 1.1 のメタデータ（geo）を自分で書く。DuckDB 2.0 が自動で書くのは 1.0.0 で、
-- bbox の列（covering）を宣言しないためである。
-- crs は省く（OGC:CRS84 とみなされる）。N03 の JGD2011 と WGS84 の差は1m未満で、
-- 利用者の点（WGS84 の経度緯度）と CRS をそろえておけば、DuckDB で ST_Contains にそのまま渡せる。

LOAD spatial;

SELECT format(
  'SET VARIABLE pref_code = ''{}'';' || chr(10) ||
  'SET VARIABLE geo = ''{}'';' || chr(10) ||
  'COPY (SELECT code, name, ST_AsWKB(geom) AS geometry, bbox FROM admin_geom '
    || 'WHERE pref_code = getvariable(''pref_code'') ORDER BY code) '
    || 'TO (getvariable(''out_dir'') || ''/admin_geom/'' || getvariable(''pref_code'') || ''.parquet'') '
    || '(FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19, KV_METADATA {{geo: getvariable(''geo'')}});',
  pref_code,
  json_object(
    'version', '1.1.0',
    'primary_column', 'geometry',
    'columns', json_object(
      'geometry', json_object(
        'encoding', 'WKB',
        'geometry_types', ['MultiPolygon'],
        'bbox', [xmin, ymin, xmax, ymax],
        'covering', json_object(
          'bbox', json_object(
            'xmin', ['bbox', 'xmin'], 'ymin', ['bbox', 'ymin'],
            'xmax', ['bbox', 'xmax'], 'ymax', ['bbox', 'ymax']
          )
        )
      )
    )
  )
)
FROM admin_geom_index
ORDER BY pref_code;
