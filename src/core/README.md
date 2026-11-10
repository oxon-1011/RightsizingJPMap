# core

純関数だけを置く層。
DOM、ネットワーク、ストレージ、時刻、乱数を直接使わない。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。

- `data/schema.ts`：前処理の生成物の契約（ファイル名、列名、年次）
- `result.ts`：想定内の失敗を値で返すための型
- `mesh/`：メッシュコードと緯度経度の変換（`mesh-code.ts`）と、deck.gl の SolidPolygonLayer に渡す四角形の頂点の生成（`geometry.ts`）
- `indicators/`：指標の定義（使える年、読む列）と計算。メッシュは列から Float32Array を、行政区域は団体コードから値への対応を作る
- `classify/`：階級区分と配色の表（`scales.ts`）、値から階級への変換と凡例の段（`classify.ts`）、色の型（`color.ts`）
- `render/`：地図に渡す描画の指定。メッシュの頂点ごとの色、行政区域の団体コードと色の対応、自前データの点、線、面のレイヤー
- `accept/`：自前データの受け入れ検査（D12、D13）。CSV と Parquet の結合用の列（`table.ts`）、GeoJSON（`geojson.ts`）、拡張子の判定（`file.ts`）、違反の位置と表示用の番号（`violation.ts`）
- `join/`：結合の集計。メッシュと団体コードごとの件数と合計（`aggregate.ts`）、人口あたりの値（`per-population.ts`）、点を行政区域に割り当てる結果の型と、読み込む都道府県の選択（`admin.ts`）
- `places/`：場所への移動の候補の検索と、`places.json` の検査
- `hover/`：ホバーのカードの中身。ポインタの下のもの（経緯度、市区町村の団体コード、自前データの地物）と、app が持つ塗り分けの値から、カードに出す値を決める。メッシュはポインタの経緯度からメッシュコードを計算して値を引く
- `state/`：画面の状態と、操作を受け取る更新関数。app のストアはこれを呼ぶ
- `storage/`：OPFS の目録（`manifest.json`）の型、検査、目録にないファイル名の算出

外から来たデータ（JSON、io が読んだ列）は、各モジュールの `parse〜` か `check〜` で検査してから使う。
