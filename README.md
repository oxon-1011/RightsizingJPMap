# RightsizingJPMap

日本の人口減少を論じるためのモックプロダクト。
将来推計人口をメッシュと行政区域の単位で地図に塗り、持ち込んだデータを重ねて、需要と供給を見比べられるようにする。

## 文書

- [docs/design/](docs/design/README.md)：設計（決定事項、未決事項、実装計画）
- [docs/guides/](docs/guides/coding.md)：コードと文書の書き方
- [docs/user/](docs/user/README.md)：利用者向けの文書

## 開発

```bash
mise install
pnpm install
pnpm dev
```

```bash
pnpm check
```

`pnpm check` は lint、型検査、テストを順に実行する。

### 開発中のデータ

開発サーバーは、前処理の生成物（`pipeline/out/`）を、本番と同じ `data/<版>/` のパスで配る。
前処理を流さずに開発するときは、GitHub Release から取り出す（GitHub CLI のログインが要る）。

```bash
mise run data:download
```

## 公開

main の CI が通ると、`.github/workflows/deploy.yml` がアプリをビルドし、Release の生成物を足して GitHub Pages に公開する。
公開先は <https://oxon-1011.github.io/RightsizingJPMap/> である。

## ライセンス

[MIT](LICENSE)
