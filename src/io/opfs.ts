// 自前データの置き場所。OPFS の /rjm/ の下に、目録（manifest.json）とデータのファイルを置く
// （docs/design/user-data.md の「永続化」）。OPFS が使えない環境では、同じ操作をメモリ上で行う。
// 目録の中身の解釈と、どのファイルを消すかの判断は core に任せ、ここでは文字列とバイト列を読み書きするだけにする。

import { err, ok, type Result } from "../core/result";

const ROOT_DIRECTORY = "rjm";
const DATASETS_DIRECTORY = "datasets";
const MANIFEST_FILE = "manifest.json";

export type StorageError =
  | { readonly kind: "not-found"; readonly name: string }
  /** ファイル名として使えない名前（空、"."、".."、"/" や "\" を含む） */
  | { readonly kind: "invalid-name"; readonly name: string }
  | { readonly kind: "quota-exceeded"; readonly name: string }
  | { readonly kind: "failed"; readonly name: string; readonly message: string };

/** メモリ上で動かす理由 */
export type MemoryReason =
  /** navigator.storage.getDirectory がない */
  | "no-opfs"
  /** getDirectory が失敗した（Firefox のプライベートウィンドウなど） */
  | "opfs-denied"
  /** メインスレッドから書き込む createWritable がない（古い Safari など） */
  | "no-writable"
  /** 呼び出し側がメモリ上での動作を選んだ */
  | "requested";

type StorageOperations = {
  /** 目録を読む。まだ書いていなければ null を返す */
  readonly readManifest: () => Promise<Result<string | null, StorageError>>;
  /** 目録を書く。書き込みは置き換えで、途中で失敗しても前の内容が残る */
  readonly writeManifest: (text: string) => Promise<Result<void, StorageError>>;
  /** データのファイルの名前の一覧（datasets/ の直下のファイル） */
  readonly listDatasets: () => Promise<Result<readonly string[], StorageError>>;
  readonly readDataset: (name: string) => Promise<Result<Uint8Array, StorageError>>;
  readonly writeDataset: (name: string, bytes: Uint8Array) => Promise<Result<void, StorageError>>;
  readonly removeDataset: (name: string) => Promise<Result<void, StorageError>>;
  /** 目録とデータのファイルを、すべて消す */
  readonly clear: () => Promise<Result<void, StorageError>>;
};

export type DatasetStorage = StorageOperations &
  (
    | { readonly kind: "opfs" }
    | {
        readonly kind: "memory";
        readonly reason: MemoryReason;
      }
  );

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const toStorageError = (name: string, e: unknown): StorageError => {
  if (e instanceof DOMException) {
    if (e.name === "NotFoundError") return { kind: "not-found", name };
    if (e.name === "QuotaExceededError") return { kind: "quota-exceeded", name };
  }
  // 使えない名前を渡すと、OPFS は TypeError を投げる
  if (e instanceof TypeError) return { kind: "invalid-name", name };
  return { kind: "failed", name, message: messageOf(e) };
};

const attempt = async <T>(
  name: string,
  run: () => Promise<T>,
): Promise<Result<T, StorageError>> => {
  try {
    return ok(await run());
  } catch (e) {
    return err(toStorageError(name, e));
  }
};

/** OPFS と同じ規則で、ファイル名として使えない名前を見分ける。メモリ上の実装でも同じ名前を拒否するために使う */
const isInvalidName = (name: string): boolean =>
  name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\");

// OPFS の操作

/** createWritable が受け付ける、ArrayBuffer の上のビューにする。SharedArrayBuffer の上のときだけ複製する */
const toWritableChunk = (data: string | Uint8Array): string | Uint8Array<ArrayBuffer> => {
  if (typeof data === "string") return data;
  const { buffer } = data;
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer, data.byteOffset, data.byteLength)
    : data.slice();
};

const writeFile = async (
  directory: FileSystemDirectoryHandle,
  name: string,
  data: string | Uint8Array,
): Promise<void> => {
  const handle = await directory.getFileHandle(name, { create: true });
  // createWritable は一時ファイルに書き、close で置き換える。abort すれば元の内容が残る
  const writable = await handle.createWritable();
  try {
    await writable.write(toWritableChunk(data));
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => undefined);
    throw e;
  }
};

const readFile = async (directory: FileSystemDirectoryHandle, name: string): Promise<File> =>
  (await directory.getFileHandle(name)).getFile();

const openOpfsStorage = (root: FileSystemDirectoryHandle): DatasetStorage => {
  // 全削除のあとも使えるよう、ディレクトリは操作のたびに引き直す
  const rootDirectory = () => root.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
  const datasetsDirectory = async () =>
    (await rootDirectory()).getDirectoryHandle(DATASETS_DIRECTORY, { create: true });

  return {
    kind: "opfs",
    readManifest: async () => {
      const directory = await attempt(MANIFEST_FILE, rootDirectory);
      if (!directory.ok) return directory;
      const file = await attempt(MANIFEST_FILE, () => readFile(directory.value, MANIFEST_FILE));
      if (!file.ok) return file.error.kind === "not-found" ? ok(null) : file;
      return attempt(MANIFEST_FILE, () => file.value.text());
    },
    writeManifest: (text) =>
      attempt(MANIFEST_FILE, async () => writeFile(await rootDirectory(), MANIFEST_FILE, text)),
    listDatasets: () =>
      attempt(DATASETS_DIRECTORY, async () => {
        const names: string[] = [];
        for await (const [name, handle] of (await datasetsDirectory()).entries()) {
          if (handle.kind === "file") names.push(name);
        }
        return names.sort();
      }),
    readDataset: (name) =>
      attempt(
        name,
        async () =>
          new Uint8Array(await (await readFile(await datasetsDirectory(), name)).arrayBuffer()),
      ),
    writeDataset: (name, bytes) =>
      attempt(name, async () => writeFile(await datasetsDirectory(), name, bytes)),
    removeDataset: (name) =>
      attempt(name, async () => (await datasetsDirectory()).removeEntry(name)),
    clear: () =>
      attempt(ROOT_DIRECTORY, async () => {
        try {
          await root.removeEntry(ROOT_DIRECTORY, { recursive: true });
        } catch (e) {
          if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
        }
      }),
  };
};

/** メモリ上で、OPFS の実装と同じ操作を行う。再読み込みで消える */
export const openMemoryStorage = (reason: MemoryReason = "requested"): DatasetStorage => {
  let manifest: string | null = null;
  const datasets = new Map<string, Uint8Array>();
  const checked = <T>(
    name: string,
    run: () => Result<T, StorageError>,
  ): Promise<Result<T, StorageError>> =>
    Promise.resolve(isInvalidName(name) ? err({ kind: "invalid-name", name }) : run());

  return {
    kind: "memory",
    reason,
    readManifest: () => Promise.resolve(ok(manifest)),
    writeManifest: (text) => {
      manifest = text;
      return Promise.resolve(ok(undefined));
    },
    listDatasets: () => Promise.resolve(ok([...datasets.keys()].sort())),
    readDataset: (name) =>
      checked(name, () => {
        const bytes = datasets.get(name);
        return bytes === undefined ? err({ kind: "not-found", name }) : ok(bytes.slice());
      }),
    writeDataset: (name, bytes) =>
      checked(name, () => {
        datasets.set(name, bytes.slice());
        return ok(undefined);
      }),
    removeDataset: (name) =>
      checked(name, () =>
        datasets.delete(name) ? ok(undefined) : err({ kind: "not-found", name }),
      ),
    clear: () => {
      manifest = null;
      datasets.clear();
      return Promise.resolve(ok(undefined));
    },
  };
};

/**
 * 自前データの置き場所を開く。OPFS が使えればそれを、使えなければメモリ上の実装を返す。
 * どちらになったかは kind で、メモリ上になった理由は reason で分かる。
 */
export const openStorage = async (): Promise<DatasetStorage> => {
  if (typeof navigator.storage?.getDirectory !== "function") return openMemoryStorage("no-opfs");
  if (
    typeof FileSystemFileHandle === "undefined" ||
    typeof FileSystemFileHandle.prototype.createWritable !== "function"
  ) {
    return openMemoryStorage("no-writable");
  }
  try {
    return openOpfsStorage(await navigator.storage.getDirectory());
  } catch {
    return openMemoryStorage("opfs-denied");
  }
};

export type PersistError =
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * navigator.storage.persist() を呼び、ブラウザの判断でデータが消されにくくする。
 * 許可されたかどうかを返す。最初の取り込みのときに呼ぶ（docs/design/user-data.md）。
 */
export const requestPersistence = async (): Promise<Result<boolean, PersistError>> => {
  if (typeof navigator.storage?.persist !== "function") return err({ kind: "unsupported" });
  try {
    return ok(await navigator.storage.persist());
  } catch (e) {
    return err({ kind: "failed", message: messageOf(e) });
  }
};

/** すでに永続化が許可されているかを返す */
export const isPersisted = async (): Promise<Result<boolean, PersistError>> => {
  if (typeof navigator.storage?.persisted !== "function") return err({ kind: "unsupported" });
  try {
    return ok(await navigator.storage.persisted());
  } catch (e) {
    return err({ kind: "failed", message: messageOf(e) });
  }
};
