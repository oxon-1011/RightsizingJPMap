// 同じオリジンの複数のタブのあいだの調整（D6、docs/design/user-data.md の「複数のタブ」）。
// 書き込みの権利を Web Locks のロックで表し、目録の更新を BroadcastChannel で知らせる。

import { err, ok, type Result } from "../core/result";

/** 書き込みの権利を表すロックの名前 */
export const WRITER_LOCK_NAME = "rjm-writer";

/** 目録の更新を知らせるチャンネルの名前 */
export const MANIFEST_CHANNEL_NAME = "rjm-manifest";

export type TabsError =
  | { readonly kind: "unsupported"; readonly api: "web-locks" | "broadcast-channel" }
  | { readonly kind: "failed"; readonly message: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type WriterLock = {
  /** 取りにいった時点の役割。reader のタブは、ロックが渡るまで閲覧専用で動く */
  readonly role: "writer" | "reader";
  /**
   * ロックを放す。reader のタブでは、ロックを待つのをやめる。
   * ロックは少し遅れて放されるので、放し終えるのを待つときは戻り値の Promise を待つ
   */
  readonly release: () => Promise<void>;
};

/**
 * 書き込みのロックを、待たずに取りにいく（ifAvailable）。
 * 取れなければ role が reader になり、同じロックを待ち続ける。
 * 持っていたタブが閉じるなどしてロックが渡ると、onPromoted が呼ばれる。
 * ロックは release を呼ぶか、タブが閉じるまで持ち続ける。
 */
export const acquireWriterLock = async (options: {
  readonly onPromoted: () => void;
  readonly name?: string;
}): Promise<Result<WriterLock, TabsError>> => {
  if (!("locks" in navigator)) return err({ kind: "unsupported", api: "web-locks" });
  const name = options.name ?? WRITER_LOCK_NAME;

  // held が解決するまで、ロックの callback は終わらず、ロックを持ち続ける
  let releaseHeld = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let decide = (_acquired: boolean): void => undefined;
  let fail = (_error: unknown): void => undefined;
  const decided = new Promise<boolean>((resolve, reject) => {
    decide = resolve;
    fail = reject;
  });

  try {
    const first = navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      decide(lock !== null);
      if (lock !== null) await held;
    });
    first.catch(fail);
    const acquired = await decided;

    const waiting = new AbortController();
    // reader は、ロックが空くまで2つめの要求で待つ。release で待つのをやめると AbortError で終わる
    const settled = acquired
      ? first
      : navigator.locks.request(name, { signal: waiting.signal }, async () => {
          options.onPromoted();
          await held;
        });
    const released = settled.then(
      () => undefined,
      () => undefined,
    );
    return ok({
      role: acquired ? "writer" : "reader",
      release: () => {
        waiting.abort();
        releaseHeld();
        return released;
      },
    });
  } catch (e) {
    return err({ kind: "failed", message: messageOf(e) });
  }
};

export type ManifestChannel = {
  /** 目録を更新したことを、ほかのタブに知らせる。自分自身の購読には届かない */
  readonly notify: () => Result<void, TabsError>;
  /** 通知を受けたときに呼ぶ関数を登録する。戻り値を呼ぶと登録を解除する */
  readonly subscribe: (listener: () => void) => () => void;
  /** チャンネルを閉じる。閉じたあとの notify は失敗する */
  readonly close: () => void;
};

const MANIFEST_UPDATED = "manifest-updated";

const isManifestUpdated = (data: unknown): boolean =>
  typeof data === "object" && data !== null && "type" in data && data.type === MANIFEST_UPDATED;

/** 目録の更新を知らせるチャンネルを開く */
export const openManifestChannel = (
  name: string = MANIFEST_CHANNEL_NAME,
): Result<ManifestChannel, TabsError> => {
  if (typeof BroadcastChannel === "undefined") {
    return err({ kind: "unsupported", api: "broadcast-channel" });
  }
  const channel = new BroadcastChannel(name);
  return ok({
    notify: () => {
      try {
        channel.postMessage({ type: MANIFEST_UPDATED });
        return ok(undefined);
      } catch (e) {
        return err({ kind: "failed", message: messageOf(e) });
      }
    },
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent<unknown>) => {
        if (isManifestUpdated(event.data)) listener();
      };
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
    close: () => channel.close(),
  });
};
