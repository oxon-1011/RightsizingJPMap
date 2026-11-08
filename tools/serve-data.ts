// 開発サーバーで、前処理の生成物（pipeline/out/）を本番と同じパス（<base>data/<版>/）で配る。
// 配信は Vite の静的ファイルの配信（sirv）に任せる。本番の GitHub Pages と同じく、
// Range リクエストに 206 を返し、圧縮しない（docs/design/map-and-hosting.md の「データの配信」）。

import type { Plugin } from "vite";
import { DATA_DIR } from "../src/core/data/url";

/** 生成物を置くディレクトリ。プロジェクトのルートからの相対パスで、末尾は / */
export const PIPELINE_OUT_DIR = "pipeline/out/";

/**
 * リクエストの URL が生成物を指していれば、pipeline/out/ の下を指す URL に書き換えて返す。
 * 生成物を指していなければ null を返す。base は vite.config.ts の base で、前後に / が付く。
 */
export const toPipelineOutUrl = (url: string, base: string): string | null => {
  const prefix = `${base}${DATA_DIR}`;
  return url.startsWith(prefix) ? `${base}${PIPELINE_OUT_DIR}${url.slice(prefix.length)}` : null;
};

const NOT_FOUND_MESSAGE = `${PIPELINE_OUT_DIR} に生成物がない。mise run pipeline で作るか、mise run data:download で GitHub Release から取り出す。\n`;

export const servePipelineData = (): Plugin => ({
  name: "rjm:serve-pipeline-data",
  apply: "serve",
  configureServer(server) {
    const { base } = server.config;
    const rewritten = new WeakSet<object>();
    // Vite の中のミドルウェアより前に呼ばれ、base を取り除く前の URL を受け取る
    server.middlewares.use((req, _res, next) => {
      const target = req.url === undefined ? null : toPipelineOutUrl(req.url, base);
      if (target !== null) {
        rewritten.add(req);
        req.url = target;
      }
      next();
    });
    // 静的ファイルの配信で見つからなかった生成物は、ここに届く。index.html を返させずに 404 にする
    return () => {
      server.middlewares.use((req, res, next) => {
        if (!rewritten.has(req)) {
          next();
          return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(NOT_FOUND_MESSAGE);
      });
    };
  },
});
