import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { servePipelineData } from "./tools/serve-data";

export default defineConfig({
  // GitHub Pages のプロジェクトサイト（https://oxon-1011.github.io/RightsizingJPMap/）で配信する
  base: "/RightsizingJPMap/",
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // 開発サーバーで pipeline/out/ を data/<版>/ として配る
    servePipelineData(),
  ],
  test: {
    // node は `pnpm test`（CI でも実行する）、browser は `pnpm test:browser`（Chromium が要る）で動かす
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tools/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "src/**/*.browser.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        // テストの途中で依存の最適化が走ると、Vite がページを読み込み直してテストが失敗するので、先に済ませておく
        optimizeDeps: {
          include: [
            "@duckdb/duckdb-wasm",
            "hyparquet",
            "hyparquet-compressors",
            "maplibre-gl",
            "pmtiles",
            "@deck.gl/layers",
            "@deck.gl/mapbox",
            // 依存の置き場が空のとき、テストの途中でこれを変換してページを読み込み直した（2026-11-09 の CI）
            "react-dom/client",
            "zustand/vanilla",
            // main.tsx から app/instance.ts を読むようになり、テストの途中でこれを変換して読み込み直した（2026-11-10）
            "zustand",
          ],
        },
        test: {
          name: "browser",
          include: ["src/io/**/*.browser.test.ts", "src/app/**/*.browser.test.ts"],
          // DuckDB-WASM の起動と spatial 拡張の取得に時間がかかる
          testTimeout: 60_000,
          hookTimeout: 60_000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
            // 画面を見るテストではないので、失敗時のスクリーンショット（.vitest/ に書かれる）を撮らない
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
