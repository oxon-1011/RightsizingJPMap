// 取り込みから OPFS への保存、読み込み直したあとの復元までを、ブラウザの io で通して確かめる。
// 地図とベースデータの配信だけは偽物にする（ベースデータは tests/fixtures/ の鳥取県の分）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import type { DataFile } from "../core/data/url";
import { err, ok } from "../core/result";
import { openParquetBuffer } from "../io/parquet";
import { browserPorts } from "./browser-ports";
import { createApp } from "./create-app";
import { fakeMap } from "./fake-map";
import type { AppError, AppPorts } from "./ports";

const FIXTURES: Partial<Record<DataFile, string>> = {
  "mesh_indicators.parquet": "tests/fixtures/mesh_indicators.tottori.parquet",
  "municipal_indicators.parquet": "tests/fixtures/municipal_indicators.tottori.parquet",
  "admin_geom/31.parquet": "tests/fixtures/admin_geom.tottori.parquet",
};

const fixtureBytes = async (file: DataFile): Promise<Uint8Array<ArrayBuffer> | null> => {
  const path = FIXTURES[file];
  if (path === undefined) return null;
  const text = await commands.readFile(path, { encoding: "base64" });
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
};

const clearOpfs = async (): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("rjm", { recursive: true }).catch(() => undefined);
};

/** ブラウザの口のうち、ベースデータの配信と地図だけを差し替える */
const ports = (errors: AppError[]) => {
  const map = fakeMap();
  const real = browserPorts();
  const value: AppPorts<HTMLElement> = {
    ...real,
    openBaseParquet: async (file) => {
      const bytes = await fixtureBytes(file);
      return bytes === null
        ? err({ kind: "fetch-failed", message: file })
        : openParquetBuffer(bytes.buffer);
    },
    fetchBaseJson: (file) =>
      Promise.resolve(
        file === "admin_geom/index.json"
          ? ok({ "31": [133.1, 35.0, 134.5, 35.7] })
          : err({ kind: "fetch-failed", message: file }),
      ),
    fetchBaseBytes: async (file) => {
      const bytes = await fixtureBytes(file);
      return bytes === null ? err({ kind: "fetch-failed", message: file }) : ok(bytes);
    },
    startMap: () => Promise.resolve(ok(map.view)),
    report: (error) => {
      errors.push(error);
    },
  };
  return { ports: value, calls: map.calls };
};

beforeEach(clearOpfs);
afterEach(clearOpfs);

describe("取り込みと復元", () => {
  it("CSV を正規化して OPFS に書き、読み込み直したあとに指標として塗れる", async () => {
    const errors: AppError[] = [];
    const first = createApp(ports(errors).ports);
    await first.boot();
    expect(first.store.getState().runtime.storage).toBe("opfs");
    await first.importFiles([
      new File(["code,病床数,名称\n31201,10,a\n31202,5,b\n31201,1,c\n"], "病床.csv"),
    ]);
    const [entry] = first.store.getState().state.datasets;
    expect(entry).toMatchObject({ kind: "table", join: ["municipality"], count: 3 });
    await first.dispose();

    // 読み込み直したタブ。目録から復元し、正規化した Parquet を hyparquet で読む
    const { ports: secondPorts, calls } = ports(errors);
    const second = createApp(secondPorts);
    await second.boot();
    expect(second.store.getState().state.access).toBe("writer");
    expect(second.store.getState().state.datasets).toEqual([entry]);
    await second.attachMap(document.createElement("div"));
    second.dispatch({ type: "unit-selected", unit: "municipality" });
    second.dispatch({
      type: "indicator-selected",
      indicator: {
        kind: "joined",
        datasetId: entry?.id ?? "",
        measure: { kind: "sum", column: "病床数" },
        perPopulation: null,
      },
    });
    await expect.poll(() => second.store.getState().runtime.joinedClassification).not.toBeNull();
    const admin = calls.filter((c) => c.kind === "admin").at(-1);
    expect(admin?.kind === "admin" && admin.spec.colors.size).toBe(19);
    expect(errors).toEqual([]);
    await second.dispose();
  });

  it("2つめのタブは閲覧専用で、1つめのタブが閉じると書き込めるようになる", async () => {
    const errors: AppError[] = [];
    const first = createApp(ports(errors).ports);
    const second = createApp(ports(errors).ports);
    await first.boot();
    await second.boot();
    expect(second.store.getState().state.access).toBe("read-only");

    await first.importFiles([new File(["lat,lon\n35.4941,134.2253\n"], "点.csv")]);
    // BroadcastChannel の通知で、2つめのタブが目録を読み直す
    await expect.poll(() => second.store.getState().state.datasets.length).toBe(1);

    await first.dispose();
    await expect.poll(() => second.store.getState().state.access).toBe("writer");
    await second.removeDataset(second.store.getState().state.datasets[0]?.id ?? "");
    expect(second.store.getState().state.datasets).toEqual([]);
    expect(errors).toEqual([]);
    await second.dispose();
  });
});
