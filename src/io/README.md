# io

副作用を置く層。
hyparquet、DuckDB-WASM、OPFS、Web Locks、MapLibre、deck.gl の呼び出しを、判断を持たない薄い関数で包む。
ライブラリが投げる例外は、ここで `Result` に変換して返す。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。
