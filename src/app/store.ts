// 画面の状態の置き場所（Zustand のストア）。
// 状態の形と更新の判断は core の reduce（src/core/state/state.ts）に任せ、ここでは保持と通知だけをする。
// 手続き（create-app.ts）の結果のうち、core の状態に含めないもの（凡例の区切り、読み込み中かどうかなど）は
// runtime に置く。runtime の値はどれも手続きが core の関数で作ったもので、ストアは判断しない。

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Classification } from "../core/classify/classify";
import type { PlaceIndex } from "../core/places/search";
import { type Action, type AppState, INITIAL_STATE, reduce } from "../core/state/state";

/** places.json の読み込みの状態。初めて場所の入力欄を開いたときに読む */
export type PlacesStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly index: PlaceIndex }
  | { readonly kind: "failed" };

export type RuntimeState = {
  /**
   * 自前データの指標の凡例の区切り（core の joinedClassification で作る）。
   * ベースデータの指標を選んでいるとき、まだ作れていないときは null。
   */
  readonly joinedClassification: Classification | null;
  /** 自前データの置き場所。起動するまでは null。memory のときは再読み込みで消える */
  readonly storage: "opfs" | "memory" | null;
  readonly places: PlacesStatus;
  /** ファイルを取り込んでいる途中か。DuckDB-WASM の起動と、正規化した Parquet の書き出しを含む */
  readonly importing: boolean;
  /** 点を行政区域に割り当てている途中か。初めてのときは spatial 拡張（約 23.6MB）を取得する */
  readonly assigningPoints: boolean;
};

export const INITIAL_RUNTIME: RuntimeState = {
  joinedClassification: null,
  storage: null,
  places: { kind: "idle" },
  importing: false,
  assigningPoints: false,
};

export type AppStoreState = {
  readonly state: AppState;
  readonly runtime: RuntimeState;
  /** core の reduce で状態を更新する */
  readonly dispatch: (action: Action) => void;
  /** 手続きの結果を runtime に書く */
  readonly setRuntime: (patch: Partial<RuntimeState>) => void;
};

export type AppStore = StoreApi<AppStoreState>;

export const createAppStore = (initial: AppState = INITIAL_STATE): AppStore =>
  createStore<AppStoreState>()((set) => ({
    state: initial,
    runtime: INITIAL_RUNTIME,
    // reduce が同じ状態を返したとき（選べない年など）は、購読者に知らせない
    dispatch: (action) =>
      set((s) => {
        const next = reduce(s.state, action);
        return next === s.state ? s : { state: next };
      }),
    setRuntime: (patch) => set((s) => ({ runtime: { ...s.runtime, ...patch } })),
  }));
