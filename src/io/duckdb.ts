// DuckDB-WASM の起動、ファイルの登録、問い合わせ、spatial 拡張の読み込み。
// シングルスレッドの bundle（mvp と eh）だけを渡し、COOP と COEP のヘッダなしで動かす（D4）。
// 本体と wasm は、startDuckDb を初めて呼んだときに動的 import で読み込む。

import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { err, ok, type Result } from "../core/result";

export type DuckDb = {
  readonly db: AsyncDuckDB;
  readonly conn: AsyncDuckDBConnection;
  /** DuckDB 本体の版（v1.5.4 など）。拡張の版はこれに合わせて選ばれる */
  readonly version: string;
  /** 選ばれた bundle。eh は WebAssembly の例外処理に対応したブラウザで使われる */
  readonly bundle: "mvp" | "eh";
};

export type DuckDbError =
  /** 本体の取得、Worker の起動、wasm の初期化のどれかに失敗した */
  | { readonly kind: "start-failed"; readonly message: string }
  | { readonly kind: "query-failed"; readonly sql: string; readonly message: string }
  | { readonly kind: "file-not-found"; readonly name: string }
  | { readonly kind: "file-failed"; readonly name: string; readonly message: string }
  | { readonly kind: "extension-failed"; readonly extension: string; readonly message: string };

/** wasm の取得の進み具合（バイト数） */
export type StartProgress = { readonly bytesLoaded: number; readonly bytesTotal: number };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const loadModules = async () => {
  const [duckdb, mvpWorker, mvpWasm, ehWorker, ehWasm] = await Promise.all([
    import("@duckdb/duckdb-wasm"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"),
  ]);
  return {
    duckdb,
    bundles: {
      mvp: { mainModule: mvpWasm.default, mainWorker: mvpWorker.default },
      eh: { mainModule: ehWasm.default, mainWorker: ehWorker.default },
    },
  };
};

/**
 * DuckDB-WASM を起動し、接続を1つ開く。呼ぶたびに新しい Worker を起動するので、
 * 1つの画面で使い回すときは、呼び出し側で結果を持っておく。
 *
 * 問い合わせの結果では、BIGINT と DECIMAL を DOUBLE に変換する（castBigIntToDouble、castDecimalToDouble）。
 * BigInt を core に持ち込まないためである。
 */
export const startDuckDb = async (
  options: { readonly onProgress?: (progress: StartProgress) => void } = {},
): Promise<Result<DuckDb, DuckDbError>> => {
  let worker: Worker | undefined;
  try {
    const { duckdb, bundles } = await loadModules();
    const bundle = await duckdb.selectBundle(bundles);
    if (bundle.mainWorker === null) {
      return err({ kind: "start-failed", message: "bundle has no worker" });
    }
    worker = new Worker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    const { onProgress } = options;
    await db.instantiate(
      bundle.mainModule,
      bundle.pthreadWorker,
      onProgress === undefined
        ? undefined
        : (p) => onProgress({ bytesLoaded: p.bytesLoaded, bytesTotal: p.bytesTotal }),
    );
    await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
    const conn = await db.connect();
    const version = await db.getVersion();
    return ok({
      db,
      conn,
      version,
      bundle: bundle.mainModule === bundles.eh.mainModule ? "eh" : "mvp",
    });
  } catch (e) {
    worker?.terminate();
    return err({ kind: "start-failed", message: messageOf(e) });
  }
};

/** 接続を閉じ、Worker を止める */
export const stopDuckDb = async (duck: DuckDb): Promise<Result<void, DuckDbError>> => {
  try {
    await duck.conn.close();
    await duck.db.terminate();
    return ok(undefined);
  } catch (e) {
    return err({ kind: "start-failed", message: messageOf(e) });
  }
};

/**
 * ファイルを DuckDB の仮想のファイルシステムに登録し、SQL から name で読めるようにする。
 * Blob（利用者が選んだ File、OPFS から読んだ File）は、DuckDB が必要な部分だけを Worker の中で読む。
 * バイト列は複製してから渡す。DuckDB-WASM は受け取った ArrayBuffer を Worker に移し、呼び出し側では使えなくするからである。
 */
export const registerFile = async (
  duck: DuckDb,
  name: string,
  source: Blob | Uint8Array,
): Promise<Result<void, DuckDbError>> => {
  try {
    if (source instanceof Uint8Array) {
      await duck.db.registerFileBuffer(name, source.slice());
    } else {
      const { DuckDBDataProtocol } = await import("@duckdb/duckdb-wasm");
      await duck.db.registerFileHandle(name, source, DuckDBDataProtocol.BROWSER_FILEREADER, true);
    }
    return ok(undefined);
  } catch (e) {
    return err({ kind: "file-failed", name, message: messageOf(e) });
  }
};

/** 登録したファイルや、COPY で書き出したファイルを消す */
export const dropFile = async (duck: DuckDb, name: string): Promise<Result<void, DuckDbError>> => {
  try {
    await duck.db.dropFile(name);
    return ok(undefined);
  } catch (e) {
    return err({ kind: "file-failed", name, message: messageOf(e) });
  }
};

/**
 * COPY ... TO で書き出したファイルを、バイト列として取り出す。
 * DuckDB-WASM の copyFileToBuffer は、ない名前を渡すと1バイトのファイルを作って返すので、先に登録を確かめる。
 */
export const readFileBytes = async (
  duck: DuckDb,
  name: string,
): Promise<Result<Uint8Array, DuckDbError>> => {
  try {
    const files = await duck.db.globFiles(name);
    if (!files.some((file) => file.fileName === name)) return err({ kind: "file-not-found", name });
    return ok(await duck.db.copyFileToBuffer(name));
  } catch (e) {
    return err({ kind: "file-failed", name, message: messageOf(e) });
  }
};

export type QueryColumn = {
  readonly name: string;
  /** Arrow の型の名前（Utf8、Int32、Float64、Bool など）。DuckDB の型の名前が要るときは DESCRIBE を問い合わせる */
  readonly type: string;
  /** 値。NULL は null になる。入れ子の型（STRUCT、LIST）は Arrow の値のまま入る */
  readonly values: readonly unknown[];
};

export type QueryResult = {
  readonly numRows: number;
  readonly columns: readonly QueryColumn[];
};

/** SQL を実行し、結果を列ごとの普通の配列に直して返す */
export const query = async (
  duck: DuckDb,
  sql: string,
): Promise<Result<QueryResult, DuckDbError>> => {
  try {
    const table = await duck.conn.query(sql);
    const columns = table.schema.fields.map((field, index) => {
      const vector = table.getChildAt(index);
      const values = new Array<unknown>(table.numRows);
      for (let i = 0; i < table.numRows; i++) values[i] = vector?.get(i) ?? null;
      return { name: field.name, type: String(field.type), values };
    });
    return ok({ numRows: table.numRows, columns });
  } catch (e) {
    return err({ kind: "query-failed", sql, message: messageOf(e) });
  }
};

/**
 * spatial 拡張を extensions.duckdb.org から取得して読み込む。読み込み済みなら、すぐに終わる。
 * DuckDB-WASM では INSTALL は要らず、LOAD が Worker の中で拡張（v1.5.4 の eh で約 23.6MB）を取得する。
 * 取得のバイト数は知らせてこないので、呼び出し側は完了を待つ間、進み具合の分からない表示を出す。
 */
export const loadSpatial = async (duck: DuckDb): Promise<Result<void, DuckDbError>> => {
  try {
    await duck.conn.query("LOAD spatial");
    return ok(undefined);
  } catch (e) {
    return err({ kind: "extension-failed", extension: "spatial", message: messageOf(e) });
  }
};
