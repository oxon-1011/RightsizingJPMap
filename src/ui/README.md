# ui

React のコンポーネントとスタイルを置く層。
部品は状態を持たず、表示する値と操作の関数を props で受け取る。
ただし、色の候補の開閉のように、その部品の中で閉じる表示の状態は部品が持つ。
状態は app のストア（段階 5）が持ち、地図との結線は段階 7 で行う。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。

## 部品の一覧

画面の構成は [docs/design/ui.md](../../docs/design/ui.md) と、Figma のページ「人口縮減」の画面 01〜04 に合わせている。

| ファイル | 部品 | Figma のコンポーネント |
|---|---|---|
| `IndicatorPanel.tsx` | 左上のパネル。指標と分母のセレクトボックス、凡例（`Legend.tsx`）、単位の切り替え（`UnitSwitch.tsx`） | Panel / 指標 |
| `YearSlider.tsx` | 下の年次スライダー | Control / 年次スライダー |
| `AddDataButton.tsx` | 右上のデータを追加するボタン | Button / データを追加 |
| `DropOverlay.tsx` | ファイルを重ねているあいだの覆い | Overlay / ドロップ |
| `NoticeList.tsx` | 通知。取り込めなかったときの通知を含む | Toast / 取り込めなかった |
| `LayerPanel.tsx` | レイヤーの一覧 | Panel / レイヤー、Layer / 行 |
| `PlaceSearch.tsx` | Ctrl（macOS では Command）+ K で開く場所の入力欄 | なし |

右下の出典は、段階 4 で MapLibre の AttributionControl が出す。

`App.tsx` は、地図の代わりの灰色の背景の上に部品を見本の値（`samples.ts`）で並べた仮の配置である。
`?screen=02` のように URL で Figma の画面の番号を指定すると、その画面の状態で開く。

## 部品から切り出した処理

部品の中の判断は、純粋な関数に切り出して node のテストで確かめる。

| ファイル | 内容 |
|---|---|
| `legend-format.ts` | 凡例の目盛りの数字と、スクリーンリーダー向けの階級の範囲 |
| `year-slider.ts` | スライダーの位置と年の変換、キーで動かしたあとの年 |
| `indicator-options.ts` | 指標と分母のセレクトボックスの選択肢 |
| `notice-text.ts` | 通知の文言。取り込めなかった理由と、行や地物の番号 |
| `keyboard.ts` | Ctrl + K の判定と、候補の一覧のキー操作 |
| `file-drag.ts` | ファイルを重ねているかの判定 |
| `layer-color.ts` | レイヤーの色の候補（core の `LAYER_COLORS`）の、読み上げる名前 |

## DADS の部品

`dads/` には、デジタル庁デザインシステムの React のコード例（<https://github.com/digital-go-jp/design-system-example-components-react>、MIT）から、要る部品だけを取り込んだ（D18）。
取り込んだのはコミット `e637c68`（v2.7.0）のもので、著作権表示は `dads/LICENSE` に残した。
各ファイルの先頭に、出所と変更点を書いている。

コード例は Tailwind v3 で書かれているので、v4 との違いを直した。

- `outline` は v4 では幅 1px の指定を含み、`outline-4` と競合するので除いた。
- v4 のプリフライトはボタンに `cursor: pointer` を付けないので、ボタンに `cursor-pointer` を足した。
- 重要度の指定を、前置の `!` から後置の `!` に直した。

色は DADS のユーティリティ（`bg-key-900`、`text-solid-gray-800` など）を使う。
Tailwind の既定の色は、`styles.css` で DADS の色を読む前に消している（`reset-tailwind-colors.css`）ので、クラスを書いても色は付かない。

アイコンのうち、データの追加、表示の切り替え、削除のアイコンは、Figma のファイルの SVG のパスを `icons.tsx` に写した。
非表示の目のアイコンは Figma にないので、表示の目に斜線を足して作った。
