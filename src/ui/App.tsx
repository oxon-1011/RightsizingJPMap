// Phase 0 の仮の画面。Phase 2 で地図と操作パネルに置き換える。
// 公開したサイトから生成物（data/<版>/）を配るので、仮の画面にも出典と加工の表示を置く（docs/user/attribution.md）。

const SOURCES = [
  {
    title: "国土数値情報（1kmメッシュ別将来推計人口（R6国政局推計））",
    owner: "国土交通省",
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-mesh1000r6.html",
  },
  {
    title: "国土数値情報（行政区域データ）",
    owner: "国土交通省",
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html",
  },
  {
    title: "日本の地域別将来推計人口（令和5年推計）",
    owner: "国立社会保障・人口問題研究所",
    url: "https://www.ipss.go.jp/pp-shicyoson/j/shicyoson23/t-page.asp",
  },
] as const;

export const App = () => (
  <main className="min-h-screen bg-surface p-8 font-sans text-text">
    <h1 className="text-2xl font-bold">RightsizingJPMap</h1>
    <p className="mt-2 text-text-muted">地図の画面は準備中です。</p>
    <section className="mt-8 text-sm text-text-muted">
      <h2 className="font-bold">出典</h2>
      <ul className="mt-2 space-y-1">
        {SOURCES.map((s) => (
          <li key={s.url}>
            「{s.title}」（{s.owner}）（
            <a className="text-accent underline" href={s.url}>
              {s.url}
            </a>
            ）を加工して作成
          </li>
        ))}
      </ul>
    </section>
  </main>
);
