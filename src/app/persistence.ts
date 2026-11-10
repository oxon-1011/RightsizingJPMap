// 目録とデータのファイルの読み書き（docs/design/user-data.md の「永続化」「書き込みの手順」「複数のタブ」）。
// 目録の中身の検査と更新は core の storage/manifest.ts で行い、ここでは順序と排他だけを決める。
// - 取り込みは、データのファイルを書いてから目録を書く。目録の更新を取り込みの確定とみなす。
// - 削除は、目録を書いてからデータのファイルを消す。消し損ねたファイルは、次の起動で掃除する。
// - 書き込みは1つずつ順に行い、目録を書くたびにほかのタブに知らせる。

import { err, ok, type Result } from "../core/result";
import {
  addDataset,
  type DatasetEntry,
  datasetFileName,
  EMPTY_MANIFEST,
  type LayerStyle,
  type Manifest,
  orphanDatasetFiles,
  parseManifest,
  removeDataset,
  serializeManifest,
  updateDatasetStyle,
} from "../core/storage/manifest";
import type { DatasetStorage } from "../io/opfs";
import type { ManifestChannel } from "../io/tabs";
import type { AppError } from "./ports";

export type Persistence = {
  /** 最後に読んだか書いた目録 */
  readonly manifest: () => Manifest;
  /** 目録を読み直す。読めなければ失敗を返し、持っている目録は変えない */
  readonly load: () => Promise<Result<Manifest, AppError>>;
  /** 目録にないデータのファイルを消す。書き込みの権利を持つタブだけが呼ぶ */
  readonly removeOrphans: () => Promise<void>;
  readonly add: (entry: DatasetEntry, bytes: Uint8Array) => Promise<Result<Manifest, AppError>>;
  readonly remove: (id: string) => Promise<Result<Manifest, AppError>>;
  readonly clear: () => Promise<Result<Manifest, AppError>>;
  readonly updateStyle: (
    id: string,
    style: Partial<LayerStyle>,
  ) => Promise<Result<Manifest, AppError>>;
};

export const createPersistence = (deps: {
  readonly storage: DatasetStorage;
  readonly channel: ManifestChannel | null;
  readonly report: (error: AppError) => void;
}): Persistence => {
  const { storage } = deps;
  let current: Manifest = EMPTY_MANIFEST;
  /** 目録を正しく読めたか。読めなかった目録のもとでは、ファイルを掃除しない */
  let loaded = false;

  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const notify = (): void => {
    const sent = deps.channel?.notify();
    if (sent !== undefined && !sent.ok) {
      deps.report({ kind: "tabs", error: sent.error });
    }
  };

  const writeManifest = async (next: Manifest): Promise<Result<Manifest, AppError>> => {
    const written = await storage.writeManifest(serializeManifest(next));
    if (!written.ok) {
      return err({ kind: "storage", error: written.error });
    }
    current = next;
    loaded = true;
    notify();
    return ok(next);
  };

  const load = async (): Promise<Result<Manifest, AppError>> => {
    const result = await readManifest();
    // 読めなかったときは、前に読んだ目録でファイルを掃除しないようにする（ほかのタブが足したデータを消さないため）
    loaded = result.ok;
    return result;
  };

  const readManifest = async (): Promise<Result<Manifest, AppError>> => {
    const read = await storage.readManifest();
    if (!read.ok) {
      return err({ kind: "storage", error: read.error });
    }
    if (read.value === null) {
      current = EMPTY_MANIFEST;
      return ok(current);
    }
    let json: unknown;
    try {
      json = JSON.parse(read.value);
    } catch (e) {
      return err({
        kind: "manifest",
        error: { kind: "invalid-json", message: e instanceof Error ? e.message : String(e) },
      });
    }
    const parsed = parseManifest(json);
    if (!parsed.ok) {
      return err({ kind: "manifest", error: parsed.error });
    }
    current = parsed.value;
    return ok(current);
  };

  const removeOrphans = (): Promise<void> =>
    exclusive(async () => {
      if (!loaded) {
        return;
      }
      const listed = await storage.listDatasets();
      if (!listed.ok) {
        deps.report({ kind: "storage", error: listed.error });
        return;
      }
      for (const name of orphanDatasetFiles(current, listed.value)) {
        const removed = await storage.removeDataset(name);
        if (!removed.ok) {
          deps.report({ kind: "storage", error: removed.error });
        }
      }
    });

  const add = (entry: DatasetEntry, bytes: Uint8Array): Promise<Result<Manifest, AppError>> =>
    exclusive(async () => {
      const next = addDataset(current, entry);
      if (!next.ok) {
        return err({ kind: "manifest", error: next.error });
      }
      const name = datasetFileName(entry);
      const written = await storage.writeDataset(name, bytes);
      if (!written.ok) {
        return err({ kind: "storage", error: written.error });
      }
      const committed = await writeManifest(next.value);
      if (!committed.ok) {
        // 目録に載らなかったファイルは残さない。消し損ねても、次の起動で掃除する
        await storage.removeDataset(name);
      }
      return committed;
    });

  const remove = (id: string): Promise<Result<Manifest, AppError>> =>
    exclusive(async () => {
      const entry = current.datasets.find((d) => d.id === id);
      const committed = await writeManifest(removeDataset(current, id));
      if (committed.ok && entry !== undefined) {
        const removed = await storage.removeDataset(datasetFileName(entry));
        if (!removed.ok) {
          deps.report({ kind: "storage", error: removed.error });
        }
      }
      return committed;
    });

  const clear = (): Promise<Result<Manifest, AppError>> =>
    exclusive(async () => {
      // 先に空の目録を書く。すべてを消す途中で失敗しても、残ったファイルは次の起動で掃除される
      const committed = await writeManifest(EMPTY_MANIFEST);
      if (!committed.ok) {
        return committed;
      }
      const cleared = await storage.clear();
      if (!cleared.ok) {
        deps.report({ kind: "storage", error: cleared.error });
      }
      return committed;
    });

  const updateStyle = (
    id: string,
    style: Partial<LayerStyle>,
  ): Promise<Result<Manifest, AppError>> =>
    exclusive(() => writeManifest(updateDatasetStyle(current, id, style)));

  return {
    manifest: () => current,
    load,
    removeOrphans,
    add,
    remove,
    clear,
    updateStyle,
  };
};
