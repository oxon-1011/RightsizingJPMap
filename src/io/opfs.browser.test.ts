import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../core/result";
import {
  type DatasetStorage,
  isPersisted,
  openMemoryStorage,
  openStorage,
  requestPersistence,
} from "./opfs";

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const bytesOf = (...values: readonly number[]): Uint8Array => new Uint8Array(values);

afterEach(() => {
  vi.restoreAllMocks();
});

// OPFS とメモリ上の実装は、同じ操作に同じ結果を返す
describe.each([
  ["opfs", () => openStorage()],
  ["memory", () => Promise.resolve(openMemoryStorage())],
] as const)("%s の置き場所", (kind, open) => {
  let storage: DatasetStorage;

  beforeEach(async () => {
    storage = await open();
    expect(storage.kind).toBe(kind);
    unwrap(await storage.clear());
  });

  it("目録をまだ書いていなければ null を返す", async () => {
    expect(await storage.readManifest()).toEqual({ ok: true, value: null });
  });

  it("目録を書いて読み、短い内容で上書きすると前の内容が残らない", async () => {
    unwrap(await storage.writeManifest('{"schema_version":1,"datasets":[{"id":"a"}]}'));
    expect(unwrap(await storage.readManifest())).toBe(
      '{"schema_version":1,"datasets":[{"id":"a"}]}',
    );
    unwrap(await storage.writeManifest("{}"));
    expect(unwrap(await storage.readManifest())).toBe("{}");
  });

  it("データのファイルを書いて読み、名前の一覧を返す", async () => {
    unwrap(await storage.writeDataset("b.parquet", bytesOf(1, 2, 3)));
    unwrap(await storage.writeDataset("a.geojson", bytesOf(4)));
    expect(unwrap(await storage.readDataset("b.parquet"))).toEqual(bytesOf(1, 2, 3));
    expect(unwrap(await storage.listDatasets())).toEqual(["a.geojson", "b.parquet"]);
  });

  it("書いたあとに呼び出し側のバイト列を書き換えても、保存した内容は変わらない", async () => {
    const bytes = bytesOf(1, 2, 3);
    unwrap(await storage.writeDataset("x.parquet", bytes));
    bytes[0] = 9;
    expect(unwrap(await storage.readDataset("x.parquet"))).toEqual(bytesOf(1, 2, 3));
  });

  it("バイト列の一部を指すビューを書くと、その範囲だけが保存される", async () => {
    const view = bytesOf(0, 1, 2, 3, 4).subarray(1, 3);
    unwrap(await storage.writeDataset("view.parquet", view));
    expect(unwrap(await storage.readDataset("view.parquet"))).toEqual(bytesOf(1, 2));
  });

  it("目録にないファイルの掃除のため、指定したファイルだけを消す", async () => {
    unwrap(await storage.writeDataset("keep.parquet", bytesOf(1)));
    unwrap(await storage.writeDataset("orphan.parquet", bytesOf(2)));
    unwrap(await storage.removeDataset("orphan.parquet"));
    expect(unwrap(await storage.listDatasets())).toEqual(["keep.parquet"]);
  });

  it("ないファイルの読み込みと削除は not-found になる", async () => {
    expect(await storage.readDataset("missing.parquet")).toEqual({
      ok: false,
      error: { kind: "not-found", name: "missing.parquet" },
    });
    expect(await storage.removeDataset("missing.parquet")).toEqual({
      ok: false,
      error: { kind: "not-found", name: "missing.parquet" },
    });
  });

  it("ファイル名に使えない名前は invalid-name になる", async () => {
    for (const name of ["", ".", "..", "a/b.parquet", "a\\b.parquet"]) {
      expect(await storage.writeDataset(name, bytesOf(1))).toEqual({
        ok: false,
        error: { kind: "invalid-name", name },
      });
    }
  });

  it("全削除で目録とデータのファイルが消え、そのあとも書き込める", async () => {
    unwrap(await storage.writeManifest("{}"));
    unwrap(await storage.writeDataset("a.parquet", bytesOf(1)));
    unwrap(await storage.clear());
    expect(unwrap(await storage.readManifest())).toBeNull();
    expect(unwrap(await storage.listDatasets())).toEqual([]);
    unwrap(await storage.writeDataset("b.parquet", bytesOf(2)));
    expect(unwrap(await storage.listDatasets())).toEqual(["b.parquet"]);
  });
});

describe("OPFS の置き場所", () => {
  beforeEach(async () => {
    unwrap(await (await openStorage()).clear());
  });

  it("/rjm/manifest.json と /rjm/datasets/<名前> に書く", async () => {
    const storage = await openStorage();
    unwrap(await storage.writeManifest("{}"));
    unwrap(await storage.writeDataset("a.parquet", bytesOf(7)));

    const root = await navigator.storage.getDirectory();
    const rjm = await root.getDirectoryHandle("rjm");
    expect(await (await (await rjm.getFileHandle("manifest.json")).getFile()).text()).toBe("{}");
    const datasets = await rjm.getDirectoryHandle("datasets");
    const file = await (await datasets.getFileHandle("a.parquet")).getFile();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytesOf(7));
  });

  it("別に開いた置き場所（別のタブにあたる）からも、同じ内容が見える", async () => {
    const writer = await openStorage();
    const reader = await openStorage();
    unwrap(await writer.writeManifest('{"v":1}'));
    unwrap(await writer.writeDataset("a.parquet", bytesOf(1)));
    expect(unwrap(await reader.readManifest())).toBe('{"v":1}');
    expect(unwrap(await reader.listDatasets())).toEqual(["a.parquet"]);
  });

  it("datasets/ の下のディレクトリは一覧に含めない", async () => {
    const storage = await openStorage();
    unwrap(await storage.writeDataset("a.parquet", bytesOf(1)));
    const rjm = await (await navigator.storage.getDirectory()).getDirectoryHandle("rjm");
    await (await rjm.getDirectoryHandle("datasets")).getDirectoryHandle("nested", { create: true });
    expect(unwrap(await storage.listDatasets())).toEqual(["a.parquet"]);
  });
});

describe("OPFS が使えないときの切り替え", () => {
  it("getDirectory が失敗する環境（Firefox のプライベートウィンドウなど）では、メモリ上で動く", async () => {
    vi.spyOn(StorageManager.prototype, "getDirectory").mockRejectedValue(
      new DOMException("The operation is insecure.", "SecurityError"),
    );
    const storage = await openStorage();
    expect(storage).toMatchObject({ kind: "memory", reason: "opfs-denied" });
    unwrap(await storage.writeDataset("a.parquet", bytesOf(1)));
    expect(unwrap(await storage.listDatasets())).toEqual(["a.parquet"]);
  });

  it("createWritable がない環境では、メモリ上で動く", async () => {
    const original = Object.getOwnPropertyDescriptor(
      FileSystemFileHandle.prototype,
      "createWritable",
    );
    Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(await openStorage()).toMatchObject({ kind: "memory", reason: "no-writable" });
    } finally {
      if (original !== undefined) {
        Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", original);
      }
    }
    expect((await openStorage()).kind).toBe("opfs");
  });

  it("メモリ上の置き場所は、開くたびに空から始まる（再読み込みで消える）", async () => {
    const first = openMemoryStorage();
    unwrap(await first.writeManifest("{}"));
    expect(unwrap(await openMemoryStorage().readManifest())).toBeNull();
  });
});

describe("永続化の要求", () => {
  it("navigator.storage.persist() の結果を真偽値で返す", async () => {
    const granted = unwrap(await requestPersistence());
    expect(typeof granted).toBe("boolean");
    expect(unwrap(await isPersisted())).toBe(granted);
  });

  it("persist がない環境では unsupported を返す", async () => {
    const original = Object.getOwnPropertyDescriptor(StorageManager.prototype, "persist");
    Object.defineProperty(StorageManager.prototype, "persist", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(await requestPersistence()).toEqual({ ok: false, error: { kind: "unsupported" } });
    } finally {
      if (original !== undefined) {
        Object.defineProperty(StorageManager.prototype, "persist", original);
      }
    }
  });
});
