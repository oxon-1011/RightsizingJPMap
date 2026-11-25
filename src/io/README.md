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
| `map.ts` | MapLibre GL JS、pmtiles のプロトコル、deck.gl の MapboxOverlay | `startMap`、`stopMap`、`setAdminFill`、`setOverlayLayers`、`setFillOpacity`、`setBasemap`、`fitBBox`、`watchPointer` |
| `deck-layers.ts` | deck.gl のレイヤー | `parseOverlayGeoJson`（レイヤーの組み立ては `setOverlayLayers` が呼ぶ） |
| `bytes.ts` | `fetch`、`Blob.arrayBuffer` | `fetchBytes`、`readBlobBytes` |
| `hash.ts` | `window.location.hash`、`history.replaceState`、`hashchange` | `readHash`、`replaceHash`、`watchHash` |

### parquet.ts

`openParquetUrl` は先頭の2バイトの Range リクエストで大きさを知り、末尾のメタデータだけを Range リクエストで取得する。
末尾は、まず 32KB（`URL_FOOTER_FETCH_BYTES`）を取得する。
hyparquet の既定の 512KB では、都道府県ごとのメッシュのファイル（0.2〜2.5MB）で、指標の列より大きな通信になるからである。
生成物のメタデータは 6〜11KB で、32KB より大きければ hyparquet が足りない分を取り直す。
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

### hash.ts

URL の `#` 以降を読み書きする。
値の形は core が決め（`position/hash.ts`、`region/hash.ts`）、ここは読むことと書くことだけをする。
書くときは `history.replaceState` を使い、履歴を増やさない。
地図の位置は `map.ts` が同じ `#` 以降に書くので、どちらも、ほかの名前の値を残して書く。

### bytes.ts

ファイル全体をバイト列で読む。
`fetchBytes` は生成物の JSON と admin_geom の都道府県のファイルに、`readBlobBytes` は利用者が選んだファイルに使う。
`fetchBytes` は 2xx 以外の応答を `read-failed` にする。
全体を1回で読むので、GitHub Pages が gzip で返しても、ブラウザが展開した元のバイト列になる。

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

### map.ts

地図を作り、core の描画の指定（`src/core/render/`）を地図に適用する。
React に依存しないので、app の手続きから呼ぶ。

```ts
import { adminFillSpec } from "../core/render/admin";
import { meshLayerSpec } from "../core/render/mesh";
import { BASEMAP_STYLE_FILE, setAdminFill, setBasemap, setFillOpacity, setOverlayLayers, startMap } from "../io/map";

const started = await startMap({
  container,                                                   // 大きさは呼び出し側の CSS で決める
  styleUrl: new URL(BASEMAP_STYLE_FILE, appBase).href,         // appBase はアプリの base の絶対 URL
  adminTilesUrl: baseDataUrl("admin.pmtiles"),
  bounds: [122.9, 24.0, 146.0, 45.6],                          // 最初に映す範囲
  attributionDetailsUrl: "#",                                  // 出典の詳細のページ
  positionHashName: "map",                                     // URL の #map=... に位置を載せる。null なら載せない
});
if (!started.ok) return started;                               // kind で理由が分かる
const map = started.value;

// 市区町村を塗る
setAdminFill(map, adminFillSpec(values, classificationOf(id, "municipality"), true));
setOverlayLayers(map, { mesh: null, points, geoJsons });

// メッシュを塗る。市区町村の塗りは隠れ、境界線は残る
setAdminFill(map, adminFillSpec(new Map(), classificationOf(id, "municipality"), false));
setOverlayLayers(map, {
  mesh: meshLayerSpec({ id: "mesh", geometry, values, classification, colorKey: `${id}/${year}`, visible: true }),
  points,
  geoJsons,
});

// 背景地図を写真に替え、鉄道を隠す。候補は core の BASEMAP_IDS、単位は BASEMAP_LAYER_GROUPS
setBasemap(map, { id: "photo", visibility: { rail: false, road: true, river: true, label: true } });

// 塗り分けを半透明にする。値は core の FILL_OPACITIES
setFillOpacity(map, 0.4);
```

`startMap` は、背景地図のスタイルを読み、行政区域のレイヤー、deck.gl、出典の表示、コントロール（ズームと方位磁石、現在地、縮尺）を足したところで返す。
タイルを読み終えるのは待たないので、返したあとすぐに `setAdminFill` と `setOverlayLayers` を呼んでよい。
失敗したときは、作りかけの地図を片付けてから、次のどれかを返す。

- **create-failed**：WebGL2 が使えないなど、MapLibre の地図を作れなかった。
- **style-failed**：背景地図のスタイルを読めなかった。
- **style-contract**：スタイルの `metadata` に、差し込む位置か、表示を切り替える単位のレイヤーの ID がないか、そのレイヤーがスタイルにない（「背景地図のスタイル」を参照）。
- **update-failed**：レイヤーを足すときや更新するときに、MapLibre か deck.gl が例外を投げた。`setAdminFill` と `setOverlayLayers` もこれを返す。

地図は下から次の順に重なる。
メッシュを塗っているときも、川、道路、鉄道、境界線、地名がメッシュの上に見える。

1. 背景地図の海と陸
2. 行政区域の塗り（`rjm-admin-pref-fill`、`rjm-admin-muni-fill`）と、deck.gl のメッシュ
3. 背景地図の川と湖、主な道路、鉄道
4. 行政区域の境界線（`rjm-admin-muni-line` は z6 から、`rjm-admin-pref-line` は全ズーム）
5. 背景地図の地名
6. 自前データの線と面、点（deck.gl）

`setAdminFill` は、指定のすべての団体コードに `setFeatureState` で色を渡す。
塗りの色は feature-state の `fill`（CSS の色の文字列）で決まり、まだ渡していない地域は透明になる。
指定の `sourceLayer` の塗りだけを `visible` に従って表示し、もう一方の塗りは隠す。
境界線はこの関数では隠さない。

`setOverlayLayers` は、deck.gl のレイヤーをまとめて差し替える。
指標や年だけを変えるときは、前と同じ `MeshGeometry` のオブジェクトから作った `MeshLayerSpec` を渡す。
同じ形なら、deck.gl は三角形への分割と頂点の転送をやり直さず、`colorKey` の変化を見て色の配列だけを転送する。
`MeshGeometry` を作り直すと、形ごと作り直しになる。
自前データの点は、同じ座標の配列（`PointLayerSpec.positions`）なら座標を転送し直さない。
線と面の GeoJSON は `parseOverlayGeoJson` で一度だけ読み、同じ値を渡し続ける。

`setFillOpacity` は、塗り分け（メッシュと行政区域の塗り）の不透明度を変える。
行政区域は `fill-opacity` を変え、メッシュは最後に渡されたレイヤーを、不透明度だけを変えて渡し直す。
どちらも色は送り直さない。
自前データのレイヤーには効かない。
deck.gl は、レイヤーを渡し直さないと不透明度を変えられないので、`MapHandle.fill` に不透明度と最後のレイヤーを持つ。
`MapHandle` の中で書き換えるのは、ここだけである。
deck.gl 9.4.1 は `opacity` を 1/2.2 乗してから色のアルファに掛けるので、`deck-layers.ts` の `deckOpacity` が 2.2 乗した値を渡し、MapLibre の `fill-opacity` と同じ濃さにする。

`setBasemap` は、背景地図を替え、鉄道、道路、川、地名の表示を切り替える。
候補ごと、単位ごとのレイヤーの ID は、`startMap` がスタイルの `metadata` から読んだもの（`MapHandle.basemapLayers`）を使う。
どのレイヤーを表示するかは、core の `basemapLayerVisibility` が決める。
変えるのは layout の `visibility` だけで、スタイルは読み直さない。
MapLibre は、表示していないレイヤーのタイルを読まないので、ラスターのタイルは、その背景地図を選んだときに初めて読む。
川（`river`）は塗りを差し込む位置（`choropleth`）でもあるが、隠しても重なりの順は変わらず、メッシュと行政区域の塗りは描かれる（`map.browser.test.ts` で確かめている）。

`setBasemap` は、右下の出典の表示も差し替える。
並べる提供元は core の `basemapCredits` が決め、`AttributionControl` の `options.customAttribution` を書き換える。
`AttributionControl` は、レイヤーの表示が変わったあとの描画で、この値を読み直す。
MapLibre は出典を文字数の順に並べ替えるので、並びを保つために、出典の全体を1つの文字列にしている。
スタイルのソースの `attribution` は、この文字列に含まれる文字にしてあり、MapLibre が重複として省く。
出典は、幅の狭い地図でも畳まない（`compact: false`）。
OpenStreetMap のタイルの利用の方針が、帰属の表示を切り替えのボタンの奥に隠さないよう求めているからである。

`fitBBox` は、範囲が収まるように地図を動かす（場所への移動、D21）。
地図の向きは変えない。
MapLibre の `fitBounds` は、既定では北を上に戻すので、いまの向きを渡している。

`watchPointer` は、ホバーのカードのために、ポインタの下のものを知らせる。
知らせは2種類で、`hover` はポインタの位置、地図の要素の大きさ、ポインタの下のもの（core の `HoverHit`）を持つ。
`leave` は、ポインタが地図の外に出たときと、地図が動き始めたときに知らせる。

- **自前データ**：deck.gl の picking の結果（`onHover`）を使う。picking の対象は自前データの点、線、面のレイヤーだけで（`deck-layers.ts`）、メッシュは対象にしない。拾う半径は `PICKING_RADIUS`（3px）にした。幅 2px の線を拾えるようにするためである。
- **市区町村**：市区町村の塗りのレイヤーを `queryRenderedFeatures` で引き、団体コードを返す。メッシュを塗っているあいだは塗りのレイヤーを隠しているので、null になる。
- **経緯度**：ポインタの位置を `unproject` する。メッシュコードは app が core で計算する。

知らせの回数は、フレームごとに1回である。
interleaved の deck.gl は、地図のキャンバスの pointermove を自分で聞き、次のフレームでまとめて1回だけ picking をして `onHover` を呼ぶ。
`watchPointer` は、その `onHover` から知らせる。
MapboxOverlay は、interleaved では MapLibre の mousemove を deck.gl に渡さない（overlaid のときだけ渡す）。

地図が動いているあいだ（`movestart` から `moveend` まで）は、知らせない。
ドラッグのあいだは、MapLibre が mousemove を出さず、deck.gl もボタンを押したままの pointermove では picking をしないので、picking の負荷もかからない。
動き終えても引き直さず、次にポインタが動いたときに知らせる。
動き終えた直後に `pickObject` で引き直すと、100 万点を重ねた地図では、その1フレームが 330〜450ms に延びたからである（2026-11-10、本番用のビルドの Chrome で測った）。
カメラが変わったあとの最初の picking は 50〜90ms かかり（2回目からは約 10ms）、動き終えた直後はそれに、GPU が最後のフレームを描き終えるのを待つ時間が加わる。
クリックは扱わない。MapLibre は、押した位置から 3px（`clickTolerance` の既定）以上動かして離すと、`click` を出さない（`map.browser.test.ts` で確かめている）。

地図は、ズームを 4〜16 に限っている。
地理院の最適化ベクトルタイルが z4 からしかなく、z4 未満では背景地図が描かれないからである。
回転はできるが、傾きは `maxPitch: 0` で止めている（2026-11-24）。
`pitchWithRotate: false` だけでは、キーボードの Shift + 上下で傾くからである。

#### コントロールと URL の位置

コントロールは、MapLibre の標準の部品を使う（2026-11-24）。
右下に、上からズームと方位磁石（`NavigationControl`）、現在地（`GeolocateControl`）、出典を置き、左下に縮尺（`ScaleControl`）を置く。
下の隅のコントロールは、あとに足したものほど上に並ぶので、出典、現在地、ズームと方位磁石の順に足している。
ボタンの説明（`title` と `aria-label`）は、`Map` の `locale` で日本語にしている。
見た目は `src/ui/styles.css` で、ほかの部品にそろえている。
現在地は、ボタンを押したときに1回だけ求め（`trackUserLocation: false`）、追い続けない。

`positionHashName` を渡すと、地図の位置を URL の `#` 以降に載せる。
文字列との変換は core の `position/hash.ts` がし、`map.ts` は読むことと書くことだけをする。

- **開くとき**：URL に位置があれば、`bounds` の代わりにその位置を映す。読めない位置（範囲の外の値、数でない値）なら、`bounds` を映す。
- **書くとき**：地図が動き終えるたび（`moveend`）に、`history.replaceState` で書く。履歴は増えない。開いただけでは書かない。
- **URL が変わったとき**：`hashchange` で読み直し、その位置へ移す。地図を片付けると、聞くのをやめる（`remove` のイベント）。

MapLibre の `hash` のオプションは使わない。
MapLibre は、作った直後の位置（ズーム 4、緯度 0、経度 0）を URL に書いてから `bounds` に合わせ、合わせたあとの位置は 300ms 遅れて書く。
そのあいだに地図を作り直す（開発時の React の StrictMode）と、作り直した地図が緯度 0、経度 0 を映した（2026-11-24）。

#### MapLibre と deck.gl の組み合わせで足した処理

MapLibre 6.16 と deck.gl 9.4.1 をそのまま組み合わせると動かない箇所が2つあり、`map.ts` で補っている。
どちらも 2026-11-09 に開発サーバーで確かめた。

- **Worker の場所**：MapLibre 6 は、本体のモジュールの隣にある `maplibre-gl-worker.mjs` を Worker として読む。Vite が本体を事前バンドルすると隣にファイルがなくなり、「Worker failed to load」で地図が描かれない。そこで `maplibre-gl/dist/maplibre-gl-worker.mjs?url` で Vite に URL を出させ、`setWorkerUrl` に渡す。このファイルは他のファイルを import しないので、そのまま配れば動く。
- **`map.transform`**：deck.gl の `@deck.gl/mapbox` は、interleaved で描くたびに `map.transform.height` を読む（`deck-utils.js` の `getViewport`）。MapLibre 6 は transform を `map._camera.transform` に移したので、描くたびに例外になる。`startMap` は、地図に `transform` がなければ、`_camera.transform` を返す `transform` を足す。deck.gl が MapLibre 6 に合わせたら消せる。

#### deck.gl を interleaved で使う理由

`MapboxOverlay` は `interleaved: true` にしている。
deck.gl のレイヤーを MapLibre のレイヤーの間に差し込み、メッシュの上に道路、境界線、地名を描くためである。
interleaved にしなければ、deck.gl は地図の上に別のキャンバスを重ねるので、メッシュが境界線と地名を覆う。
境界線を deck.gl の側で描く方法もあるが、admin.pmtiles を deck.gl で読むには `@deck.gl/geo-layers` が要り、依存が増える。

#### 出典の表示

右下の `AttributionControl` に、[docs/user/attribution.md](../../docs/user/attribution.md) の案を出す。

```
国土地理院最適化ベクトルタイル | 国土数値情報（国土交通省） | 国立社会保障・人口問題研究所 | 出典の詳細
```

「国土地理院最適化ベクトルタイル」は地理院タイル一覧のページに、「出典の詳細」は `attributionDetailsUrl` にリンクする。
MapLibre は出典の項目を短い順に並べ替えるので、順序を保つために全体を1つの文字列で渡している。
背景地図のスタイルと admin.pmtiles のソースにも出典を書いているが、この文字列の一部なので、MapLibre が重複として省く。

### deck-layers.ts

core の `MeshLayerSpec`、`PointLayerSpec`、`GeoJsonLayerSpec` を、deck.gl のレイヤーに変える。
地図には触らず、`setOverlayLayers` がここを呼ぶ。

- **メッシュ**：`SolidPolygonLayer` に、`src/core/mesh/geometry.ts` のバイナリ形式（`_normalize: false`、三角形の頂点の番号つき）で渡す。色は頂点ごとの RGBA を `getFillColor` のバイナリとして渡す。`dataComparator` で同じ `MeshGeometry` から作った data を同じとみなし、形の作り直しを止める。
- **点**：`ScatterplotLayer` に、座標をバイナリ形式で渡す。半径はピクセルで指定し、濃い塗りの上でも見えるよう White の 1.5px の縁取りを付ける。
- **線と面**：`GeoJsonLayer` に渡す。面は `GeoJsonLayerSpec.fillColor`（半透明）で塗り、枠を描く。

点、線、面は、ホバーのカードのために `pickable` にする。
点の picking の結果は点の番号だけで、線と面は GeoJSON の地物（`properties` を含む）が返る。

`parseOverlayGeoJson` は、OPFS から読んだ GeoJSON のバイト列を JSON として読むだけで、中身は検査しない。
取り込みのときに core の `checkGeoJson` を通ったファイルを渡す前提である。

### 背景地図のスタイル

背景地図のスタイルは、`public/basemap/gsi-optimal-bvmap.json` に置く。
地理院の最適化ベクトルタイル（PMTiles 版）は試験公開で、URL や属性が変わることがあるので、アプリのコードから分けている。
塗り分けが主役なので、描くのは次のものだけにした。

| レイヤー | ソースのレイヤー | 描くもの |
|---|---|---|
| `background` | なし | z8 未満は海（DADS の SolidGray/100）、z8 からは陸（White） |
| `gsi-photo`、`gsi-pale`、`gsi-std`、`gsi-relief` | なし（ラスター） | 地理院タイルの写真、淡色地図、標準地図、色別標高図。背景地図に選んだものだけを表示する |
| `osm-standard` | なし（ラスター） | OpenStreetMap の標準のタイル。背景地図に選んだときだけ表示する |
| `land` | `AdmArea` | z8 未満の陸（White） |
| `water` | `WA` | 海、湖、川（SolidGray/100）。川と湖は `river` が上から塗り直す |
| `river` | `WA` | 海（`vt_code` 5100、5101）以外の水域（Cyan/300）。塗りとメッシュの上に描く |
| `road` | `RdCL` | `vt_rdctg` が高速自動車国道等、国道、主要道路のもの（SolidGray/420） |
| `rail-tunnel` | `RailCL` | 鉄道のトンネルと地下の区間（SolidGray/500 の破線） |
| `rail`、`rail-dash` | `RailCL` | 鉄道の地上の区間（SolidGray/800 の線に White の破線） |
| `label-place` | `Anno` | 市区町村の名前（`vt_code` が 1301〜1303、1401〜1403、110 の点） |

鉄道は、`vt_rtcode` が新幹線、主要鉄道、JR、JR以外、地下鉄、路面のものを描き、索道、側線、特殊鉄道は描かない。
川の線（`RvrCL`）は描かない。
街の川は `WA` の面として入っていて、`RvrCL` に入っているのは山の沢、用水路、暗渠と推すものだからである（段階 7.5、2026-11-10）。

タイルの中身はズームによって違う。
開発サーバーで `querySourceFeatures` を使って確かめた（2026-11-09）。

- **陸と海**：`AdmArea`（陸の面）は z4〜7 にだけあり、z8 からは `WA` に海（`vt_code` 5101）が入る。そのため z8 で背景の色を海から陸に切り替える。地理院の標準地図のスタイル（`gsi-cyberjapan/optimal_bvmap` の `style/std.json`）も同じ切り替え方をしている。
- **道路**：z4〜5 は高速自動車国道等だけ、z6〜7 は主要道路が加わり、z8 からは国道と都道府県道が入る。
- **鉄道**：z4〜5 は新幹線だけ、z6〜7 は新幹線と主要鉄道、z8 は JR だけ（新幹線も含む）、z9 から JR以外、z11 から地下鉄と路面が加わる。トンネルと地下の区間は `vt_railstate` で見分ける（`トンネル ` のように末尾に空白がある値もある）。
- **水域**：海の `vt_code` は z13 までは 5101、z14 からは 5100 である。川の面は z10 にはあり、z8 にはない（z9 は確かめていない）。
- **地名**：z4〜7 は人口の規模で分けた市の名前（1301〜1303）、z8〜10 は都道府県庁、市役所、町村役場の位置の名前（1401〜1403）、z11 からは市区町村の名前（110）が入る。

地理院のタイルの行政界（`AdmBdry`）は描かない。
行政区域の塗りと同じ形の境界線を admin.pmtiles から描くので、地理院の行政界を重ねると、少しずれた線が2本並ぶからである。

地名の文字は、グリフのファイルを使わず、ブラウザのフォントで描く。
スタイルに `glyphs` を書かなければ、MapLibre は `text-font` の名前を CSS のフォント名として、文字を手元で描く（MapLibre GL JS 5.11 から）。
`text-font` は `["Noto Sans JP", "sans-serif"]` で、Noto Sans JP がなければ OS の日本語のフォントになる。
スプライト（アイコンの画像）は使わない。

`metadata` の `rjm:insertBefore` に、行政区域とメッシュを差し込む位置を書く。

```json
"metadata": { "rjm:insertBefore": { "choropleth": "river", "boundary": "label-place" } }
```

`choropleth` のレイヤーの直前に行政区域の塗りと deck.gl のメッシュを、`boundary` のレイヤーの直前に行政区域の境界線を差し込む。

`metadata` の `rjm:layerGroups` には、画面で表示を切り替える単位ごとに、まとめて切り替えるレイヤーの ID を書く。

```json
"rjm:layerGroups": {
  "rail": ["rail-tunnel", "rail", "rail-dash"],
  "road": ["road"],
  "river": ["river"],
  "label": ["label-place"]
}
```

単位は core の `BASEMAP_LAYER_GROUPS`（`rail`、`road`、`river`、`label`）で、4つとも書く。
書き方は core の `parseBasemapLayerIds` が、レイヤーがスタイルにあるかは `startMap` が確かめ、満たさなければ `style-contract` を返す。

`metadata` の `rjm:basemaps` には、背景地図の候補ごとに、選んだときにだけ表示するレイヤーの ID を書く。

```json
"rjm:basemaps": {
  "vector": ["land", "water"],
  "photo": ["gsi-photo"],
  "pale": ["gsi-pale"],
  "std": ["gsi-std"],
  "relief": ["gsi-relief"],
  "osm": ["osm-standard"]
}
```

候補は core の `BASEMAP_IDS` で、6つとも書く。
検査は `rjm:layerGroups` と同じで、書き方は core の `parseBasemapSurfaceIds` が確かめる。
ラスターのレイヤーは、`background` と `land` のあいだに、`visibility: none` で置く。
塗りを差し込む位置（`river`）より下なので、塗り分け、線、境界線、地名は、どの背景地図でも同じ順に重なる。
候補ごとに隠す単位（淡色地図、標準地図、OpenStreetMap は4つとも、写真は川）は、スタイルではなく core の `BASEMAP_HIDDEN_GROUPS` に置く。

ラスターのタイルは 256px で、MapLibre は地図のズームより 1 大きいズームレベルのタイルを読む。
地図のズーム 4〜16 は、タイルのズームレベル 5〜17 にあたる。
色別標高図のタイルはズームレベル 15 までなので、地図のズーム 15 から先は、同じタイルを拡大して描く。

スタイルを差し替える（たとえば Protomaps にする）ときは、`rjm:insertBefore` の2つの位置、`rjm:layerGroups`、`rjm:basemaps` を書けば、`map.ts` と画面を変えずに済む。

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

OPFS、Web Locks、DuckDB-WASM、MapLibre はブラウザでしか動かないので、`*.browser.test.ts` に分け、Vitest のブラウザモード（Playwright の Chromium）で実行する。

```bash
pnpm exec playwright install chromium   # 初回だけ
pnpm test:browser
```

`pnpm test` と `pnpm check` は node のテストだけを実行し、ブラウザのテストを含まない。
CI では、ブラウザのテストを別のジョブ（`.github/workflows/ci.yml` の `browser`）で実行する。
spatial 拡張のテストは extensions.duckdb.org から拡張を取得するので、ネットワークが要る。

地図のテスト（`map.browser.test.ts`）は、ヘッドレスの Chromium の WebGL2 で地図を描く。
手元の macOS では通った（2026-11-09）。
Playwright（1.65.0）は Chromium に `--enable-unsafe-swiftshader` を渡すので、GPU のない CI でもソフトウェアで描けるはずだが、CI ではまだ確かめていない。
ネットワークを使わないよう、背景地図は背景色だけのスタイルを Blob の URL で渡す。
川、道路、鉄道は描かない背景のレイヤーで代え、表示の切り替えは layout の `visibility` と、描かれた画素の色で確かめる。
admin.pmtiles は置かないので、そのタイルの取得の失敗がログに出るが、feature-state の読み書きは確かめられる。
メッシュは、描かれた画素の色を読んで、色の差し替えが画面に届くことを確かめる。
`watchPointer` は、地図のキャンバスに pointermove（deck.gl が聞く）と mousemove（MapLibre が聞く）の両方を送って確かめる。
ブラウザも、マウスを動かすとこの2つを出す。
deck.gl のレイヤーの組み立て（`deck-layers.ts`）は、WebGL がなくても作れるので、node のテスト（`deck-layers.test.ts`）にしている。
