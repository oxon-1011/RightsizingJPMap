# io

副作用を置く層。
hyparquet、DuckDB-WASM、OPFS、Web Locks、MapLibre、deck.gl の呼び出しを、判断を持たない薄い関数で包む。
ライブラリが投げる例外は、ここで `Result` に変換して返す。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。

## アダプタの一覧

| ファイル | 包むもの | 主な関数 |
|---|---|---|
| `parquet.ts` | hyparquet、hyparquet-compressors | `openParquetUrl`、`openParquetBuffer`、`readParquetColumns` |
| `duckdb.ts` | DuckDB-WASM | `startDuckDb`、`stopDuckDb`、`registerFile`、`dropFile`、`query`、`readFileBytes`、`loadSpatial` |
| `opfs.ts` | OPFS、`navigator.storage` | `openStorage`、`openMemoryStorage`、`requestPersistence`、`isPersisted` |
| `tabs.ts` | Web Locks、BroadcastChannel | `acquireWriterLock`、`openManifestChannel` |

地図のアダプタ（MapLibre と deck.gl）は、core の描画の指定が決まってから Phase 2 で足す。

### parquet.ts

`openParquetUrl` は先頭の2バイトの Range リクエストで大きさを知り、末尾のメタデータだけを Range リクエストで取得する。
HEAD リクエストは使わない。
GitHub Pages は、gzip を受け付ける要求に gzip で返し、HEAD の Content-Length も圧縮後の大きさになるからである。
ブラウザは Range を付けた要求には `Accept-Encoding: identity` を付けるので、Range リクエストの応答は圧縮されない。
Range リクエストに 206 が返らないサーバーでは、全体を読まずに `range-not-supported` を返す。
返した `ParquetFile` を `readParquetColumns` に何度渡しても、メタデータは読み直さない。
列は `src/core/data/schema.ts` の `ColumnArray` に変換して返す。

列の型は、DuckDB の型の名前（`UINTEGER`、`VARCHAR` など）に読み替えて `ParquetFile.columns` で返す。
`ColumnArray` に変換できない型は `unsupported` とし、その列は読まない。
数値の NULL は NaN にする。
UINTEGER、BOOLEAN、VARCHAR の列は NULL を表せないので、NULL があれば最初の行の番号を付けて失敗を返す。

### duckdb.ts

本体と wasm は、`startDuckDb` を初めて呼んだときに動的 import で読み込む。
渡す bundle はシングルスレッドの mvp と eh だけで、COOP と COEP のヘッダなしで動く（D4）。
`startDuckDb` は呼ぶたびに Worker を起動するので、使い回すときは呼び出し側で結果を持つ。

`query` は結果を、列ごとの名前、Arrow の型の名前、値の配列にして返す。
BIGINT と DECIMAL は DOUBLE に変換して受け取るので、値に BigInt は入らない。
DuckDB の型の名前が要るときは、`DESCRIBE` を問い合わせる。

`registerFile` は、Blob（利用者が選んだ File など）なら DuckDB が Worker の中で必要な部分だけを読む形で、バイト列なら複製して登録する。
DuckDB-WASM は受け取った ArrayBuffer を Worker に移し、呼び出し側では使えなくするからである。

`loadSpatial` は `LOAD spatial` を実行する。
DuckDB-WASM では INSTALL は要らず、LOAD が拡張（v1.5.4 の eh で約 23.6MB）を extensions.duckdb.org から取得する。
取得の進み具合は分からないので、呼び出し側は完了を待つ間、進み具合の分からない表示を出す。

`startDuckDb` は、起動の直後に `enable_geoparquet_conversion` を切る。
v1.5.4 では、spatial 拡張を読み込んだあとに `geo` メタデータを持つ Parquet（admin_geom など）を読むと、`stoi: no conversion` で失敗するからである。
そのため GeoParquet の `geometry` 列は BLOB（WKB）として読まれる。
SQL では `ST_GeomFromWKB(geometry)` を通して使う。

### opfs.ts

`openStorage` は、OPFS が使えれば `/rjm/` の下を使う置き場所を、使えなければメモリ上の置き場所を返す。
どちらになったかは `kind` で、メモリ上になった理由は `reason` で分かる。
メインスレッドから書き込む `createWritable` がない環境も、メモリ上で動かす。

目録は文字列として、データのファイルはバイト列として読み書きする。
目録の中身の検査と、目録にないファイルの判定は core が行い、ここでは名前を受け取って消すだけにする。
目録をまだ書いていなければ、`readManifest` は null を返す。

### tabs.ts

`acquireWriterLock` は、`rjm-writer` のロックを待たずに取りにいく。
取れなければ `role` が `reader` になり、同じロックを待ち続け、ロックが渡ると `onPromoted` を呼ぶ。
`release` が返す Promise は、ロックを放し終えたときに解決する。

`openManifestChannel` は、目録の更新を `rjm-manifest` のチャンネルで知らせる。
通知は同じ名前で開いたほかのチャンネルに届き、送ったチャンネル自身には届かない。

## CSV の結合用の列を文字列で読む方法

DuckDB-WASM（v1.5.4）の `read_csv` で確かめた挙動は次のとおりである。
どれも `duckdb.browser.test.ts` で検査している。

- 型の推定に任せると、先頭が 0 でない団体コードとメッシュコードの列は BIGINT になる。先頭が 0 の値を含む列は VARCHAR になる。
- `types = {'code': 'VARCHAR'}` で列の型を固定できる。ただし、ファイルにない列の名前を書くと Binder Error になる。
- そのため、先に `DESCRIBE SELECT * FROM read_csv(...)` で列名を得て、あった結合用の列だけを `types` に書く。指定しなかった列は推定の型のまま読める。
- `all_varchar = true` は、属性の列も含めてすべてを VARCHAR にする。
- BOM 付きの UTF-8 は読め、列名に BOM は残らない。1列目の名前で `types` を指定できる。
- Shift_JIS の列名や値はエラーになる。ただし、型の推定の範囲（20,480 行）より後ろにある場合は、`LIMIT` 付きの読み込みや `DESCRIBE` ではエラーにならず、全行を読んだときに初めてエラーになる。

## テスト

OPFS、Web Locks、DuckDB-WASM はブラウザでしか動かないので、`*.browser.test.ts` に分け、Vitest のブラウザモード（Playwright の Chromium）で実行する。

```bash
pnpm exec playwright install chromium   # 初回だけ
pnpm test:browser
```

`pnpm test` と `pnpm check` は node のテストだけを実行し、ブラウザのテストを含まない。
CI では、ブラウザのテストを別のジョブ（`.github/workflows/ci.yml` の `browser`）で実行する。
spatial 拡張のテストは extensions.duckdb.org から拡張を取得するので、ネットワークが要る。
