import { describe, expect, it } from "vitest";
import type { NoticeBody } from "../core/state/state";
import { noticeText, positionsText, rejectionDetails } from "./notice-text";

describe("positionsText", () => {
  it("CSV は列名の行を1行目として数え、示しきれない数を「ほか」で書く（Figma の通知と同じ）", () => {
    expect(positionsText("csv", { condition: "code", positions: [1, 13, 40], count: 5 })).toBe(
      "3、15、42 行目ほか 2 件",
    );
  });

  it("Parquet は先頭の行を1、GeoJSON は先頭の地物を1として数える", () => {
    expect(positionsText("parquet", { condition: "mesh", positions: [0, 4], count: 2 })).toBe(
      "1、5 行目",
    );
    expect(positionsText("geojson", { condition: "feature", positions: [2], count: 1 })).toBe(
      "3 番目の地物",
    );
  });
});

describe("rejectionDetails", () => {
  it("拡張子で拒否したときは、取り込める形式を示す", () => {
    expect(rejectionDetails({ stage: "format", extension: "xlsx" })).toEqual([
      "拡張子が .xlsx のファイルは取り込めません。CSV、Parquet、GeoJSON のファイルにしてください。",
    ]);
    expect(rejectionDetails({ stage: "format", extension: "" })[0]).toMatch(/^拡張子のない/);
  });

  it("code の値の違反は、条件と行番号を1行で示す", () => {
    expect(
      rejectionDetails({
        stage: "table",
        format: "csv",
        rejection: {
          kind: "invalid-values",
          violation: { condition: "code", positions: [1, 13, 40], count: 5 },
        },
      }),
    ).toEqual([
      "code の列に、地図で塗る単位の団体コードでない値があります（3、15、42 行目ほか 2 件）。",
    ]);
  });

  it("結合用の列が2組以上あるときは、見つかった組を並べる", () => {
    expect(
      rejectionDetails({
        stage: "table",
        format: "csv",
        rejection: { kind: "multiple-join-columns", found: ["code", "point"] },
      }),
    ).toEqual(["結合用の列が2組以上あります（code、lat と lon）。1組だけにしてください。"]);
  });

  it("GeoJSON の地物の違反は、条件ごとに1行にする", () => {
    const details = rejectionDetails({
      stage: "geojson",
      rejection: {
        kind: "invalid-features",
        violations: [
          { condition: "geometry-null", positions: [0], count: 1 },
          { condition: "coordinate-range", positions: [1, 2, 3, 4, 5], count: 9 },
        ],
      },
    });
    expect(details).toEqual([
      "ジオメトリが null の地物があります（1 番目の地物）。",
      "座標が北緯 20〜46 度、東経 122〜154 度の外にある地物があります（2、3、4、5、6 番目の地物ほか 4 件）。",
    ]);
  });
});

describe("noticeText", () => {
  it("取り込めなかった通知は error で、受け入れ条件へのリンクを添える", () => {
    const text = noticeText({
      kind: "import-rejected",
      fileName: "施設一覧.csv",
      rejection: { stage: "read", format: "csv" },
    });
    expect(text.tone).toBe("error");
    expect(text.title).toBe("「施設一覧.csv」を取り込めませんでした");
    expect(text.acceptanceLink).toBe(true);
  });

  it("大きいファイルは MB で示す", () => {
    expect(
      noticeText({ kind: "large-file", fileName: "a.csv", bytes: 150 * 1024 * 1024 }).title,
    ).toBe("「a.csv」は 150 MB あります");
  });

  it("年を合わせたときは、元の年と合わせた年を示す", () => {
    expect(noticeText({ kind: "year-adjusted", from: 2070, to: 2050 }).title).toBe(
      "2070 年は選べないので、2050 年にしました",
    );
  });

  it("指標を戻したときは、戻した先の指標の名前を示す", () => {
    expect(noticeText({ kind: "indicator-reset", reason: "unit" }).title).toBe(
      "この単位では塗れない指標なので、高齢化率に戻しました",
    );
  });

  it("どの種類の通知にも見出しがあり、受け入れ条件のリンクは取り込めなかったときだけ", () => {
    const notices: readonly NoticeBody[] = [
      { kind: "year-adjusted", from: 2020, to: 2025 },
      { kind: "indicator-reset", reason: "dataset-removed" },
      {
        kind: "import-rejected",
        fileName: "x.xlsx",
        rejection: { stage: "format", extension: "xlsx" },
      },
      { kind: "large-file", fileName: "x.csv", bytes: 1 },
      { kind: "read-only" },
      { kind: "became-writer" },
      { kind: "write-blocked" },
      { kind: "storage-not-persistent" },
      { kind: "storage-unavailable" },
    ];
    for (const notice of notices) {
      const text = noticeText(notice);
      expect(text.title).not.toBe("");
      expect(text.acceptanceLink).toBe(notice.kind === "import-rejected");
    }
  });
});
