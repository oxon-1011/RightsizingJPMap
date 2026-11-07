import { describe, expect, it } from "vitest";
import type { Result } from "../core/result";
import { acquireWriterLock, openManifestChannel, WRITER_LOCK_NAME } from "./tabs";

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

/** 呼ばれたら解決する Promise と、その関数の組 */
const signal = () => {
  let fire = (): void => undefined;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fire, fired };
};

/** promise が ms 以内に解決すれば true を返す */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

/** テストごとにロックの名前を変え、ほかのテストのロックと干渉しないようにする */
const lockName = () => `${WRITER_LOCK_NAME}-test-${crypto.randomUUID()}`;

describe("acquireWriterLock", () => {
  it("最初に取りにいったものが writer、2つめは reader になり、1つめが放すと2つめが昇格する", async () => {
    const name = lockName();
    const promoted = signal();
    const first = unwrap(await acquireWriterLock({ name, onPromoted: () => undefined }));
    const second = unwrap(await acquireWriterLock({ name, onPromoted: promoted.fire }));
    expect(first.role).toBe("writer");
    expect(second.role).toBe("reader");

    expect(await settlesWithin(promoted.fired, 100)).toBe(false);
    await first.release();
    expect(await settlesWithin(promoted.fired, 1000)).toBe(true);

    // 昇格したあとはロックを持っているので、3つめは reader になる
    const third = unwrap(await acquireWriterLock({ name, onPromoted: () => undefined }));
    expect(third.role).toBe("reader");
    await second.release();
    await third.release();
  });

  it("ロックを持つ Worker（別のタブにあたる）が止まると、ロックが渡る", async () => {
    const name = lockName();
    const source = `
      navigator.locks.request(${JSON.stringify(name)}, () => {
        postMessage("held");
        return new Promise(() => {});
      });`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    await new Promise<void>((resolve) => {
      worker.addEventListener("message", () => resolve(), { once: true });
    });

    const promoted = signal();
    const lock = unwrap(await acquireWriterLock({ name, onPromoted: promoted.fire }));
    expect(lock.role).toBe("reader");
    worker.terminate();
    expect(await settlesWithin(promoted.fired, 2000)).toBe(true);
    await lock.release();
  });

  it("reader が release すると待つのをやめ、あとでロックが空いても昇格しない", async () => {
    const name = lockName();
    let promotedCount = 0;
    const writer = unwrap(await acquireWriterLock({ name, onPromoted: () => undefined }));
    const reader = unwrap(
      await acquireWriterLock({
        name,
        onPromoted: () => {
          promotedCount += 1;
        },
      }),
    );
    await reader.release();
    await writer.release();

    const next = unwrap(await acquireWriterLock({ name, onPromoted: () => undefined }));
    expect(next.role).toBe("writer");
    expect(promotedCount).toBe(0);
    await next.release();
  });

  it("名前を省くと rjm-writer のロックを取る", async () => {
    const lock = unwrap(await acquireWriterLock({ onPromoted: () => undefined }));
    const { held } = await navigator.locks.query();
    expect(held?.map((l) => l.name)).toContain("rjm-writer");
    await lock.release();
  });
});

describe("openManifestChannel", () => {
  const channelName = () => `rjm-manifest-test-${crypto.randomUUID()}`;

  it("notify した通知が、同じ名前で開いたほかのチャンネルに届き、自分には届かない", async () => {
    const name = channelName();
    const sender = unwrap(openManifestChannel(name));
    const receiver = unwrap(openManifestChannel(name));
    const received = signal();
    let senderReceived = 0;
    receiver.subscribe(received.fire);
    sender.subscribe(() => {
      senderReceived += 1;
    });

    unwrap(sender.notify());
    expect(await settlesWithin(received.fired, 1000)).toBe(true);
    expect(senderReceived).toBe(0);
    sender.close();
    receiver.close();
  });

  it("購読を解除すると届かなくなる", async () => {
    const name = channelName();
    const sender = unwrap(openManifestChannel(name));
    const receiver = unwrap(openManifestChannel(name));
    let count = 0;
    const unsubscribe = receiver.subscribe(() => {
      count += 1;
    });
    const probe = signal();
    receiver.subscribe(probe.fire);

    unsubscribe();
    unwrap(sender.notify());
    await probe.fired;
    expect(count).toBe(0);
    sender.close();
    receiver.close();
  });

  it("目録の更新でない通知は無視する", async () => {
    const name = channelName();
    const receiver = unwrap(openManifestChannel(name));
    let count = 0;
    receiver.subscribe(() => {
      count += 1;
    });
    const raw = new BroadcastChannel(name);
    const rawReceived = signal();
    const observer = new BroadcastChannel(name);
    observer.addEventListener("message", () => rawReceived.fire());

    raw.postMessage({ type: "something-else" });
    raw.postMessage("manifest-updated");
    await rawReceived.fired;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count).toBe(0);
    raw.close();
    observer.close();
    receiver.close();
  });

  it("閉じたあとの notify は失敗を返す", () => {
    const channel = unwrap(openManifestChannel(channelName()));
    channel.close();
    const result = channel.notify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("failed");
  });
});
