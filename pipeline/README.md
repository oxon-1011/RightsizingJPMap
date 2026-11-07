# pipeline

ベースデータの前処理を置く（トラック A）。
生成物の仕様は [docs/design/base-data.md](../docs/design/base-data.md) に、契約は [src/core/data/schema.ts](../src/core/data/schema.ts) にある。

## 使い方

```bash
mise run pipeline            # 生成物を最初から作り直し、検証まで行う
mise run pipeline:check      # 生成物を検証する
mise run pipeline:fixtures   # tests/fixtures/ に鳥取県の分を書き出し、検証する
```

`mise run pipeline` は `pipeline/out/` と作業用のファイルを消してから、すべての段階を順に流す。
取得した N03 は消さない。
手元の Mac で（2026-11-07）、最初から検証の終わりまでおよそ 3 分（173 秒） かかった。

段階を選んで流すときは、`mise exec -- bash pipeline/build.sh <段階...>` を使う。
段階は `fetch`、`mesh`、`municipal`、`admin`、`tiles`、`admin_geom`、`places`、`check`、`fixtures`、`clean` で、`check:<名前>` は `checks/<名前>.sql` だけを流す。

## 使う道具と入力

| もの | 版、置き場所 | 補足 |
|---|---|---|
| DuckDB CLI | 2.0.0 | `mise.toml` で固定している。別の版で動かすと `build.sh` が止まる |
| DuckDB の spatial 拡張 | DuckDB 2.0.0 に合うもの | 初回に SQL の `INSTALL spatial` が取得する |
| tippecanoe、tippecanoe-decode | 2.79.0 で確かめた | `brew install tippecanoe` で入れる |
| 推計の Parquet | 環境変数 `POPULATION_DIR`（既定は `~/Downloads/population`） | 社人研の市区町村推計、浜松市の参考資料、国土数値情報の 1km メッシュ推計 |
| N03 の 2024 年版（全国） | `pipeline/.cache/` | なければ `fetch` が国土数値情報から取得し、SHA-256 を確かめて展開する |

## ディレクトリ

- `build.sh`：段階を順に流すスクリプト。パスは SQL の変数（`getvariable('out_dir')` など）として渡す。
- `sql/`：段階ごとの SQL。
- `checks/`：検証の SQL。条件を満たさないと `error()` で止まり、`build.sh` も止まる。
- `.cache/`：取得した N03 と、作業用のファイル（`.cache/work/`）。Git に含めない。
- `out/`：生成物。Git に含めず、GitHub Release のアセットとして置く。

## GitHub Release への登録

生成物は、データの版（`src/core/data/schema.ts` の `DATA_VERSION`）ごとに、`data-<版>` の Release のアセットとして置く。
`data-v1` は 2026-11-07 に登録した。

Release のアセットはディレクトリを持てないので、`admin_geom/` は tar にまとめる。
中身は zstd で圧縮済みなので、tar は圧縮しない。
macOS の拡張属性を入れないよう、次のように作る。

```bash
cd pipeline/out
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --format ustar -cf admin_geom.tar admin_geom
shasum -a 256 mesh_indicators.parquet municipal_indicators.parquet admin.pmtiles places.json admin_geom.tar > SHA256SUMS
```

登録するアセットは、`mesh_indicators.parquet`、`municipal_indicators.parquet`、`admin.pmtiles`、`admin_geom.tar`、`places.json`、`SHA256SUMS` の6つである。
生成物は国土数値情報と社人研のデータを加工したものなので、Release の説明には出典と加工の表示を書く（書き方は `docs/user/attribution.md`）。

デプロイでは、Release から取り出して `data/<版>/` に置き、`admin_geom.tar` を展開する。

```bash
gh release download data-v1 -D dist/data/v1
cd dist/data/v1 && shasum -a 256 -c SHA256SUMS && tar -xf admin_geom.tar && rm admin_geom.tar SHA256SUMS
```

## 生成物

大きさは 2026-11-07 に `mise run pipeline` で作ったものである。

| ファイル | 段階 | 大きさ | 内容 |
|---|---|---|---|
| `mesh_indicators.parquet` | `mesh` | 28.7MB | 176,896 行 × 62 列。メッシュコードの順 |
| `municipal_indicators.parquet` | `municipal` | 173KB | 1,947 地域 × 7 時点 = 13,629 行。code と year の順 |
| `admin.pmtiles` | `admin`、`tiles` | 9.2MB | z0〜10。レイヤーは `pref`（47）と `muni`（1,886） |
| `admin_geom/<2桁>.parquet` | `admin`、`admin_geom` | 計 18.6MB | 47 ファイル、1,886 区域。最大は `01.parquet` の 1.95MB |
| `admin_geom/index.json` | `admin_geom` | 2.1KB | 都道府県ごとの範囲 |
| `places.json` | `admin`、`places` | 258KB | 1,965 件 |

Parquet はすべて zstd（レベル 19）で圧縮する。
レベル 3（DuckDB の既定）と比べると、`mesh_indicators.parquet` は 29.3MB から 28.7MB に、`mesh` 列は 528KB から 187KB に縮む（2026-11-07 に確かめた）。

### mesh_indicators.parquet

base-data.md の試作の SQL をもとに、`sql/mesh_indicators.sql` で作る。
同じ `mesh_code` の行（境界をまたぐメッシュの按分行）を合計し、年と指標の組を列に展開する。
秘匿記号は、その年のどれかの行に `*` か `@` があれば `{年}_masked` を真にする。

行はメッシュコードの順に並べるが、行グループは1次メッシュにそろえず、DuckDB の既定（122,880 行、2 個）のままにした。
DuckDB 2.0.0 の Parquet の書き出しは行数でしか行グループを区切れず、2,048 行の塊を単位に切る。
1次メッシュごとに `UNION ALL` で流して `ROW_GROUP_SIZE 1` で書くと、どの行グループも1つの1次メッシュに収まる形にはできる（151 の1次メッシュが 193 の行グループになる）。
ただし、そうするとフッターが 11KB から 918KB に、ファイルが 1.5MB 増える。
さらに、全国の表示で4列を読むときの Range リクエストが、行グループと列の組の数（8 から 772）に増える。
保留中の地域モードの目的は描画の負荷を下げることで、全国の4列（約 1.7MB）を読んでから行を絞っても目的は果たせる。
そのため、全国の表示を重くしてまで行グループをそろえる理由はないと判断した。
地域モードを採るときに読む量も減らしたくなったら、この方法で作り直せる。

### municipal_indicators.parquet

`sql/municipal_indicators.sql` で作る。
浜松市の旧7区（22131〜22137）の行を消して参考資料の3区（22138〜22140）に差し替え、`pref_name` に「静岡県」、`area_type` に `0` を補う。
`year` は `"2020年"` の形の文字列から整数にし、形が違えば止める。
都道府県の行は `municipality_name` が NULL なので、`name` に都道府県名を入れる。

### 行政区域のポリゴン（admin）

`sql/admin_units.sql` で N03 をまとめ、結果を作業用のデータベース（`.cache/work/admin.duckdb`）に置く。
`tiles`、`admin_geom`、`places` はここから読む。

1. N03 のポリゴンを団体コード（`N03_007`）ごとに `ST_Union_Agg` でまとめる（1,905 コード）。
2. 東京都の都心の 11 区（千代田区、港区など）で、隣り合う区の境界の頂点がわずかにずれている（不一致の辺は計 0.4 度ほど）。`ST_CoverageClean` で被覆（隙間も重なりもないポリゴンの集まり）に直す。面積の変化は全体の 5×10⁻¹⁰ だった。
3. 推計の団体コードと突き合わせ、地図で塗る単位にまとめる。福島県で推計に団体コードがない 13 市町村は、`ST_CoverageUnion_Agg` で1つにして `07999`（浜通り地域）にする。
4. 都道府県は団体コードの上2桁でまとめる。

N03 の団体コードは、次の4つに分かれた。

| 区分 | 団体コード | N03 のポリゴン | 扱い |
|---|---|---|---|
| 推計にある | 1,879 | 123,092 | そのまま塗る単位にする |
| 浜通り地域の構成市町村 | 13 | 175 | まとめて `07999` にする |
| 北方領土の6村（01695〜01700） | 6 | 726 | 境界は描くが値はない。admin_geom と places.json にも載せる |
| 所属未定地 | 7 | 140 | 下の段落を参照 |

所属未定地の団体コードは NULL ではなく、`13000` のような都道府県の形だった（東京都 123、鹿児島県 12、千葉県、愛知県、和歌山県、福岡県、沖縄県が各 1 のポリゴン）。
`muni` レイヤーに入れると、都道府県の行と同じ code で feature-state が付き、都道府県の総数で塗られてしまう。
そのため市区町村の単位（`muni`、admin_geom、places.json）からは除き、都道府県のポリゴン（`pref`）にだけ含めた。
所属未定地の上では `muni` のどの地物も塗られず、値なしに見える。

### admin.pmtiles

`sql/admin_tiles_input.sql` で GeoJSONSeq を書き、tippecanoe で2レイヤーの PMTiles にする（`build.sh` の `stage_tiles`）。

- 属性は `code`（5桁の文字列）と `name` だけである。都道府県の `code` は `01000` の形にする。
- 隣との隙間を防ぐため `--no-simplification-of-shared-nodes` を使う。tippecanoe の文書が `--detect-shared-borders` の代わりに勧めている。
- 全ズームで全区域を残すため、小さなポリゴンの間引き（`--no-tiny-polygon-reduction`）と、地物の数とタイルの大きさの上限を外した。それでも z0 では、世界全体を1枚に収める縮尺のため 1,886 区域のうち 39 が消える。z1 以上ではすべて残ることを検証で確かめている。
- ズームは z0〜10 である。タイルは最大で 138KB（z6）だった。
- N03 の測地系は JGD2011 である。WGS84 との差は1m未満なので、座標を変換せずに経度緯度として書く。

### admin_geom

`sql/admin_units.sql` の最後で、被覆を保ったまま `ST_CoverageSimplify` で簡略化する（許容差 0.0002 度、約 20m）。
`ST_SimplifyPreserveTopology` で区域ごとに簡略化すると、隣との間に隙間と重なりができ、重なりに入った点が2つの区域に数えられてしまう。
所属未定地も被覆に含めて簡略化し、隣との境界をそろえてから除く。
許容差は 0.0005 度（計 14MB）と 0.001 度（計 9.8MB）も試した。
島の多い県ではポリゴンの数（北海道で 9,561）が点の数の下限を決めるので、許容差を上げても思うほどは小さくならない。

GeoParquet のメタデータ（`geo`）は `sql/admin_geom_copy.sql` で自分で書き、版を 1.1.0 にする。
DuckDB 2.0.0 が自動で書くのは 1.0.0 で、bbox の列を宣言しないためである。

- 列は `code`、`name`、`geometry`（WKB の MultiPolygon）、`bbox`（`xmin`、`ymin`、`xmax`、`ymax` の DOUBLE の構造体）である。`bbox` は `covering` に宣言する。
- `crs` は省く（OGC:CRS84 とみなされる）。DuckDB 2.0.0 で読むと `GEOMETRY('OGC:CRS84')` になり、CRS のない点を `ST_Contains` にそのまま渡せることを確かめた。
- `index.json` の範囲は、ファイルの区域を囲むように小数5桁へ外向きに丸める。

### places.json

`sql/places.sql` で、N03 の全精度のポリゴンから範囲を求める。
範囲は小数5桁（約1m）へ外向きに丸める。

| kind | 件数 | 決め方 |
|---|---|---|
| `prefecture` | 47 | 団体コードの上2桁でまとめた都道府県 |
| `designated-city` | 20 | N03 で区（`N03_005`）を持つ市。団体コードは推計の `area_type` 1 から名前で引き、範囲は区の範囲を合わせる |
| `ward` | 171 | 政令指定都市の区。名前は「浜松市中央区」の形 |
| `municipality` | 1,727 | それ以外。東京都の特別区（23）、浜通り地域の構成市町村（13）、北方領土の6村を含む |

東京都の特別区は、N03 で区（`N03_005`）を持たないので `municipality` にした。
浜通り地域は、移動の候補なので構成市町村を N03 の名前とコードで個別に載せ、`07999` は載せない。

## 検証

`checks/` の SQL が確かめることは次のとおりである。
数値は 2026-11-07 の結果である。

- **mesh_indicators**（`checks/mesh_indicators.sql`）
  - 列の名前、型、順が契約どおりで、176,896 行がメッシュコードの昇順に並び、NULL も NaN も負の値もない。
  - 元の推計の PTN の全国合計が、各年で社人研の都道府県の合計と 0.001 人未満の差で一致する（2025 年は 123,262,450、2050 年は 104,686,386）。
  - 出力（FLOAT）の全国合計は、総人口、年齢区分とも社人研と 1 人以内で一致する（最大の差は 0.04 人）。
  - PT00 は PT01〜PT20 の合計である（差は最大 9×10⁻¹¹）。秘匿のないメッシュでは PT00 と PTN が一致する。PT01 と PT20 の全国合計は、社人研の 0〜4 歳と 95 歳以上に一致する。
  - 秘匿記号の付いたメッシュは 2025 年 14,087、2050 年 4,037、2070 年 5,242 である。
- **municipal_indicators**（`checks/municipal_indicators.sql`）
  - 列が契約どおりで、NULL がなく、(code, year) が重複せずにその順に並び、どの地域も7時点を持つ。
  - area_type ごとの件数は a 47、1 20、0 194、2 769、3 916、9 1 である。
  - 浜松市の旧7区が残っておらず、3区の合計が浜松市と一致する。
  - 都道府県の値が、全年、全年齢区分で、県内の塗る単位の合計と一致する。
- **admin**（`checks/admin.sql`）
  - N03 にあって推計にない団体コードは浜通り地域の 13 市町村と北方領土の6村だけで、推計にあって N03 にないのは `07999` だけである。
  - admin_geom の区域に隙間も重なりもなく、東京駅、札幌駅、浜松駅がそれぞれ千代田区、札幌市北区、浜松市中央区に入る。
  - PMTiles の z1、z5、z10 に 47 都道府県と 1,886 区域がそろい、属性は `code`（5桁の文字列）と `name` だけである。
  - タイルは `build.sh` が tippecanoe-decode で戻し、地物ごとのズーム、レイヤー、属性だけを TSV に抜き出して渡す。GeoJSON のまま DuckDB で読むと、z10 だけで 9GB ほどのメモリを使ったためである。抜き出し漏れがないことは、`--stats` の地物の数と突き合わせて確かめる。
- **places**（`checks/places.sql`）：要素の形、件数、範囲の順、推計の団体コードとの対応、区と市、県の範囲の包含。
- **fixtures**（`checks/fixtures.sql`）：テスト用データの列が生成物と同じで、行が鳥取県の分と一致する。
