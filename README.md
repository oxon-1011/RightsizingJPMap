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

## ライセンス

[MIT](LICENSE)
