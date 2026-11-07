#!/usr/bin/env bash
# ベースデータの生成物を作り、検証する。手順は pipeline/README.md に書いてある。
#
# 使い方：pipeline/build.sh [段階...]
#   段階を省くと all（fetch から check まで）を流す。
#   fetch      N03 の 2024 年版を取得して展開する
#   mesh       mesh_indicators.parquet
#   municipal  municipal_indicators.parquet
#   admin      行政区域のポリゴンをまとめる（作業用のデータベース）
#   tiles      admin.pmtiles
#   admin_geom admin_geom/<都道府県コード>.parquet と admin_geom/index.json
#   places     places.json
#   check      pipeline/checks/ の検証をすべて流す
#   fixtures   tests/fixtures/ に鳥取県の分を書き出し、検証する
#   clean      生成物と作業用のファイルを消す（取得した N03 は残す）
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$PIPELINE_DIR")"
SQL_DIR="$PIPELINE_DIR/sql"
CHECK_DIR="$PIPELINE_DIR/checks"
CACHE_DIR="$PIPELINE_DIR/.cache"
WORK_DIR="$CACHE_DIR/work"
OUT_DIR="$PIPELINE_DIR/out"
FIXTURES_DIR="$ROOT_DIR/tests/fixtures"
POPULATION_DIR="${POPULATION_DIR:-$HOME/Downloads/population}"

DUCKDB_VERSION="v2.0.0"
N03_URL="https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-20240101_GML.zip"
N03_ZIP="$CACHE_DIR/N03-20240101_GML.zip"
N03_SHA256="a03111be0fe726ff270cbc1dd16f38bc926cf814e67c8cd2e52157629d138b98"
N03_DIR="$CACHE_DIR/n03"
N03_SHP="$N03_DIR/N03-20240101.shp"
ADMIN_DB="$WORK_DIR/admin.duckdb"

# DuckDB の出力を、AI エージェント向けの表示ではなく通常の表示にする
export DUCKDB_AGENT_MODE=0

log() { printf '\n== %s\n' "$*"; }
die() { printf 'エラー：%s\n' "$*" >&2; exit 1; }

require_tools() {
  command -v duckdb >/dev/null || die "duckdb がない。mise install で入れる"
  local version
  version="$(duckdb -version | awk '{print $1}')"
  [[ "$version" == "$DUCKDB_VERSION" ]] ||
    die "DuckDB CLI は $DUCKDB_VERSION を使う（いまは $version）。mise run 経由で動かす"
  command -v tippecanoe >/dev/null || die "tippecanoe がない。brew install tippecanoe で入れる"
  command -v tippecanoe-decode >/dev/null || die "tippecanoe-decode がない"
  [[ -d "$POPULATION_DIR/mlit_pop_proj_mesh1km_base2020" ]] ||
    die "推計の Parquet が見つからない：$POPULATION_DIR（環境変数 POPULATION_DIR で指定する）"
  # SQL の文字列リテラルに埋め込むので、引用符を含むパスは受け付けない
  local p
  for p in "$POPULATION_DIR" "$PIPELINE_DIR"; do
    [[ "$p" != *"'"* ]] || die "パスに ' を含めない：$p"
  done
}

# duck <データベース> <SQL ファイル>
# パスは SQL の変数として渡す。SQL の側では getvariable('out_dir') のように読む。
duck() {
  local db="$1" file="$2"
  echo "-- $(basename "$file")"
  duckdb -bail -batch -no-init "$db" \
    -cmd "SET enable_progress_bar = false;
SET temp_directory = '$WORK_DIR/tmp';
SET VARIABLE population_dir = '$POPULATION_DIR';
SET VARIABLE n03_shp = '$N03_SHP';
SET VARIABLE out_dir = '$OUT_DIR';
SET VARIABLE work_dir = '$WORK_DIR';
SET VARIABLE fixtures_dir = '$FIXTURES_DIR';" \
    -f "$file"
}

stage_fetch() {
  log "fetch：N03 の 2024 年版"
  mkdir -p "$CACHE_DIR"
  if [[ ! -f "$N03_ZIP" ]]; then
    curl -fL --retry 3 -o "$N03_ZIP.part" "$N03_URL"
    mv "$N03_ZIP.part" "$N03_ZIP"
  fi
  local sum
  sum="$(shasum -a 256 "$N03_ZIP" | awk '{print $1}')"
  [[ "$sum" == "$N03_SHA256" ]] || die "N03 の SHA-256 が一致しない：$sum"
  if [[ ! -f "$N03_SHP" ]]; then
    rm -rf "$N03_DIR"
    mkdir -p "$N03_DIR"
    unzip -q -o "$N03_ZIP" 'N03-20240101.shp' 'N03-20240101.shx' 'N03-20240101.dbf' \
      'N03-20240101.prj' 'N03-20240101.cpg' -d "$N03_DIR"
  fi
  echo "$N03_SHP"
}

stage_mesh() {
  log "mesh：mesh_indicators.parquet"
  duck :memory: "$SQL_DIR/mesh_indicators.sql"
}

stage_municipal() {
  log "municipal：municipal_indicators.parquet"
  duck :memory: "$SQL_DIR/municipal_indicators.sql"
}

stage_admin() {
  log "admin：行政区域のポリゴン"
  [[ -f "$OUT_DIR/municipal_indicators.parquet" ]] || die "先に municipal を流す"
  [[ -f "$N03_SHP" ]] || die "先に fetch を流す"
  rm -f "$ADMIN_DB" "$ADMIN_DB.wal"
  duck "$ADMIN_DB" "$SQL_DIR/admin_units.sql"
}

stage_tiles() {
  log "tiles：admin.pmtiles"
  [[ -f "$ADMIN_DB" ]] || die "先に admin を流す"
  rm -f "$WORK_DIR/pref.geojsonl" "$WORK_DIR/muni.geojsonl" "$OUT_DIR/admin.pmtiles"
  duck "$ADMIN_DB" "$SQL_DIR/admin_tiles_input.sql"
  # 隣り合う区域の境界を同じ形に簡略化し、隙間ができないようにする。
  # 全ズームで全区域を残すため、小さなポリゴンの間引きと、地物の数とタイルの大きさの上限を外す。
  # PMTiles のメタデータに手元の絶対パスが入らないよう、作業用のディレクトリから相対パスで渡す。
  (
    cd "$WORK_DIR"
    tippecanoe --quiet --force --read-parallel \
      --output=../../out/admin.pmtiles \
      --name="RightsizingJPMap admin" \
      --attribution="国土数値情報（行政区域データ N03 2024年）を加工して作成" \
      --minimum-zoom=0 --maximum-zoom=10 \
      --no-simplification-of-shared-nodes \
      --no-tiny-polygon-reduction \
      --no-feature-limit --no-tile-size-limit \
      --named-layer=pref:pref.geojsonl \
      --named-layer=muni:muni.geojsonl
  )
  ls -l "$OUT_DIR/admin.pmtiles"
}

stage_admin_geom() {
  log "admin_geom：都道府県ごとの GeoParquet と index.json"
  [[ -f "$ADMIN_DB" ]] || die "先に admin を流す"
  rm -rf "$OUT_DIR/admin_geom"
  mkdir -p "$OUT_DIR/admin_geom"
  duck "$ADMIN_DB" "$SQL_DIR/admin_geom.sql"
  # 都道府県ごとの COPY 文を SQL で組み立ててから流す（ファイルごとに範囲のメタデータが変わるため）
  duckdb -bail -batch -no-init -readonly -list -noheader "$ADMIN_DB" \
    -cmd "SET VARIABLE out_dir = '$OUT_DIR';" \
    -f "$SQL_DIR/admin_geom_copy.sql" > "$WORK_DIR/admin_geom_copy.generated.sql"
  duck "$ADMIN_DB" "$WORK_DIR/admin_geom_copy.generated.sql"
  du -sh "$OUT_DIR/admin_geom"
}

stage_places() {
  log "places：places.json"
  [[ -f "$ADMIN_DB" ]] || die "先に admin を流す"
  duck "$ADMIN_DB" "$SQL_DIR/places.sql"
}

stage_check() {
  log "check：生成物の検証"
  # tiles の検証のため、PMTiles の z0、z1、z5、z10 を戻し、地物ごとのズーム、レイヤー、属性を TSV に抜き出す。
  # tippecanoe-decode は、タイルとレイヤーの見出しと地物を1行ずつ出力する。
  # 抜き出し漏れがないことは、checks/admin.sql で統計（--stats）の地物の数と突き合わせて確かめる。
  local zr
  : > "$WORK_DIR/tiles_properties.tsv"
  for zr in "0 1" "5 5" "10 10"; do
    set -- $zr
    tippecanoe-decode -Z "$1" -z "$2" "$OUT_DIR/admin.pmtiles" | LC_ALL=C awk '
      /^\{ "type": "FeatureCollection", "properties": \{ "zoom": / {
        match($0, /"zoom": [0-9]+/); zoom = substr($0, RSTART + 8, RLENGTH - 8); next }
      /^\{ "type": "FeatureCollection", "properties": \{ "layer": / {
        match($0, /"layer": "[^"]*"/); layer = substr($0, RSTART + 10, RLENGTH - 11); next }
      /^\{ "type": "Feature", / {
        match($0, /"properties": \{[^}]*\}/); print zoom "\t" layer "\t" substr($0, RSTART + 14, RLENGTH - 14) }
    ' >> "$WORK_DIR/tiles_properties.tsv"
  done
  tippecanoe-decode --stats "$OUT_DIR/admin.pmtiles" > "$WORK_DIR/tiles_stats.json"
  rm -f "$WORK_DIR"/tiles_z*.geojson
  local f
  for f in "$CHECK_DIR"/*.sql; do
    duck :memory: "$f"
  done
  log "検証はすべて通った"
}

stage_fixtures() {
  log "fixtures：tests/fixtures/ の鳥取県の分"
  duck :memory: "$SQL_DIR/fixtures.sql"
  duck :memory: "$CHECK_DIR/fixtures.sql"
}

stage_clean() {
  log "clean：生成物と作業用のファイルを消す"
  rm -rf "$OUT_DIR" "$WORK_DIR"
}

main() {
  local stages=("$@")
  [[ ${#stages[@]} -gt 0 ]] || stages=(all)
  require_tools
  mkdir -p "$OUT_DIR" "$WORK_DIR/tmp"
  local s
  for s in "${stages[@]}"; do
    case "$s" in
      all)
        stage_clean
        mkdir -p "$OUT_DIR" "$WORK_DIR/tmp"
        stage_fetch; stage_mesh; stage_municipal; stage_admin
        stage_tiles; stage_admin_geom; stage_places; stage_check
        ;;
      fetch | mesh | municipal | admin | tiles | admin_geom | places | check | fixtures | clean)
        "stage_$s"
        mkdir -p "$OUT_DIR" "$WORK_DIR/tmp"
        ;;
      check:*)
        # 1つの検証だけを流す（例：check:places）。tiles の検証は先に check を一度流しておく
        duck :memory: "$CHECK_DIR/${s#check:}.sql"
        ;;
      *) die "知らない段階：$s" ;;
    esac
  done
}

main "$@"
