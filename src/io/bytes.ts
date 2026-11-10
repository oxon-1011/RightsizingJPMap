// ファイル全体をバイト列で読む。HTTP で取得するものと、利用者が選んだファイル（Blob）の2つ。
// Range で一部だけを読む Parquet は parquet.ts が扱う。

import { err, ok, type Result } from "../core/result";

export type BytesError = { readonly kind: "read-failed"; readonly message: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * URL の内容全体を読む。2xx 以外の応答は失敗にする。
 * 全体を1回で読むので、サーバーが gzip で返しても、ブラウザが展開した元のバイト列になる。
 */
export const fetchBytes = async (url: string): Promise<Result<Uint8Array, BytesError>> => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return err({ kind: "read-failed", message: `HTTP ${response.status}` });
    }
    return ok(new Uint8Array(await response.arrayBuffer()));
  } catch (e) {
    return err({ kind: "read-failed", message: messageOf(e) });
  }
};

/** Blob（利用者が選んだ File を含む）の内容全体を読む */
export const readBlobBytes = async (blob: Blob): Promise<Result<Uint8Array, BytesError>> => {
  try {
    return ok(new Uint8Array(await blob.arrayBuffer()));
  } catch (e) {
    return err({ kind: "read-failed", message: messageOf(e) });
  }
};
