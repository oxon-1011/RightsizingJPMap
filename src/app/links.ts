// 画面から開く外部向けの文書の URL（D16）。
// docs/user/ は Git で管理し、画面のリンクは GitHub 上のページを指す（2026-11-09 に持ち主が決めた）。

const REPOSITORY_URL = "https://github.com/oxon-1011/RightsizingJPMap";

const userDocUrl = (file: string): string => `${REPOSITORY_URL}/blob/main/docs/user/${file}`;

/** 出典と加工の表示の詳細。地図の右下の「出典の詳細」が指す（startMap の attributionDetailsUrl） */
export const ATTRIBUTION_DETAILS_URL = userDocUrl("attribution.md");

/** 自前データの受け入れ条件。取り込めなかったときの通知が指す（NoticeList の acceptanceUrl） */
export const ACCEPTANCE_URL = userDocUrl("acceptance.md");
