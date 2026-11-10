// 通知の文言。core の NoticeBody から、見出しと詳しい行を作る。
// 取り込めなかったときは、満たさなかった条件と、行や地物の番号を先頭から示す（docs/user/acceptance.md）。

import type { FormatRejection, ImportRejection } from "../core/accept/file";
import type { GeoJsonCondition, GeoJsonRejection } from "../core/accept/geojson";
import {
  type ColumnType,
  LAT_RANGE,
  LON_RANGE,
  type TableJoinKind,
  type TableRejection,
  type TableValueCondition,
} from "../core/accept/table";
import { displayPosition, type SourceFormat, type Violation } from "../core/accept/violation";
import { INDICATORS } from "../core/indicators/definitions";
import { DEFAULT_INDICATOR, type NoticeBody } from "../core/state/state";

/** 通知の強さ。error は取り込めなかったとき、warning は操作や保存に制約があるとき */
export type NoticeTone = "error" | "warning" | "info";

export type NoticeText = {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly details: readonly string[];
  /** 受け入れ条件の文書へのリンクを添えるか */
  readonly acceptanceLink: boolean;
};

const RANGE_TEXT = `北緯 ${LAT_RANGE.min}〜${LAT_RANGE.max} 度、東経 ${LON_RANGE.min}〜${LON_RANGE.max} 度`;

/** 満たさなかった番号の書き方。「3、15、42 行目ほか 2 件」「1、2 番目の地物」 */
export const positionsText = (format: SourceFormat, violation: Violation<string>): string => {
  const numbers = violation.positions.map((p) => displayPosition(format, p)).join("、");
  const unit = format === "geojson" ? " 番目の地物" : " 行目";
  const rest = violation.count - violation.positions.length;
  return rest > 0 ? `${numbers}${unit}ほか ${rest} 件` : `${numbers}${unit}`;
};

const COLUMN_TYPE_LABEL: Readonly<Record<ColumnType, string>> = {
  string: "文字列型",
  integer: "整数型",
  float: "浮動小数点数型",
  other: "その他の型",
};

const JOIN_KIND_LABEL: Readonly<Record<TableJoinKind, string>> = {
  code: "code",
  mesh: "mesh",
  point: "lat と lon",
};

const TABLE_VALUE_TEXT: Readonly<Record<TableValueCondition, string>> = {
  code: "code の列に、地図で塗る単位の団体コードでない値があります",
  mesh: "mesh の列に、3次メッシュコードの形でない値があります",
  "lat-lon": `lat と lon の列に、十進数でないか、${RANGE_TEXT}の外の値があります`,
};

const GEOJSON_CONDITION_TEXT: Readonly<Record<GeoJsonCondition, string>> = {
  feature: "Feature の形でない地物があります",
  "geometry-null": "ジオメトリが null の地物があります",
  "geometry-type": "点、線、面のどれでもないジオメトリの地物があります",
  coordinates: "座標の並びが、ジオメトリの種類に合わない地物があります",
  "coordinate-range": `座標が${RANGE_TEXT}の外にある地物があります`,
  "single-geometry-kind": "最初の地物とジオメトリの種類が違う地物があります",
};

const formatRejectionText = ({ extension }: FormatRejection): string =>
  extension === ""
    ? "拡張子のないファイルは取り込めません。CSV、Parquet、GeoJSON のファイルにしてください。"
    : `拡張子が .${extension} のファイルは取り込めません。CSV、Parquet、GeoJSON のファイルにしてください。`;

const READ_TEXT: Readonly<Record<SourceFormat, string>> = {
  csv: "CSV として読めませんでした。",
  parquet: "Parquet として読めませんでした。",
  geojson: "JSON として読めませんでした。",
};

const tableRejectionText = (format: SourceFormat, rejection: TableRejection): string => {
  switch (rejection.kind) {
    case "duplicate-column-names":
      return `同じ列名が2つ以上の列にあります（${rejection.names.join("、")}）。`;
    case "no-join-columns":
      return "結合用の列（code、mesh、lat と lon のどれか）がありません。";
    case "multiple-join-columns":
      return `結合用の列が2組以上あります（${rejection.found.map((k) => JOIN_KIND_LABEL[k]).join("、")}）。1組だけにしてください。`;
    case "incomplete-lat-lon":
      return rejection.present === "lat"
        ? "lat の列はありますが、lon の列がありません。"
        : "lon の列はありますが、lat の列がありません。";
    case "code-not-string":
      return `code の列が文字列型ではありません（${COLUMN_TYPE_LABEL[rejection.type]}）。`;
    case "unsupported-join-column-type":
      return `${rejection.column} の列の型（${COLUMN_TYPE_LABEL[rejection.type]}）は結合に使えません。`;
    case "no-rows":
      return "データの行がありません。";
    case "invalid-values":
      return `${TABLE_VALUE_TEXT[rejection.violation.condition]}（${positionsText(format, rejection.violation)}）。`;
    default: {
      const unreachable: never = rejection;
      return unreachable;
    }
  }
};

const geoJsonRejectionTexts = (rejection: GeoJsonRejection): readonly string[] => {
  switch (rejection.kind) {
    case "not-feature-collection":
      return ["GeoJSON の FeatureCollection ではありません。"];
    case "unsupported-crs":
      return ["crs が経度、緯度の順の WGS84（CRS84）を表していません。"];
    case "no-features":
      return ["地物がありません。"];
    case "invalid-features":
      return rejection.violations.map(
        (v) => `${GEOJSON_CONDITION_TEXT[v.condition]}（${positionsText("geojson", v)}）。`,
      );
    default: {
      const unreachable: never = rejection;
      return unreachable;
    }
  }
};

/** 取り込めなかった理由の行。満たさなかった条件ごとに1行 */
export const rejectionDetails = (rejection: ImportRejection): readonly string[] => {
  switch (rejection.stage) {
    case "format":
      return [formatRejectionText(rejection)];
    case "read":
      return [READ_TEXT[rejection.format]];
    case "table":
      return [tableRejectionText(rejection.format, rejection.rejection)];
    case "geojson":
      return geoJsonRejectionTexts(rejection.rejection);
    default: {
      const unreachable: never = rejection;
      return unreachable;
    }
  }
};

/** バイト数を MB で書く。1 MB は 1024 * 1024 バイト（LARGE_FILE_BYTES と同じ数え方） */
const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

const DEFAULT_INDICATOR_LABEL =
  DEFAULT_INDICATOR.kind === "base" ? INDICATORS[DEFAULT_INDICATOR.id].label : "既定の指標";

/** 通知の文言 */
export const noticeText = (notice: NoticeBody): NoticeText => {
  const info = (title: string, details: readonly string[] = []): NoticeText => ({
    tone: "info",
    title,
    details,
    acceptanceLink: false,
  });
  const warning = (title: string, details: readonly string[] = []): NoticeText => ({
    ...info(title, details),
    tone: "warning",
  });
  switch (notice.kind) {
    case "year-adjusted":
      return info(`${notice.from} 年は選べないので、${notice.to} 年にしました`);
    case "indicator-reset":
      return info(
        notice.reason === "unit"
          ? `この単位では塗れない指標なので、${DEFAULT_INDICATOR_LABEL}に戻しました`
          : `データを削除したので、指標を${DEFAULT_INDICATOR_LABEL}に戻しました`,
      );
    case "import-rejected":
      return {
        tone: "error",
        title: `「${notice.fileName}」を取り込めませんでした`,
        details: rejectionDetails(notice.rejection),
        acceptanceLink: true,
      };
    case "large-file":
      return warning(`「${notice.fileName}」は ${megabytes(notice.bytes)} あります`, [
        "取り込みに時間がかかることがあります。",
      ]);
    case "read-only":
      return warning("別のタブで開いているので、このタブではデータの追加と削除ができません", [
        "最初のタブを閉じると、できるようになります。",
      ]);
    case "became-writer":
      return info("このタブでデータの追加と削除ができるようになりました");
    case "write-blocked":
      return warning("このタブではデータの追加と削除ができません", [
        "別のタブで開いているためです。最初のタブを閉じると、できるようになります。",
      ]);
    case "storage-not-persistent":
      return warning("取り込んだデータは、ブラウザの容量が足りなくなると消されることがあります");
    case "storage-unavailable":
      return warning(
        "このブラウザではデータを保存できないので、ページを読み込み直すと取り込んだデータが消えます",
      );
    default: {
      const unreachable: never = notice;
      return unreachable;
    }
  }
};
