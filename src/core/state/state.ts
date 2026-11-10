// 画面の状態と、その更新関数（docs/guides/coding.md の「app と ui の書き方」）。
// app の Zustand のストアは、この reduce を呼ぶだけにする。

import type { ImportRejection } from "../accept/file";
import { MESH_YEARS, MUNICIPAL_YEARS } from "../data/schema";
import {
  availableYears,
  type IndicatorId,
  type PopulationIndicatorId,
  type Unit,
} from "../indicators/definitions";
import type { JoinMeasure } from "../join/aggregate";
import {
  type DatasetEntry,
  type JoinTarget,
  type LayerStyle,
  summableColumns,
} from "../storage/manifest";

/**
 * 選んでいる指標。ベースデータの指標か、自前データを結合した指標。
 * 結合した指標の perPopulation は人口あたりの値の分母で、null なら件数か合計をそのまま塗る。
 */
export type IndicatorSelection =
  | { readonly kind: "base"; readonly id: IndicatorId }
  | {
      readonly kind: "joined";
      readonly datasetId: string;
      readonly measure: JoinMeasure;
      readonly perPopulation: {
        readonly base: PopulationIndicatorId;
        /** 何人あたりか（1000 なら 1,000 人あたり） */
        readonly per: number;
      } | null;
    };

/**
 * 書き込みの権利（D6）。起動してロックの結果が出るまでは pending。
 * read-only のタブでは、データの追加と削除ができない。
 */
export type WriteAccess = "pending" | "writer" | "read-only";

/** 利用者に示す通知の中身 */
export type NoticeBody =
  /** 選べない年になったので、最も近い選べる年に合わせた（市区町村で 2050 年より後など） */
  | { readonly kind: "year-adjusted"; readonly from: number; readonly to: number }
  /** 選んでいた結合した指標が、単位の切り替えかデータの削除で使えなくなった */
  | { readonly kind: "indicator-reset"; readonly reason: "unit" | "dataset-removed" }
  | {
      readonly kind: "import-rejected";
      readonly fileName: string;
      readonly rejection: ImportRejection;
    }
  | { readonly kind: "large-file"; readonly fileName: string; readonly bytes: number }
  /** 別のタブで開いているので、このタブではデータの追加と削除ができない */
  | { readonly kind: "read-only" }
  /** 書き込み側のタブが閉じて、このタブで書き込めるようになった */
  | { readonly kind: "became-writer" }
  /** 閲覧専用のタブで、データの追加か削除をしようとした */
  | { readonly kind: "write-blocked" }
  /** navigator.storage.persist() が許可されなかった */
  | { readonly kind: "storage-not-persistent" }
  /** OPFS が使えないので、メモリ上だけで動いている */
  | { readonly kind: "storage-unavailable" };

export type Notice = NoticeBody & { readonly id: number };

export type AppState = {
  readonly unit: Unit;
  readonly year: number;
  readonly indicator: IndicatorSelection;
  /** 取り込んだデータ。目録（storage/manifest.ts）の項目と同じ */
  readonly datasets: readonly DatasetEntry[];
  readonly access: WriteAccess;
  /** 古い順 */
  readonly notices: readonly Notice[];
  /** 次の通知に付ける番号。乱数を使わずに通知を見分けるため */
  readonly nextNoticeId: number;
};

/** 既定の指標。Figma の「01 地図（基本）」と同じ、2050 年の高齢化率のメッシュ */
export const DEFAULT_INDICATOR: IndicatorSelection = { kind: "base", id: "aging_rate" };

export const INITIAL_STATE: AppState = {
  unit: "mesh",
  year: 2050,
  indicator: DEFAULT_INDICATOR,
  datasets: [],
  access: "pending",
  notices: [],
  nextNoticeId: 1,
};

export type Action =
  | { readonly type: "unit-selected"; readonly unit: Unit }
  | { readonly type: "year-selected"; readonly year: number }
  | { readonly type: "indicator-selected"; readonly indicator: IndicatorSelection }
  /** 起動時と、別のタブからの通知で目録を読み直したとき */
  | { readonly type: "datasets-loaded"; readonly datasets: readonly DatasetEntry[] }
  | { readonly type: "dataset-added"; readonly entry: DatasetEntry }
  | { readonly type: "dataset-removed"; readonly id: string }
  | { readonly type: "datasets-cleared" }
  | {
      readonly type: "dataset-style-changed";
      readonly id: string;
      readonly style: Partial<LayerStyle>;
    }
  | { readonly type: "access-changed"; readonly access: "writer" | "read-only" }
  | { readonly type: "notified"; readonly notice: NoticeBody }
  | { readonly type: "notice-dismissed"; readonly id: number };

const UNIT_TARGET: Readonly<Record<Unit, JoinTarget>> = {
  mesh: "mesh",
  municipality: "municipality",
};

/** 結合した指標の値が年によって変わらないときに選べる年。単位の年の範囲そのもの */
const unitYears = (unit: Unit): readonly number[] =>
  unit === "mesh" ? MESH_YEARS : MUNICIPAL_YEARS;

/** 単位と指標の組で選べる年 */
export const selectableYears = (unit: Unit, indicator: IndicatorSelection): readonly number[] => {
  switch (indicator.kind) {
    case "base":
      return availableYears(unit, indicator.id);
    case "joined":
      return indicator.perPopulation === null
        ? unitYears(unit)
        : availableYears(unit, indicator.perPopulation.base);
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};

/**
 * 指標をその単位で塗れるか。結合した指標は、データがあり、その単位に結合でき、
 * 合計に使う列が数値の列であるときだけ塗れる。
 */
export const isIndicatorAvailable = (
  unit: Unit,
  indicator: IndicatorSelection,
  datasets: readonly DatasetEntry[],
): boolean => {
  switch (indicator.kind) {
    case "base":
      return true;
    case "joined": {
      const dataset = datasets.find((d) => d.id === indicator.datasetId);
      if (dataset === undefined || !dataset.join.includes(UNIT_TARGET[unit])) {
        return false;
      }
      const { measure } = indicator;
      return measure.kind === "count" || summableColumns(dataset).includes(measure.column);
    }
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
};

/** データの追加と削除ができるか。app は目録を書く前にこれを確かめる */
export const canWrite = (state: AppState): boolean => state.access === "writer";

/** 選べる年のうち、year に最も近い年。同じ近さなら後の年 */
export const nearestYear = (year: number, years: readonly number[]): number => {
  let best = years[0] ?? year;
  for (const y of years) {
    if (Math.abs(y - year) <= Math.abs(best - year)) {
      best = y;
    }
  }
  return best;
};

/** 同じ種類の古い通知を置き換える通知。取り込みの通知はファイルごとなので積み重ねる */
const replacesSameKind = (kind: NoticeBody["kind"]): boolean =>
  kind !== "import-rejected" && kind !== "large-file";

const notify = (state: AppState, body: NoticeBody): AppState => ({
  ...state,
  notices: [
    ...state.notices.filter((n) => !(replacesSameKind(body.kind) && n.kind === body.kind)),
    { ...body, id: state.nextNoticeId },
  ],
  nextNoticeId: state.nextNoticeId + 1,
});

/**
 * 単位、指標、データが変わったあとに、選べない組み合わせを直す。
 * 指標が塗れなければ既定の指標に戻し、年が選べなければ最も近い年に合わせて、どちらも通知する。
 */
const settle = (state: AppState, reason: "unit" | "dataset-removed"): AppState => {
  const withIndicator = isIndicatorAvailable(state.unit, state.indicator, state.datasets)
    ? state
    : notify({ ...state, indicator: DEFAULT_INDICATOR }, { kind: "indicator-reset", reason });
  const years = selectableYears(withIndicator.unit, withIndicator.indicator);
  if (years.includes(withIndicator.year)) {
    return withIndicator;
  }
  const to = nearestYear(withIndicator.year, years);
  return notify(
    { ...withIndicator, year: to },
    { kind: "year-adjusted", from: withIndicator.year, to },
  );
};

const blockUnlessWriter = (state: AppState, next: () => AppState): AppState =>
  canWrite(state) ? next() : notify(state, { kind: "write-blocked" });

/** 状態の更新関数。どの操作も新しい状態を返し、引数の状態は書き換えない */
export const reduce = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "unit-selected":
      return action.unit === state.unit ? state : settle({ ...state, unit: action.unit }, "unit");
    case "year-selected":
      // スライダーは選べる年だけを出すので、選べない年が来たら何もしない
      return selectableYears(state.unit, state.indicator).includes(action.year)
        ? { ...state, year: action.year }
        : state;
    case "indicator-selected":
      // 塗れない指標は選ばせない。年が合わなければ合わせて通知する（メッシュで年齢別の指標と 2020 年など）
      return isIndicatorAvailable(state.unit, action.indicator, state.datasets)
        ? settle({ ...state, indicator: action.indicator }, "unit")
        : state;
    case "datasets-loaded":
      return settle({ ...state, datasets: action.datasets }, "dataset-removed");
    case "dataset-added":
      return blockUnlessWriter(state, () =>
        state.datasets.some((d) => d.id === action.entry.id)
          ? state
          : { ...state, datasets: [...state.datasets, action.entry] },
      );
    case "dataset-removed":
      return blockUnlessWriter(state, () =>
        settle(
          { ...state, datasets: state.datasets.filter((d) => d.id !== action.id) },
          "dataset-removed",
        ),
      );
    case "datasets-cleared":
      return blockUnlessWriter(state, () => settle({ ...state, datasets: [] }, "dataset-removed"));
    case "dataset-style-changed":
      // 閲覧専用のタブでも、表示の切り替えはこのタブの中でだけ効かせる。目録に書くかは app が canWrite で決める
      return {
        ...state,
        datasets: state.datasets.map((d) =>
          d.id === action.id ? { ...d, style: { ...d.style, ...action.style } } : d,
        ),
      };
    case "access-changed": {
      if (action.access === state.access) {
        return state;
      }
      // 前の権利についての通知は、権利が変わった時点で事実と合わなくなるので消す
      const stale: ReadonlySet<NoticeBody["kind"]> =
        action.access === "read-only"
          ? new Set(["became-writer"])
          : new Set(["read-only", "write-blocked"]);
      const next = {
        ...state,
        access: action.access,
        notices: state.notices.filter((n) => !stale.has(n.kind)),
      };
      if (action.access === "read-only") {
        return notify(next, { kind: "read-only" });
      }
      return state.access === "read-only" ? notify(next, { kind: "became-writer" }) : next;
    }
    case "notified":
      return notify(state, action.notice);
    case "notice-dismissed":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
};
