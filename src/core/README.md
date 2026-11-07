# core

純関数だけを置く層。
DOM、ネットワーク、ストレージ、時刻、乱数を直接使わない。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。

- `data/schema.ts`：前処理の生成物の契約（ファイル名、列名、年次）
- `mesh/`：メッシュコードと緯度経度の変換
- `result.ts`：想定内の失敗を値で返すための型
