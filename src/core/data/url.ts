// 生成物の URL の組み立て。本番（GitHub Pages）では、生成物をアプリと同じオリジンの
// `<base>data/<版>/` に置く（docs/design/map-and-hosting.md の「データの配信」）。
// 開発サーバーも同じパスで pipeline/out/ を配る（tools/serve-data.ts）。

import type { adminGeomFile, DATA_FILES } from "./schema";
import { DATA_VERSION } from "./schema";

/** 生成物のファイルの、データの置き場からの相対パス */
export type DataFile =
  | (typeof DATA_FILES)[keyof typeof DATA_FILES]
  | ReturnType<typeof adminGeomFile>;

/** データの置き場の、アプリの base からの相対パス。末尾は / */
export const DATA_DIR = `data/${DATA_VERSION}/`;

/**
 * 生成物の URL を組み立てる。
 * appBase はアプリの base（vite.config.ts の base）を絶対 URL にしたものである。
 * 末尾に / がなければ補う。
 */
export const dataUrl = (appBase: string, file: DataFile): string =>
  `${appBase.endsWith("/") ? appBase : `${appBase}/`}${DATA_DIR}${file}`;
