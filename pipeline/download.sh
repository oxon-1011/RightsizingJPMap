#!/usr/bin/env bash
# GitHub Release（data-<版>）から生成物を取り出し、指定したディレクトリに展開する（pipeline/README.md）。
#
# 使い方:
#   bash pipeline/download.sh pipeline/out    開発用。前処理を流さずに pipeline/out/ に置く
#   bash pipeline/download.sh --site dist     デプロイ用。dist/data/<版>/ に置く
#
# 版は src/core/data/schema.ts の DATA_VERSION から読む。置き場所に同じ名前のファイルがあれば止まる。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -nE 's/^export const DATA_VERSION = "([^"]+)";$/\1/p' "$root/src/core/data/schema.ts")
if [[ -z $version ]]; then
  echo "src/core/data/schema.ts から DATA_VERSION を読めなかった" >&2
  exit 1
fi

if [[ ${1:-} == --site ]]; then
  dest="${2:?サイトのディレクトリ（dist など）を指定する}/data/$version"
else
  dest="${1:?置き場所のディレクトリを指定する}"
fi

mkdir -p "$dest"
gh release download "data-$version" --dir "$dest"
cd "$dest"
shasum -a 256 -c SHA256SUMS
tar -xf admin_geom.tar
rm admin_geom.tar SHA256SUMS
echo "data-$version を $dest に取り出した"
