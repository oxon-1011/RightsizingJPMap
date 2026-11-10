# app

core と io をつなぐ手続きと、状態の置き場所（Zustand のストア）を置く層。
io を呼んでよいのはこの層だけである。
状態の形と更新関数は core に置き、ここではそれを呼ぶ。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。

## ファイルの一覧

| ファイル | 内容 |
|---|---|
| `store.ts` | ストア。core の `reduce` で `state` を更新し、手続きの結果を `runtime` に持つ |
| `create-app.ts` | 画面が呼ぶ手続きをまとめた `createApp`。起動、地図の描画、取り込み、削除、表示の変更、場所への移動 |
| `instance.ts` | 画面全体で1つの `app` と、React の部品でストアを読む `useAppStore` |
| `ports.ts` | 手続きが使う副作用の口の型（`AppPorts`）。テストでは偽物を渡す |
| `browser-ports.ts` | ブラウザの `AppPorts` を io の関数で作る。最初に映す範囲（`INITIAL_BOUNDS`）もここに置く |
| `persistence.ts` | 目録とデータのファイルを書く順序と排他 |
| `import.ts` | 取り込むファイルを読み、受け入れ条件を検査して、目録の項目を作る |
| `duckdb-engine.ts` | DuckDB-WASM で表を読み、正規化した Parquet を書き、点を行政区域に割り当てる |
| `sql.ts` | `duckdb-engine.ts` が使う SQL の組み立て（純粋な関数） |
| `base-data.ts` | 生成物の Parquet と JSON の読み込みと、読んだ列の持ち回り |
| `datasets.ts` | OPFS から読み直した自前データと、結合の集計の持ち回り |
| `assign.ts` | 点を行政区域に割り当てる手続き（読む都道府県の選択と、spatial 拡張の呼び出し） |
| `choropleth.ts` | いまの単位、指標、年の塗り分けの値と階級区分 |
| `overlays.ts` | 自前データの点、線、面のレイヤーの指定 |
| `links.ts` | 画面から開く `docs/user/` の GitHub 上の URL |
| `data-url.ts` | 生成物と `public/` のファイルの URL |

## 段階 7 での使い方

`instance.ts` の `app` を使う。
`app` は作るだけでは何も読まず、読み込みは `boot` と `attachMap` から始まる。

```tsx
// main.tsx：描く前に起動を始める（置き場所、書き込みのロック、目録）
import { app } from "./app/instance";
void app.boot();

// App.tsx
import { app, useAppStore } from "../app/instance";
import { ACCEPTANCE_URL } from "../app/links";

const state = useAppStore((s) => s.state);
const runtime = useAppStore((s) => s.runtime);

// 地図の要素の ref。部品の外に置き、描き直しで地図を作り直さないようにする。
// React 19 の ref の後片付けで、StrictMode の2回のつなぎ直しにも対応する
const attachMapElement = (el: HTMLDivElement | null) => {
  if (el === null) return undefined;
  void app.attachMap(el);
  return () => app.detachMap();
};

<div ref={attachMapElement} className="size-full" />
```

地図の要素には `absolute` を付けない。
MapLibre の CSS（`.maplibregl-map` の `position: relative`）は Tailwind のレイヤーの外にあるので、Tailwind の `absolute` より強い。

`useAppStore` の selector は、`s.state` や `s.runtime` のようにストアにある値をそのまま返す。
呼ぶたびに新しいオブジェクトを返す selector を渡すと、Zustand 5 では描き直しが止まらなくなる。

部品の props と、渡す値と手続きの対応は次のとおりである。

| 部品 | 値 | 操作 |
|---|---|---|
| `IndicatorPanel` | `state.unit`、`state.indicator`、`state.datasets`、`runtime.joinedClassification` | `app.dispatch({ type: "indicator-selected", indicator })`、`app.dispatch({ type: "unit-selected", unit })` |
| `YearSlider` | `trackYears(state.unit)`、`selectableYears(state.unit, state.indicator)`、`state.year` | `app.dispatch({ type: "year-selected", year })` |
| `AddDataButton` | なし | `app.importFiles(files)` |
| `DropOverlay` | ドラッグの深さ（画面の中の状態） | drop のファイルを `app.importFiles(files)` |
| `NoticeList` | `state.notices`、`ACCEPTANCE_URL` | `app.dispatch({ type: "notice-dismissed", id })` |
| `LayerPanel` | `state.datasets` | `app.changeDatasetStyle(id, style)`、`app.removeDataset(id)`、確かめてから `app.clearDatasets()` |
| `PlaceSearch` | `runtime.places` の索引から core の `searchPlaces` で作った候補、`runtime.places.kind === "loading"` | 開くときに `app.loadPlaces()`、選んだら `app.moveToPlace(place)` |

`app.dispatch` が受け付けるのは、単位、年、指標の切り替えと、通知を閉じる操作だけである（`UiAction`）。
データの追加と削除は目録を書くので、`importFiles`、`removeDataset`、`clearDatasets` を通す。
単位、年、指標、データが変わると、`app` がストアの購読から地図を描き直すので、部品から描画を呼ぶ必要はない。

場所の入力欄の開閉、入力、選んでいる候補の番号は、画面の中の状態として `App.tsx` に置く。
候補は `app.placeCandidates(query)` で作らず、`runtime.places` から作る。
React Compiler は描くときに呼ぶ関数を純粋とみなし、`app.placeCandidates(query)` の結果を query だけで使い回す（babel-plugin-react-compiler 1.0.0 の出力で確かめた、2026-11-10）。
そのため、入力欄を開いてすぐに文字を入れると、places.json を読み終えても候補が空のまま残る。

`runtime` には次の値がある。

- **`joinedClassification`**：自前データの指標の凡例の区切り。ベースデータの指標では null。
- **`storage`**：`opfs` か `memory`。`memory` のときは、core の通知（`storage-unavailable`）も出る。
- **`places`**：places.json の読み込みの状態（`idle`、`loading`、`ready`、`failed`）。
- **`importing`**：取り込みの途中か。DuckDB-WASM の起動（初回は wasm の取得）を含む。
- **`assigningPoints`**：点を行政区域に割り当てている途中か。初回は spatial 拡張（約 23.6MB）を取得する。

## 手続きと、呼ぶ io と core

| 手続き | io | core |
|---|---|---|
| `boot` | `openStorage`、`openManifestChannel`、`acquireWriterLock`、`DatasetStorage` の `readManifest`、`listDatasets`、`removeDataset` | `parseManifest`、`orphanDatasetFiles`、`reduce`（`access-changed`、`datasets-loaded`、`notified`） |
| ほかのタブからの通知 | `ManifestChannel` の `subscribe` | `canWrite`、`parseManifest`、`reduce`（`datasets-loaded`） |
| ロックが渡ったとき | `listDatasets`、`removeDataset` | `reduce`（`access-changed`）、`orphanDatasetFiles` |
| `attachMap` と描き直し | `startMap`、`setAdminFill`、`setOverlayLayers`、`openParquetUrl`、`readParquetColumns`、`openParquetBuffer`、`parseOverlayGeoJson` | `meshColumnsToRead`、`computeMeshIndicator`、`parseMunicipalTable`、`computeMunicipalIndicator`、`classificationOf`、`buildMeshGeometry`、`meshLayerSpec`、`adminFillSpec`、`pointLayerSpec`、`geoJsonLayerSpec` |
| 自前データの指標 | 上に加えて `readDataset` | `aggregateByMesh`、`aggregatePointsByMesh`、`aggregateByCode`、`measureValues`、`completeCodeValues`、`perPopulationByMesh`、`perPopulationByCode`、`indexMeshes`、`joinedClassification`、`checkGeoJson` |
| 点から行政区域への割り当て | `fetchBytes`（admin_geom）、`startDuckDb`、`loadSpatial`、`registerFile`、`query`、`dropFile` | `parseAdminGeomIndex`、`prefecturesForPoints` |
| `importFiles` | `startDuckDb`、`registerFile`、`query`、`readFileBytes`、`dropFile`、`writeDataset`、`writeManifest`、`ManifestChannel` の `notify`、`isPersisted`、`requestPersistence` | `canWrite`、`detectFormat`、`isLargeFile`、`planTableJoin`、`checkTableValues`、`paintedMunicipalCodes`、`checkGeoJson`、`newDatasetEntry`、`addDataset`、`serializeManifest`、`reduce`（`dataset-added`、`notified`） |
| `removeDataset` | `writeManifest`、`removeDataset`、`notify` | `removeDataset`、`datasetFileName`、`reduce`（`dataset-removed`） |
| `clearDatasets` | `writeManifest`、`clear`、`notify` | `EMPTY_MANIFEST`、`reduce`（`datasets-cleared`） |
| `changeDatasetStyle` | `writeManifest`、`notify`（書けるタブだけ） | `updateDatasetStyle`、`reduce`（`dataset-style-changed`） |
| `loadPlaces`、`placeCandidates`、`moveToPlace` | `fetchBytes`（places.json）、`fitBBox` | `parsePlaces`、`buildPlaceIndex`、`searchPlaces` |

生成物の JSON と admin_geom の都道府県のファイルは io の `fetchBytes` で、利用者のファイルは `readBlobBytes` で全体を読む。

## 決めたこと

### CSV の読み方

CSV は、受け入れ条件（区切りはカンマ、1行目は列名）より緩く読まないよう、次のように読む。
どれも DuckDB-WASM（中身は v1.5.4）で確かめた（2026-11-09、`duckdb-engine.browser.test.ts`）。

- **列名**：1行目をそのまま読んだものを使う。DuckDB は列名の前後の空白を除き（` code` を `code` にする）、重なった列名を付け替える（2つめの `code` を `code_1` にする）。DuckDB の列名は、SQL で列を指すのにだけ使う。
- **行を飛ばす推定**：`skip = 0` で止める。止めないと、1行目が表題の CSV や、列の数がそろわない CSV を、途中の行から読んでしまう。止めると、これらは読み込みのエラーになる。
- **空の列名**：SQL で名前として書けないので、読み込みのエラーにする。
- **型の推定**：全行から推定する（`sample_size = -1`）。先頭の行だけで推定すると、後ろの行に推定と違う値がある属性の列で、ファイル全体を読めなくなる。UTF-8 でない行が後ろにあるファイルも、この段階でエラーになる。

空の行は DuckDB が読み飛ばすので、空の行より後ろの行では、拒否の通知の「行目」が実際の行とずれる。

### 正規化した Parquet

結合用の列は core の `STORED_JOIN_COLUMNS` の型（`code` は VARCHAR、`mesh` は UINTEGER、`lat` と `lon` は DOUBLE）で書く。
数値の属性の列は DOUBLE にする。
hyparquet は UBIGINT や DECIMAL を読めないので、読み戻すときにどの整数型も同じように数として読めるようにするためである。
列名は利用者のファイルの列名のまま残す。

起動したあとの復元では、正規化した Parquet を DuckDB ではなく hyparquet で読む。
DuckDB-WASM を読み込むのは、取り込むときと、点を行政区域に割り当てるときだけである（D4）。

### 点から行政区域への割り当て

点の範囲に入る都道府県を core の `prefecturesForPoints` で選び、その `admin_geom/<コード>.parquet` だけを `fetchBytes` で読んで DuckDB に登録する。
点はどの都道府県の範囲にも入らなければ、spatial 拡張を読み込まずに、すべて値なし（null）にする。
点の座標は、点の番号と緯度経度の CSV にして DuckDB に渡す。

市区町村で塗るとき、点の件数では点のない市区町村を 0 件にし、合計と表の値では値なし（透明）にする（core の `completeCodeValues` の説明のとおり）。

### 目録の書き込み

目録の書き込みは `persistence.ts` で1つずつ順に行い、書くたびにほかのタブに知らせる。

- **取り込み**：データのファイルを書いてから目録を書く。目録を書けなければ、書いたファイルを消す。
- **削除**：目録を書いてからファイルを消す。消し損ねたファイルは、次の起動で掃除する。
- **すべて削除**：空の目録を書いてから、置き場所を空にする。
- **掃除**：書き込みのロックを持つタブだけが行う。閲覧専用のタブが掃除すると、書き込み側のタブが取り込みの途中で書いたファイルを消してしまうからである。読めない目録のもとでも掃除しない。

最初のデータを取り込んだとき（目録が空だったとき）に、`navigator.storage.persist()` を求める。
断られたら、core の通知（`storage-not-persistent`）を出す。

対象のブラウザ（D20）はどれも Web Locks を持つ。
使えない環境では、ほかのタブと調整できないまま、書き込める状態で動かす。

### 地図の描き直し

- 単位、年、指標が変わったときだけ、塗り分けを作り直す。データの表示を変えただけなら、自前データのレイヤーだけを差し替える。
- 読み込みの途中で状態が変わったら、古い要求の結果は描かない。読んだ列とデータは `base-data.ts` と `datasets.ts` が持つので、捨てた要求の読み込みも無駄にならない。
- 指標の列は、最近使った 16 列（約 11MB）を持っておく。
- 市区町村を塗るあいだも、メッシュのレイヤーを隠して残す。メッシュに戻したときに、形の作り直しを避けるためである。
- 自前データをメッシュに結合した指標は、集計したメッシュだけを、そのメッシュの形で描く。ベースデータにないメッシュの値も描ける（docs/design/user-data.md の「検査と拒否」）。

### 画面の通知にない失敗

core の通知の種類にない失敗（DuckDB-WASM の起動の失敗、OPFS の容量不足、生成物を読めないなど）は、`AppPorts.report` で知らせる。
ブラウザではコンソールに出す。

## テスト

node のテスト（`*.test.ts`）は、`test-fakes.ts` の偽物の口と、`tests/fixtures/` の鳥取県の Parquet で手続きを確かめる。
置き場所はメモリ上の置き場所を OPFS として扱わせ、ロックとチャンネルは複数のタブで共有する偽物にする。

ブラウザのテスト（`*.browser.test.ts`）は、DuckDB-WASM での CSV と Parquet の読み方と点の割り当て、OPFS を通す取り込みと復元、実際の Web Locks と BroadcastChannel での2つのタブのやりとりを確かめる。
spatial 拡張を extensions.duckdb.org から取得するので、ネットワークが要る。
いまの `vite.config.ts` はブラウザのテストの対象を `src/io/` に限っているので、`pnpm test:browser` では流れない。
流すには、対象に `src/app/**/*.browser.test.ts` を、事前に変換する依存に `zustand/vanilla` を足す。
