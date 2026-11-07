# テスト用のデータ

テストで読む小さなデータを置く。
前処理（トラック A）が、生成物から鳥取県の分を、列を変えずに行だけ絞って書き出している。

| ファイル | 内容 |
|---|---|
| `mesh_indicators.tottori.parquet` | 鳥取県の市町村の `shicode` を持つメッシュ（県境のメッシュを含む）の `mesh_indicators.parquet`。1,763 行 |
| `municipal_indicators.tottori.parquet` | 鳥取県（`31000`）と県内の 19 市町村の `municipal_indicators.parquet`。7 時点で 140 行 |

列構成は `src/core/data/schema.ts` の契約に従い、生成物と同じである。
`mise run pipeline:fixtures` で `pipeline/out/` の生成物から書き出し直し、生成物と列と行が一致することを確かめる（`pipeline/checks/fixtures.sql`）。
