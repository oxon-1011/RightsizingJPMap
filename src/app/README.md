# app

core と io をつなぐ手続きと、状態の置き場所（Zustand のストア）を置く層。
io を呼んでよいのはこの層だけである。
状態の形と更新関数は core に置き、ここではそれを呼ぶ。
書き方は [docs/guides/coding.md](../../docs/guides/coding.md) に従う。
