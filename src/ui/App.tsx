// 画面の配置。地図を画面全体に広げ、部品を地図の上に重ねる（docs/design/ui.md の「画面の構成」）。
// 状態は app のストアから読み、利用者の操作は app の手続きに渡す（src/app/README.md の「段階 7 での使い方」）。
// 出典は地図の右下の AttributionControl が出す（src/io/map.ts）。

import { useEffect, useState } from "react";
import { app, useAppStore } from "../app/instance";
import { ACCEPTANCE_URL } from "../app/links";
import { searchPlaces } from "../core/places/search";
import { selectableYears } from "../core/state/state";
import { AddDataButton } from "./AddDataButton";
import { DropOverlay } from "./DropOverlay";
import { hasFiles, nextDragDepth } from "./file-drag";
import { IndicatorPanel } from "./IndicatorPanel";
import { isMacPlatform, isPlaceSearchShortcut } from "./keyboard";
import { LayerPanel } from "./LayerPanel";
import { NoticeList } from "./NoticeList";
import { PlaceSearch } from "./PlaceSearch";
import { YearSlider } from "./YearSlider";
import { trackYears } from "./year-slider";

type SearchState = { readonly open: boolean; readonly query: string; readonly activeIndex: number };

const CLOSED_SEARCH: SearchState = { open: false, query: "", activeIndex: -1 };

const dataTransferTypes = (e: DragEvent): readonly string[] =>
  Array.from(e.dataTransfer?.types ?? []);

/**
 * 地図の要素の ref。描くたびに新しい関数を渡すと地図を作り直すので、部品の外に置く。
 * React 19 の ref の後片付けで、StrictMode の2回のつなぎ直しにも対応する。
 */
const attachMapElement = (el: HTMLDivElement | null): (() => void) | undefined => {
  if (el === null) {
    return undefined;
  }
  void app.attachMap(el);
  return () => app.detachMap();
};

export const App = () => {
  const state = useAppStore((s) => s.state);
  const runtime = useAppStore((s) => s.runtime);
  const [dragDepth, setDragDepth] = useState(0);
  const [search, setSearch] = useState<SearchState>(CLOSED_SEARCH);

  // Ctrl（macOS では Command）+ K で場所への移動の入力欄を開く。places.json は初めて開いたときに読む
  useEffect(() => {
    const isMac = isMacPlatform(navigator.platform);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isPlaceSearchShortcut(e, isMac)) {
        e.preventDefault();
        setSearch((s) => (s.open ? s : { ...CLOSED_SEARCH, open: true }));
        void app.loadPlaces();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 地図全体をドロップ先にする。ファイルを含まないドラッグ（文字列など）は扱わない
  useEffect(() => {
    const onEnter = (e: DragEvent): void => {
      if (hasFiles(dataTransferTypes(e))) {
        e.preventDefault();
        setDragDepth((d) => nextDragDepth(d, "enter"));
      }
    };
    const onOver = (e: DragEvent): void => {
      if (hasFiles(dataTransferTypes(e)) && e.dataTransfer !== null) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onLeave = (e: DragEvent): void => {
      if (hasFiles(dataTransferTypes(e))) {
        setDragDepth((d) => nextDragDepth(d, "leave"));
      }
    };
    const onDrop = (e: DragEvent): void => {
      if (hasFiles(dataTransferTypes(e))) {
        e.preventDefault();
        setDragDepth((d) => nextDragDepth(d, "drop"));
        void app.importFiles(Array.from(e.dataTransfer?.files ?? []));
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // app.placeCandidates と同じ計算。runtime.places から作り、読み終えたときに候補が描き直されるようにする
  const { places } = runtime;
  const candidates = places.kind === "ready" ? searchPlaces(places.index, search.query) : [];

  return (
    <main className="relative h-dvh overflow-hidden bg-solid-gray-100 font-sans">
      <h1 className="sr-only">RightsizingJPMap</h1>
      <div ref={attachMapElement} className="size-full" />

      <div className="absolute top-6 left-6 z-10">
        <IndicatorPanel
          unit={state.unit}
          indicator={state.indicator}
          datasets={state.datasets}
          joinedClassification={runtime.joinedClassification}
          onIndicatorChange={(indicator) => app.dispatch({ type: "indicator-selected", indicator })}
          onUnitChange={(unit) => app.dispatch({ type: "unit-selected", unit })}
        />
      </div>

      <div className="absolute top-6 right-6 z-10 flex flex-col items-end gap-2">
        <AddDataButton onFiles={(files) => void app.importFiles(files)} />
        <LayerPanel
          datasets={state.datasets}
          onStyleChange={(id, style) => void app.changeDatasetStyle(id, style)}
          onRemove={(id) => void app.removeDataset(id)}
          onRemoveAll={() => {
            // 取り込んだデータは元に戻せないので、消す前に確かめる（D27 で window.confirm のままにした）
            if (window.confirm("取り込んだデータをすべて削除します。元に戻せません。")) {
              void app.clearDatasets();
            }
          }}
        />
      </div>

      <div className="absolute bottom-10 left-1/2 z-10 -translate-x-1/2">
        <YearSlider
          years={trackYears(state.unit)}
          selectableYears={selectableYears(state.unit, state.indicator)}
          value={state.year}
          onChange={(year) => app.dispatch({ type: "year-selected", year })}
        />
      </div>

      <NoticeList
        notices={state.notices}
        acceptanceUrl={ACCEPTANCE_URL}
        onDismiss={(id) => app.dispatch({ type: "notice-dismissed", id })}
      />

      {search.open && (
        <PlaceSearch
          query={search.query}
          candidates={candidates}
          activeIndex={search.activeIndex}
          loading={places.kind === "loading"}
          onQueryChange={(query) => setSearch({ open: true, query, activeIndex: -1 })}
          onActiveIndexChange={(activeIndex) => setSearch((s) => ({ ...s, activeIndex }))}
          onSelect={(place) => {
            app.moveToPlace(place);
            setSearch(CLOSED_SEARCH);
          }}
          onClose={() => setSearch(CLOSED_SEARCH)}
        />
      )}

      <DropOverlay visible={dragDepth > 0} />
    </main>
  );
};
