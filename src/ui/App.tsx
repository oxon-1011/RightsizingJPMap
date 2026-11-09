// 仮の配置。地図の代わりの灰色の背景の上に、部品を見本の値で並べる（段階 6）。
// Figma の画面 01〜04 と見比べるため、URL の ?screen=02 などで画面を選べる。
// 状態は core の reduce を useReducer で回すだけにし、段階 5 で Zustand のストアに、段階 7 で地図との結線に置き換える。
// 公開したサイトから生成物（data/<版>/）を配るので、仮の画面にも出典と加工の表示を置く（docs/user/attribution.md）。

import { useEffect, useReducer, useState } from "react";
import { detectFormat, isLargeFile } from "../core/accept/file";
import type { Place } from "../core/data/schema";
import { buildPlaceIndex, searchPlaces } from "../core/places/search";
import { type Action, reduce, selectableYears } from "../core/state/state";
import { AddDataButton } from "./AddDataButton";
import { DropOverlay } from "./DropOverlay";
import { Link } from "./dads/Link";
import { hasFiles, nextDragDepth } from "./file-drag";
import { IndicatorPanel } from "./IndicatorPanel";
import { isMacPlatform, isPlaceSearchShortcut } from "./keyboard";
import { LayerPanel } from "./LayerPanel";
import { NoticeList } from "./NoticeList";
import { PlaceSearch } from "./PlaceSearch";
import {
  parseSampleScreen,
  SAMPLE_JOINED_CLASSIFICATION,
  SAMPLE_PLACES,
  sampleState,
} from "./samples";
import { YearSlider } from "./YearSlider";
import { trackYears } from "./year-slider";

const SOURCES = [
  {
    title: "国土数値情報（1kmメッシュ別将来推計人口（R6国政局推計））",
    owner: "国土交通省",
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-mesh1000r6.html",
  },
  {
    title: "国土数値情報（行政区域データ）",
    owner: "国土交通省",
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html",
  },
  {
    title: "日本の地域別将来推計人口（令和5年推計）",
    owner: "国立社会保障・人口問題研究所",
    url: "https://www.ipss.go.jp/pp-shicyoson/j/shicyoson23/t-page.asp",
  },
] as const;

/** 受け入れ条件の文書。docs/user/ は Git で管理し、GitHub 上のページを指す（2026-11-09 に決めた） */
const ACCEPTANCE_URL =
  "https://github.com/oxon-1011/RightsizingJPMap/blob/main/docs/user/acceptance.md";

const PLACE_INDEX = buildPlaceIndex(SAMPLE_PLACES);

type SearchState = { readonly open: boolean; readonly query: string; readonly activeIndex: number };

const CLOSED_SEARCH: SearchState = { open: false, query: "", activeIndex: -1 };

/**
 * 選んだかドロップしたファイルの扱い。取り込みは段階 5 で app に書くので、ここでは拡張子と大きさだけを見て通知する。
 */
const handleFiles = (dispatch: (action: Action) => void, files: readonly File[]): void => {
  for (const file of files) {
    const format = detectFormat(file.name);
    if (!format.ok) {
      dispatch({
        type: "notified",
        notice: { kind: "import-rejected", fileName: file.name, rejection: format.error },
      });
    } else if (isLargeFile(file.size)) {
      dispatch({
        type: "notified",
        notice: { kind: "large-file", fileName: file.name, bytes: file.size },
      });
    }
  }
};

const dataTransferTypes = (e: DragEvent): readonly string[] =>
  Array.from(e.dataTransfer?.types ?? []);

export const App = () => {
  const [screen] = useState(() =>
    parseSampleScreen(new URLSearchParams(window.location.search).get("screen")),
  );
  const [state, dispatch] = useReducer(reduce, screen, sampleState);
  const [dragDepth, setDragDepth] = useState(0);
  const [search, setSearch] = useState<SearchState>(CLOSED_SEARCH);
  const [movedTo, setMovedTo] = useState<Place | null>(null);

  // Ctrl（macOS では Command）+ K で場所への移動の入力欄を開く
  useEffect(() => {
    const isMac = isMacPlatform(navigator.platform);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isPlaceSearchShortcut(e, isMac)) {
        e.preventDefault();
        setSearch((s) => (s.open ? s : { ...CLOSED_SEARCH, open: true }));
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
        handleFiles(dispatch, Array.from(e.dataTransfer?.files ?? []));
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

  const candidates = searchPlaces(PLACE_INDEX, search.query);

  return (
    <main className="relative h-dvh overflow-hidden bg-solid-gray-100 font-sans">
      <h1 className="sr-only">RightsizingJPMap</h1>
      <p
        aria-hidden={true}
        className="absolute inset-0 flex items-center justify-center text-oln-16N-100 text-solid-gray-536"
      >
        {movedTo === null ? "地図（段階 7 で結線する）" : `地図：${movedTo.name}へ移動`}
      </p>

      <div className="absolute top-6 left-6">
        <IndicatorPanel
          unit={state.unit}
          indicator={state.indicator}
          datasets={state.datasets}
          joinedClassification={SAMPLE_JOINED_CLASSIFICATION}
          onIndicatorChange={(indicator) => dispatch({ type: "indicator-selected", indicator })}
          onUnitChange={(unit) => dispatch({ type: "unit-selected", unit })}
        />
      </div>

      <div className="absolute top-6 right-6 flex flex-col items-end gap-2">
        <AddDataButton onFiles={(files) => handleFiles(dispatch, files)} />
        <LayerPanel
          datasets={state.datasets}
          onStyleChange={(id, style) => dispatch({ type: "dataset-style-changed", id, style })}
          onRemove={(id) => dispatch({ type: "dataset-removed", id })}
          onRemoveAll={() => {
            // 取り込んだデータは元に戻せないので、消す前に確かめる。段階 5 で DADS のダイアログに替えるかを決める
            if (window.confirm("取り込んだデータをすべて削除します。元に戻せません。")) {
              dispatch({ type: "datasets-cleared" });
            }
          }}
        />
      </div>

      <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
        <YearSlider
          years={trackYears(state.unit)}
          selectableYears={selectableYears(state.unit, state.indicator)}
          value={state.year}
          onChange={(year) => dispatch({ type: "year-selected", year })}
        />
      </div>

      {/* 出典は段階 4 で MapLibre の AttributionControl に移す。それまではこの節を残す */}
      <section className="absolute bottom-2 left-2 max-w-100 rounded-4 bg-white/80 px-2 py-1 text-dns-14N-130 text-solid-gray-700">
        <h2 className="sr-only">出典</h2>
        <ul>
          {SOURCES.map((s) => (
            <li key={s.url}>
              「{s.title}」（{s.owner}）（
              <Link href={s.url}>{s.url}</Link>
              ）を加工して作成
            </li>
          ))}
        </ul>
      </section>

      <NoticeList
        notices={state.notices}
        acceptanceUrl={ACCEPTANCE_URL}
        onDismiss={(id) => dispatch({ type: "notice-dismissed", id })}
      />

      {search.open && (
        <PlaceSearch
          query={search.query}
          candidates={candidates}
          activeIndex={search.activeIndex}
          loading={false}
          onQueryChange={(query) => setSearch({ open: true, query, activeIndex: -1 })}
          onActiveIndexChange={(activeIndex) => setSearch((s) => ({ ...s, activeIndex }))}
          onSelect={(place) => {
            setMovedTo(place);
            setSearch(CLOSED_SEARCH);
          }}
          onClose={() => setSearch(CLOSED_SEARCH)}
        />
      )}

      <DropOverlay visible={screen === "02" || dragDepth > 0} />
    </main>
  );
};
