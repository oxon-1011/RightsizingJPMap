import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBytes, readBlobBytes } from "./bytes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBytes", () => {
  it("2xx の応答の本文をバイト列で返す", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));
    expect(await fetchBytes("https://example.test/a.json")).toEqual({
      ok: true,
      value: new Uint8Array([1, 2, 3]),
    });
  });

  it("2xx 以外の応答は、状態の番号を付けて失敗にする", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    expect(await fetchBytes("https://example.test/a.json")).toEqual({
      ok: false,
      error: { kind: "read-failed", message: "HTTP 404" },
    });
  });

  it("fetch が投げた例外を失敗にする", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchBytes("https://example.test/a.json")).toEqual({
      ok: false,
      error: { kind: "read-failed", message: "Failed to fetch" },
    });
  });
});

describe("readBlobBytes", () => {
  it("Blob の内容をバイト列で返す", async () => {
    expect(await readBlobBytes(new Blob([new Uint8Array([4, 5])]))).toEqual({
      ok: true,
      value: new Uint8Array([4, 5]),
    });
  });
});
