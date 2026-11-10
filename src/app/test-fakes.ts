// node のテストで手続きに渡す、副作用の口の偽物。テストからだけ使う。
// ベースデータは tests/fixtures/ の鳥取県の Parquet を hyparquet で読む（ブラウザの代わりにファイルから読む）。

import { readFileSync } from "node:fs";
import type { ColumnSchema, ColumnValues, TableJoinPlan } from "../core/accept/table";
import type { BBox, Place } from "../core/data/schema";
import type { DataFile } from "../core/data/url";
import { err, ok, type Result } from "../core/result";
import { type DatasetStorage, openMemoryStorage } from "../io/opfs";
import { openParquetBuffer } from "../io/parquet";
import type { ManifestChannel, WriterLock } from "../io/tabs";
import { fakeMap } from "./fake-map";
import type {
  AppError,
  AppPorts,
  FetchError,
  MapView,
  TableEngine,
  TableEngineError,
  TableSource,
} from "./ports";

const FIXTURES: Partial<Record<DataFile, string>> = {
  "mesh_indicators.parquet": "tests/fixtures/mesh_indicators.tottori.parquet",
  "municipal_indicators.parquet": "tests/fixtures/municipal_indicators.tottori.parquet",
  "admin_geom/31.parquet": "tests/fixtures/admin_geom.tottori.parquet",
};

const fixtureBytes = (file: DataFile): Uint8Array | null => {
  const path = FIXTURES[file];
  return path === undefined ? null : new Uint8Array(readFileSync(path));
};

/** 鳥取県の範囲（admin_geom/index.json の 31 と同じ程度） */
export const TOTTORI_BBOX: BBox = [133.1, 35.0, 134.5, 35.7];

export const SAMPLE_PLACES: readonly Place[] = [
  { code: "31000", name: "鳥取県", pref_name: "鳥取県", kind: "prefecture", bbox: TOTTORI_BBOX },
  {
    code: "31201",
    name: "鳥取市",
    pref_name: "鳥取県",
    kind: "municipality",
    bbox: [133.9, 35.2, 134.4, 35.6],
  },
];

/** 偽物の OPFS。メモリ上の置き場所を、OPFS として扱わせる。複数のタブの偽物で共有できる */
export const fakeOpfs = (): DatasetStorage => {
  const memory = openMemoryStorage();
  return {
    kind: "opfs",
    readManifest: memory.readManifest,
    writeManifest: memory.writeManifest,
    listDatasets: memory.listDatasets,
    readDataset: memory.readDataset,
    writeDataset: memory.writeDataset,
    removeDataset: memory.removeDataset,
    clear: memory.clear,
  };
};

/** 置き場所の操作を順に記録する */
export const recordStorage = (
  storage: DatasetStorage,
): { readonly storage: DatasetStorage; readonly log: string[] } => {
  const log: string[] = [];
  return {
    log,
    storage: {
      ...storage,
      writeManifest: (text) => {
        log.push("writeManifest");
        return storage.writeManifest(text);
      },
      writeDataset: (name, bytes) => {
        log.push(`writeDataset ${name}`);
        return storage.writeDataset(name, bytes);
      },
      removeDataset: (name) => {
        log.push(`removeDataset ${name}`);
        return storage.removeDataset(name);
      },
      clear: () => {
        log.push("clear");
        return storage.clear();
      },
    },
  };
};

/** 同じオリジンのタブが共有する、書き込みのロックの偽物（Web Locks の代わり） */
export const fakeLocks = () => {
  let holder: number | null = null;
  const waiting: { readonly id: number; readonly onPromoted: () => void }[] = [];
  let nextId = 1;
  const acquire = (options: {
    readonly onPromoted: () => void;
  }): Promise<Result<WriterLock, never>> => {
    const id = nextId++;
    const role = holder === null ? "writer" : "reader";
    if (role === "writer") {
      holder = id;
    } else {
      waiting.push({ id, onPromoted: options.onPromoted });
    }
    const release = (): Promise<void> => {
      if (holder === id) {
        holder = null;
        const next = waiting.shift();
        if (next !== undefined) {
          holder = next.id;
          next.onPromoted();
        }
      } else {
        const i = waiting.findIndex((w) => w.id === id);
        if (i >= 0) {
          waiting.splice(i, 1);
        }
      }
      return Promise.resolve();
    };
    return Promise.resolve(ok({ role, release }));
  };
  return { acquire };
};

/** 同じオリジンのタブが共有する、BroadcastChannel の偽物。送ったチャンネル自身には届かない */
export const fakeChannels = () => {
  const channels = new Set<{ readonly listeners: Set<() => void> }>();
  const open = (): Result<ManifestChannel, never> => {
    const self = { listeners: new Set<() => void>() };
    channels.add(self);
    return ok({
      notify: () => {
        for (const other of channels) {
          if (other !== self) {
            for (const listener of other.listeners) {
              queueMicrotask(listener);
            }
          }
        }
        return ok(undefined);
      },
      subscribe: (listener) => {
        self.listeners.add(listener);
        return () => self.listeners.delete(listener);
      },
      close: () => {
        channels.delete(self);
      },
    });
  };
  return { open };
};

/** 偽物の表。columns の列を持ち、結合用の列の値と、正規化した Parquet のバイト列を決めて返す */
export type FakeTable = {
  readonly columns: readonly ColumnSchema[];
  readonly values?: Readonly<Record<string, ColumnValues>>;
  /** 正規化した Parquet の代わりのバイト列 */
  readonly normalized?: Uint8Array;
  readonly openError?: TableEngineError;
  readonly writeError?: TableEngineError;
};

export const fakeTables = (
  tables: Readonly<Record<string, FakeTable>>,
  assign?: TableEngine["assignPoints"],
): TableEngine & { readonly closed: string[]; readonly assigned: string[][] } => {
  const closed: string[] = [];
  const assigned: string[][] = [];
  const openTable = async (file: Blob): Promise<Result<TableSource, TableEngineError>> => {
    const name = file instanceof File ? file.name : "";
    const table = tables[name];
    if (table === undefined) {
      return err({ kind: "read-failed", message: `${name} は偽物の表にない` });
    }
    if (table.openError !== undefined) {
      return err(table.openError);
    }
    return ok({
      columns: table.columns,
      readJoinValues: (_plan: TableJoinPlan) => Promise.resolve(ok(table.values ?? {})),
      writeNormalized: () =>
        Promise.resolve(
          table.writeError === undefined
            ? ok(table.normalized ?? new Uint8Array([1, 2, 3]))
            : err(table.writeError),
        ),
      close: () => {
        closed.push(name);
        return Promise.resolve();
      },
    });
  };
  return {
    closed,
    assigned,
    openTable,
    assignPoints: async (points, geometries) => {
      assigned.push(geometries.map((g) => g.prefCode));
      return assign === undefined
        ? ok({ codes: Array.from(points.lat, () => null) })
        : assign(points, geometries);
    },
    stop: () => Promise.resolve(),
  };
};

export type TestPortsOptions = {
  readonly storage?: DatasetStorage;
  readonly locks?: ReturnType<typeof fakeLocks>;
  readonly channels?: ReturnType<typeof fakeChannels>;
  readonly tables?: TableEngine;
  readonly map?: MapView;
  readonly json?: Partial<Record<DataFile, unknown>>;
  readonly persisted?: boolean;
  readonly grantPersistence?: boolean;
};

/** テスト用の口。地図の要素の型は文字列にする */
export const testPorts = (
  options: TestPortsOptions = {},
): AppPorts<string> & { readonly errors: AppError[]; readonly persistRequests: number[] } => {
  const errors: AppError[] = [];
  const persistRequests: number[] = [];
  const locks = options.locks ?? fakeLocks();
  const channels = options.channels ?? fakeChannels();
  const storage = options.storage ?? fakeOpfs();
  let id = 0;
  const json: Partial<Record<DataFile, unknown>> = {
    "places.json": SAMPLE_PLACES,
    "admin_geom/index.json": { "31": [...TOTTORI_BBOX] },
    ...options.json,
  };
  return {
    errors,
    persistRequests,
    openStorage: () => Promise.resolve(storage),
    acquireWriterLock: locks.acquire,
    openManifestChannel: channels.open,
    requestPersistence: () => {
      persistRequests.push(1);
      return Promise.resolve(ok(options.grantPersistence ?? true));
    },
    isPersisted: () => Promise.resolve(ok(options.persisted ?? false)),
    openBaseParquet: (file) => {
      const bytes = fixtureBytes(file);
      return bytes === null
        ? Promise.resolve(err({ kind: "fetch-failed", message: file }))
        : openParquetBuffer(bytes.slice().buffer);
    },
    fetchBaseJson: (file): Promise<Result<unknown, FetchError>> =>
      Promise.resolve(file in json ? ok(json[file]) : err({ kind: "fetch-failed", message: file })),
    fetchBaseBytes: (file) => {
      const bytes = fixtureBytes(file);
      return Promise.resolve(
        bytes === null ? err({ kind: "fetch-failed", message: file }) : ok(bytes),
      );
    },
    readBlob: async (blob) => ok(new Uint8Array(await blob.arrayBuffer())),
    tables: options.tables ?? fakeTables({}),
    startMap: () => Promise.resolve(ok(options.map ?? fakeMap().view)),
    now: () => "2026-11-09T12:00:00.000Z",
    newId: () => `dataset-${++id}`,
    report: (error) => {
      errors.push(error);
    },
  };
};

/** Promise の続き（マイクロタスク）を流し終えるまで待つ */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};
