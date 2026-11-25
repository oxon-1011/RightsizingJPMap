-- 都道府県ごとに mesh_pref/<2桁の都道府県コード>.parquet を書く SQL を組み立てて出力する。
-- build.sh がこの出力を別の DuckDB に流す。
--
-- 列は mesh_indicators.parquet と同じにし、行をその都道府県のメッシュに絞るだけにする。
-- 行はメッシュコードの順に並べる（フロントは、この順を前提に複数の都道府県のファイルを合わせる）。

SELECT format(
  'COPY (SELECT m.* FROM mesh_indicators m '
    || 'WHERE m.mesh IN (SELECT mesh FROM mesh_pref_member WHERE pref_code = ''{}'') ORDER BY m.mesh) '
    || 'TO (getvariable(''out_dir'') || ''/mesh_pref/{}.parquet'') '
    || '(FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19);',
  pref_code, pref_code
)
FROM (SELECT DISTINCT pref_code FROM mesh_pref_member)
ORDER BY pref_code;
