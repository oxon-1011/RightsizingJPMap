// 自前データの取り込み（docs/design/user-data.md の「取り込みの流れ」、D12、D13）。
// 1. 拡張子から形式を決める。2. CSV と Parquet は DuckDB で、GeoJSON は JSON.parse で読む。
// 3. core で受け入れ条件を検査し、満たさなければ拒否の通知を出す。4. OPFS に書いてから目録を更新する。
// 受け入れの判断はすべて core の関数で行い、ここでは読む順序と、拒否の理由の振り分けだけをする。

import { detectFormat, type ImportRejection } from "../core/accept/file";
import { checkGeoJson } from "../core/accept/geojson";
import { checkTableValues, planTableJoin, type TableFormat } from "../core/accept/table";
import { err, ok, type Result } from "../core/result";
import { type AcceptedDataset, type DatasetEntry, newDatasetEntry } from "../core/storage/manifest";
import { decodeJson } from "./datasets";
import type { AppError, TableEngine } from "./ports";

/** 取り込むファイル。ブラウザの File と同じく、名前と大きさを持つ Blob */
export type ImportFile = Blob & { readonly name: string };

/** 取り込みの結果。拒否は利用者に通知し、失敗（ファイルのせいでないもの）は report で知らせる */
export type ImportOutcome =
  | { readonly kind: "accepted"; readonly entry: DatasetEntry; readonly bytes: Uint8Array }
  | { readonly kind: "rejected"; readonly rejection: ImportRejection }
  | { readonly kind: "failed"; readonly error: AppError };

export type ReadDeps = {
  readonly tables: TableEngine;
  readonly readBlob: (blob: Blob) => Promise<Result<Uint8Array, { readonly message: string }>>;
  /** 地図で塗る単位の団体コード。code 列の検査に使う */
  readonly paintedCodes: () => Promise<Result<ReadonlySet<string>, AppError>>;
};

type Accepted = { readonly accepted: AcceptedDataset; readonly bytes: Uint8Array };

type ReadResult = Result<Accepted, ImportOutcome>;

const rejected = (rejection: ImportRejection): ReadResult => err({ kind: "rejected", rejection });

const failed = (error: AppError): ReadResult => err({ kind: "failed", error });

const readTable = async (
  deps: ReadDeps,
  file: ImportFile,
  format: TableFormat,
): Promise<ReadResult> => {
  const opened = await deps.tables.openTable(file, format);
  if (!opened.ok) {
    return opened.error.kind === "read-failed"
      ? rejected({ stage: "read", format })
      : failed({ kind: "engine", error: opened.error });
  }
  const source = opened.value;
  try {
    const plan = planTableJoin(source.columns);
    if (!plan.ok) {
      return rejected({ stage: "table", format, rejection: plan.error });
    }
    const codes = plan.value.kind === "code" ? await deps.paintedCodes() : ok(new Set<string>());
    if (!codes.ok) {
      return failed(codes.error);
    }
    const values = await source.readJoinValues(plan.value);
    if (!values.ok) {
      return values.error.kind === "read-failed"
        ? rejected({ stage: "read", format })
        : failed({ kind: "engine", error: values.error });
    }
    const checked = checkTableValues(format, plan.value, values.value, codes.value);
    if (!checked.ok) {
      return rejected({ stage: "table", format, rejection: checked.error });
    }
    // 全行を読み直して書き出すので、型の推定より後ろの UTF-8 でない行もここで拒否になる
    const bytes = await source.writeNormalized(plan.value);
    if (!bytes.ok) {
      return bytes.error.kind === "read-failed"
        ? rejected({ stage: "read", format })
        : failed({ kind: "engine", error: bytes.error });
    }
    return ok({ accepted: { source: "table", table: checked.value }, bytes: bytes.value });
  } finally {
    await source.close();
  }
};

/** GeoJSON は受け入れたファイルをそのまま保存する */
const readGeoJson = async (deps: ReadDeps, file: ImportFile): Promise<ReadResult> => {
  const bytes = await deps.readBlob(file);
  if (!bytes.ok) {
    return rejected({ stage: "read", format: "geojson" });
  }
  const json = decodeJson(bytes.value);
  if (!json.ok) {
    return rejected({ stage: "read", format: "geojson" });
  }
  const checked = checkGeoJson(json.value);
  return checked.ok
    ? ok({ accepted: { source: "geojson", geojson: checked.value }, bytes: bytes.value })
    : rejected({ stage: "geojson", rejection: checked.error });
};

/** 拡張子を除いたファイル名。目録の名前（利用者が付けた名前）の既定値にする */
export const datasetNameOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};

/**
 * ファイルを読み、受け入れ条件を検査して、目録の項目と保存するバイト列を作る。
 * 目録とファイルにはまだ書かない（create-app.ts が persistence.ts で書く）。
 */
export const readImportFile = async (
  deps: ReadDeps & {
    readonly newId: () => string;
    readonly now: () => string;
    readonly existing: () => readonly DatasetEntry[];
  },
  file: ImportFile,
): Promise<ImportOutcome> => {
  const format = detectFormat(file.name);
  if (!format.ok) {
    return { kind: "rejected", rejection: format.error };
  }
  const read =
    format.value === "geojson"
      ? await readGeoJson(deps, file)
      : await readTable(deps, file, format.value);
  if (!read.ok) {
    return read.error;
  }
  const entry = newDatasetEntry({
    id: deps.newId(),
    name: datasetNameOf(file.name),
    source: { name: file.name, size: file.size },
    importedAt: deps.now(),
    accepted: read.value.accepted,
    existing: deps.existing(),
  });
  return { kind: "accepted", entry, bytes: read.value.bytes };
};
