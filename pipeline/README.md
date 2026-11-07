# pipeline

ベースデータの前処理を置く（トラック A）。
入力、出力、検証の内容は [docs/design/base-data.md](../docs/design/base-data.md) に書いてある。

## 使う道具

- DuckDB CLI：版は `mise.toml` で固定している。
- tippecanoe：行政区域の PMTiles を作る。`brew install tippecanoe` で入れる。

## ディレクトリ

- `.cache/`：ダウンロードした元データ。Git に含めない。
- `out/`：生成物。Git に含めず、GitHub Release のアセットとして置く。

手順とタスクの定義は、トラック A で書く。
