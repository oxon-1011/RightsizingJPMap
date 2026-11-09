// 生成物と public/ のファイルの URL を、いま開いているページの場所から組み立てる。
// 開発サーバーと本番のどちらでも、生成物はアプリの base の下の data/<版>/ を指す（src/core/data/url.ts）。

import { type DataFile, dataUrl } from "../core/data/url";

/** アプリの base（vite.config.ts の base）を、いまのページの URL を基準に絶対 URL にしたもの */
export const appBaseUrl = (): string =>
  new URL(import.meta.env.BASE_URL, window.location.href).href;

export const baseDataUrl = (file: DataFile): string => dataUrl(appBaseUrl(), file);

/** public/ に置いたファイル（背景地図のスタイルなど）の URL */
export const publicFileUrl = (path: string): string => new URL(path, appBaseUrl()).href;
