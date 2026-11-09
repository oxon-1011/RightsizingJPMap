// ファイルを地図の上に重ねているかの判定（docs/design/ui.md の「ドラッグ中の表示」）。
// dragenter と dragleave は子の要素に出入りするたびに起きるので、入った数を数えて判定する。

/** ファイル選択の accept 属性。拡張子だけで絞り、中身は core の受け入れ検査で調べる（D12、D13） */
export const ACCEPTED_FILE_TYPES = ".csv,.parquet,.geojson,.json";

/** ドラッグしているものにファイルが含まれるか。DataTransfer の types を渡す */
export const hasFiles = (types: readonly string[]): boolean => types.includes("Files");

/** ドラッグの出来事。over は数に影響しないので含めない */
export type DragEventKind = "enter" | "leave" | "drop";

/**
 * 出来事のあとの、入った数。enter で増やし、leave で減らし、drop で 0 に戻す。
 * 数が 0 より大きいあいだ、ファイルを重ねていると判定する。
 */
export const nextDragDepth = (depth: number, kind: DragEventKind): number => {
  switch (kind) {
    case "enter":
      return depth + 1;
    case "leave":
      return Math.max(0, depth - 1);
    case "drop":
      return 0;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};
