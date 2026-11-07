# テスト用のデータ

テストで読む小さなデータを置く。
前処理（トラック A）が、本番と同じ列構成で鳥取県の分を書き出して置く予定である。

| ファイル | 内容 |
|---|---|
| `mesh_indicators.tottori.parquet` | 鳥取県のメッシュだけを含む `mesh_indicators.parquet` |
| `municipal_indicators.tottori.parquet` | 鳥取県と県内の市町村だけを含む `municipal_indicators.parquet` |

列構成は `src/core/data/schema.ts` の契約に従う。
置かれるまでは、テストの中で小さなデータを組み立てて使う。
