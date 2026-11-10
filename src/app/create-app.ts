// 画面が呼ぶ手続きをまとめる。ストア（store.ts）を持ち、io（ports.ts の口）と core の関数をつなぐ。
// 状態の判断は core の reduce が行い、ここでは副作用の順序を決めて、結果を reduce に渡す。
// 単位、指標、年、データが変わると、ストアの購読から地図を描き直す。

import { isLargeFile } from "../core/accept/file";
import type { Place } from "../core/data/schema";
import { DATA_FILES } from "../core/data/schema";
import {
  buildPlaceIndex,
  type PlaceCandidate,
  parsePlaces,
  searchPlaces,
} from "../core/places/search";
import { adminFillSpec } from "../core/render/admin";
import { type MeshLayerSpec, meshLayerSpec } from "../core/render/mesh";
import { err, ok, type Result } from "../core/result";
import { type Action, type AppState, canWrite } from "../core/state/state";
import type { LayerStyle, Manifest } from "../core/storage/manifest";
import type { DatasetStorage } from "../io/opfs";
import type { ManifestChannel, WriterLock } from "../io/tabs";
import { createPointAssigner } from "./assign";
import { createBaseData } from "./base-data";
import { type Choropleth, choroplethKey, computeChoropleth } from "./choropleth";
import { createDatasetCache } from "./datasets";
import { type ImportFile, readImportFile } from "./import";
import { createOverlayBuilder } from "./overlays";
import { createPersistence, type Persistence } from "./persistence";
import type { AppError, AppPorts, MapView } from "./ports";
import { type AppStore, createAppStore } from "./store";

/** 画面が直接 dispatch してよい操作。データの追加と削除は、目録を書く手続きを通す */
export type UiAction = Extract<
  Action,
  {
    readonly type: "unit-selected" | "year-selected" | "indicator-selected" | "notice-dismissed";
  }
>;

export type App<Container> = {
  readonly store: AppStore;
  /** 置き場所を開き、書き込みのロックを取り、目録を読む。何度呼んでも1回だけ行う */
  readonly boot: () => Promise<Result<void, AppError>>;
  /** 地図を作って描く。前の地図があれば片付ける */
  readonly attachMap: (container: Container) => Promise<Result<void, AppError>>;
  readonly detachMap: () => void;
  /** 単位、年、指標の切り替えと、通知を閉じる操作。地図はストアの購読から描き直す */
  readonly dispatch: (action: UiAction) => void;
  /** ファイルを1つずつ取り込む。拒否は通知に出す */
  readonly importFiles: (files: readonly ImportFile[]) => Promise<void>;
  readonly removeDataset: (id: string) => Promise<void>;
  /** すべてのデータを消す。確かめるのは呼び出す側（画面）の役目 */
  readonly clearDatasets: () => Promise<void>;
  readonly changeDatasetStyle: (id: string, style: Partial<LayerStyle>) => Promise<void>;
  /** places.json を読む。場所の入力欄を初めて開いたときに呼ぶ */
  readonly loadPlaces: () => Promise<void>;
  /** 入力に一致する場所の候補。places.json を読み終えるまでは空 */
  readonly placeCandidates: (query: string) => readonly PlaceCandidate[];
  readonly moveToPlace: (place: Place) => void;
  /** ロック、チャンネル、地図、DuckDB を片付ける */
  readonly dispose: () => Promise<void>;
};

/** メッシュの deck.gl のレイヤーの ID */
export const MESH_LAYER_ID = "rjm-mesh";

export const createApp = <Container>(
  ports: AppPorts<Container>,
  store: AppStore = createAppStore(),
): App<Container> => {
  const { report } = ports;
  const getState = (): AppState => store.getState().state;
  const dispatch = (action: Action): void => store.getState().dispatch(action);
  const setRuntime = store.getState().setRuntime;

  let storage: DatasetStorage | null = null;
  let persistence: Persistence | null = null;
  let lock: WriterLock | null = null;
  let channel: ManifestChannel | null = null;
  let unsubscribeChannel: (() => void) | null = null;

  const base = createBaseData(ports);
  const assignPoints = createPointAssigner({
    base,
    ports,
    onBusy: (busy) => setRuntime({ assigningPoints: busy }),
  });
  const datasets = createDatasetCache({ storage: () => storage, assignPoints });
  const overlays = createOverlayBuilder({ datasets, report });

  // 目録

  /** 目録の内容を状態に反映する。消えたデータの読み込み結果も捨てる */
  const applyManifest = (manifest: Manifest): void => {
    dispatch({ type: "datasets-loaded", datasets: manifest.datasets });
  };

  const reloadManifest = async (): Promise<void> => {
    if (persistence === null) {
      return;
    }
    const loaded = await persistence.load();
    if (loaded.ok) {
      applyManifest(loaded.value);
    } else {
      report(loaded.error);
    }
  };

  /** 書き込み側のタブが閉じて、ロックが渡ってきたとき */
  const onPromoted = (): void => {
    dispatch({ type: "access-changed", access: "writer" });
    void reloadManifest().then(() => persistence?.removeOrphans());
  };

  let booted: Promise<Result<void, AppError>> | null = null;

  const startSession = async (): Promise<Result<void, AppError>> => {
    const opened = await ports.openStorage();
    storage = opened;
    setRuntime({ storage: opened.kind });
    if (opened.kind === "memory") {
      dispatch({ type: "notified", notice: { kind: "storage-unavailable" } });
    }

    const openedChannel = ports.openManifestChannel();
    if (openedChannel.ok) {
      channel = openedChannel.value;
    } else {
      report({ kind: "tabs", error: openedChannel.error });
    }
    persistence = createPersistence({ storage: opened, channel, report });

    // 目録を読む前にロックを取る。書き込み側のタブだけが、目録にないファイルを掃除する
    const acquired = await ports.acquireWriterLock({ onPromoted });
    if (acquired.ok) {
      lock = acquired.value;
    } else {
      // 対象のブラウザ（D20）は Web Locks を持つ。持たない環境では、ほかのタブと調整できないまま書き込める状態にする
      report({ kind: "tabs", error: acquired.error });
    }
    const role = acquired.ok ? acquired.value.role : "writer";
    dispatch({ type: "access-changed", access: role === "writer" ? "writer" : "read-only" });

    // 閲覧専用のタブは、書き込み側のタブが目録を更新したら読み直す
    unsubscribeChannel =
      channel?.subscribe(() => {
        if (!canWrite(getState())) {
          void reloadManifest();
        }
      }) ?? null;

    const loaded = await persistence.load();
    if (!loaded.ok) {
      // 読めない目録のもとでは、データのファイルを掃除しない
      return loaded;
    }
    if (role === "writer") {
      await persistence.removeOrphans();
    }
    applyManifest(loaded.value);
    return ok(undefined);
  };

  const boot = (): Promise<Result<void, AppError>> => {
    booted ??= startSession().then((result) => {
      if (!result.ok) {
        report(result.error);
      }
      return result;
    });
    return booted;
  };

  // 地図

  let map: MapView | null = null;
  let mapGeneration = 0;
  let renderSeq = 0;
  /** 地図に渡した塗り分けの状態。同じなら塗り分けを作り直さず、自前データのレイヤーだけを差し替える */
  let appliedKey: string | null = null;
  /** 地図に渡したメッシュのレイヤー。行政区域を塗っているあいだも、隠して持ち続ける */
  let meshLayer: MeshLayerSpec | null = null;

  /** 塗り分けを地図に渡す形にする。行政区域を塗るときは、メッシュを隠して形を残す */
  const applyChoropleth = (view: MapView, choropleth: Choropleth, key: string): void => {
    if (choropleth.unit === "mesh") {
      meshLayer = meshLayerSpec({
        id: MESH_LAYER_ID,
        geometry: choropleth.geometry,
        values: choropleth.values,
        classification: choropleth.classification,
        colorKey: key,
        visible: true,
      });
      const hidden = view.setAdminFill(adminFillSpec(new Map(), choropleth.classification, false));
      if (!hidden.ok) {
        report({ kind: "map", error: hidden.error });
      }
    } else {
      meshLayer = meshLayer === null ? null : { ...meshLayer, visible: false };
      const filled = view.setAdminFill(
        adminFillSpec(choropleth.values, choropleth.classification, true),
      );
      if (!filled.ok) {
        report({ kind: "map", error: filled.error });
      }
    }
    appliedKey = key;
    setRuntime({ joinedClassification: choropleth.joined ? choropleth.classification : null });
  };

  /**
   * いまの状態で地図を描き直す。読み込みの途中で状態が変わったら、古い結果は捨てる（最後の要求だけを描く）。
   * 読み込みの結果は base-data.ts と datasets.ts が持つので、捨てた要求の読み込みも無駄にならない。
   */
  const render = async (): Promise<void> => {
    const view = map;
    if (view === null) {
      return;
    }
    const seq = ++renderSeq;
    const isCurrent = (): boolean => seq === renderSeq && map === view;
    const state = getState();
    const key = choroplethKey(state);
    let choropleth: Choropleth | null = null;
    if (key !== appliedKey) {
      const computed = await computeChoropleth({ base, datasets }, state);
      if (!isCurrent()) {
        return;
      }
      if (computed.ok) {
        choropleth = computed.value;
      } else {
        report(computed.error);
      }
    }
    const built = await overlays.build(getState().datasets);
    if (!isCurrent()) {
      return;
    }
    if (choropleth !== null) {
      applyChoropleth(view, choropleth, key);
    }
    const shown = view.setOverlayLayers({
      mesh: meshLayer,
      points: built.points,
      geoJsons: built.geoJsons,
    });
    if (!shown.ok) {
      report({ kind: "map", error: shown.error });
    }
  };

  const requestRender = (): void => {
    void render();
  };

  const unsubscribeStore = store.subscribe((next, prev) => {
    const a = next.state;
    const b = prev.state;
    if (a.datasets !== b.datasets) {
      const ids = new Set(a.datasets.map((d) => d.id));
      datasets.retain(ids);
      overlays.retain(ids);
    }
    if (
      a.unit !== b.unit ||
      a.year !== b.year ||
      a.indicator !== b.indicator ||
      a.datasets !== b.datasets
    ) {
      requestRender();
    }
  });

  const resetMapState = (): void => {
    appliedKey = null;
    meshLayer = null;
    setRuntime({ joinedClassification: null });
  };

  const detachMap = (): void => {
    mapGeneration++;
    map?.stop();
    map = null;
    resetMapState();
  };

  const attachMap = async (container: Container): Promise<Result<void, AppError>> => {
    detachMap();
    const generation = mapGeneration;
    const started = await ports.startMap(container);
    if (!started.ok) {
      const error: AppError = { kind: "map", error: started.error };
      report(error);
      return err(error);
    }
    if (generation !== mapGeneration) {
      // 作っているあいだに片付けられた（React の StrictMode で2回つないだときなど）
      started.value.stop();
      return ok(undefined);
    }
    map = started.value;
    await render();
    return ok(undefined);
  };

  // 自前データ

  /** 書き込めないタブでは、何もせずに通知だけを出す */
  const whenWriter = async (task: (p: Persistence) => Promise<void>): Promise<void> => {
    if (!canWrite(getState()) || persistence === null) {
      dispatch({ type: "notified", notice: { kind: "write-blocked" } });
      return;
    }
    await task(persistence);
  };

  /** 最初のデータを取り込んだときに、ブラウザにデータを消さないよう求める（docs/design/user-data.md） */
  const requestPersistenceOnce = async (): Promise<void> => {
    if (storage?.kind !== "opfs") {
      return;
    }
    const persisted = await ports.isPersisted();
    if (persisted.ok && persisted.value) {
      return;
    }
    const granted = await ports.requestPersistence();
    if (!granted.ok) {
      report({ kind: "persistence", error: granted.error });
    } else if (!granted.value) {
      dispatch({ type: "notified", notice: { kind: "storage-not-persistent" } });
    }
  };

  const importOne = (file: ImportFile): Promise<void> =>
    whenWriter(async (p) => {
      if (isLargeFile(file.size)) {
        dispatch({
          type: "notified",
          notice: { kind: "large-file", fileName: file.name, bytes: file.size },
        });
      }
      const outcome = await readImportFile(
        {
          tables: ports.tables,
          readBlob: ports.readBlob,
          paintedCodes: async () => {
            const municipal = await base.municipal();
            return municipal.ok ? ok(municipal.value.paintedCodes) : municipal;
          },
          newId: ports.newId,
          now: ports.now,
          existing: () => getState().datasets,
        },
        file,
      );
      switch (outcome.kind) {
        case "rejected":
          dispatch({
            type: "notified",
            notice: { kind: "import-rejected", fileName: file.name, rejection: outcome.rejection },
          });
          return;
        case "failed":
          report(outcome.error);
          return;
        case "accepted": {
          const wasEmpty = p.manifest().datasets.length === 0;
          const committed = await p.add(outcome.entry, outcome.bytes);
          if (!committed.ok) {
            report(committed.error);
            return;
          }
          dispatch({ type: "dataset-added", entry: outcome.entry });
          if (wasEmpty) {
            // 答えを待たない。Firefox は許可を求める表示を出し、利用者が答えるまで persist() が解決しないので、
            // 待つと後ろの取り込みが止まる（2026-11-10 に Playwright の Firefox 159 で確かめた）
            void requestPersistenceOnce();
          }
          return;
        }
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    });

  let importQueue: Promise<void> = Promise.resolve();
  let importing = 0;

  const importFiles = (files: readonly ImportFile[]): Promise<void> => {
    importing++;
    setRuntime({ importing: true });
    const run = importQueue.then(async () => {
      for (const file of files) {
        // 想定外の例外（プログラムの誤り）が出ても、次のファイルと次の取り込みは続ける
        await importOne(file).catch((e: unknown) => {
          report({
            kind: "unexpected",
            message: `${file.name}: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
      }
    });
    importQueue = run.finally(() => {
      importing--;
      if (importing === 0) {
        setRuntime({ importing: false });
      }
    });
    return importQueue;
  };

  const removeDatasetById = (id: string): Promise<void> =>
    whenWriter(async (p) => {
      const removed = await p.remove(id);
      if (removed.ok) {
        dispatch({ type: "dataset-removed", id });
      } else {
        report(removed.error);
      }
    });

  const clearDatasets = (): Promise<void> =>
    whenWriter(async (p) => {
      const cleared = await p.clear();
      if (cleared.ok) {
        dispatch({ type: "datasets-cleared" });
      } else {
        report(cleared.error);
      }
    });

  /** 閲覧専用のタブでも、表示はこのタブの中でだけ変える（core の reduce）。目録には書かない */
  const changeDatasetStyle = async (id: string, style: Partial<LayerStyle>): Promise<void> => {
    dispatch({ type: "dataset-style-changed", id, style });
    if (!canWrite(getState()) || persistence === null) {
      return;
    }
    const updated = await persistence.updateStyle(id, style);
    if (!updated.ok) {
      report(updated.error);
    }
  };

  // 場所への移動

  const loadPlaces = async (): Promise<void> => {
    const { places } = store.getState().runtime;
    if (places.kind === "loading" || places.kind === "ready") {
      return;
    }
    setRuntime({ places: { kind: "loading" } });
    const fetched = await ports.fetchBaseJson(DATA_FILES.places);
    const parsed = fetched.ok ? parsePlaces(fetched.value) : null;
    if (parsed?.ok) {
      setRuntime({ places: { kind: "ready", index: buildPlaceIndex(parsed.value) } });
      return;
    }
    setRuntime({ places: { kind: "failed" } });
    report({
      kind: "base-data",
      file: DATA_FILES.places,
      message: fetched.ok ? JSON.stringify(parsed?.error) : fetched.error.message,
    });
  };

  const placeCandidates = (query: string): readonly PlaceCandidate[] => {
    const { places } = store.getState().runtime;
    return places.kind === "ready" ? searchPlaces(places.index, query) : [];
  };

  const moveToPlace = (place: Place): void => {
    map?.fitBBox(place.bbox);
  };

  const dispose = async (): Promise<void> => {
    unsubscribeStore();
    unsubscribeChannel?.();
    detachMap();
    channel?.close();
    await lock?.release();
    await ports.tables.stop();
  };

  return {
    store,
    boot,
    attachMap,
    detachMap,
    dispatch,
    importFiles,
    removeDataset: removeDatasetById,
    clearDatasets,
    changeDatasetStyle,
    loadPlaces,
    placeCandidates,
    moveToPlace,
    dispose,
  };
};
