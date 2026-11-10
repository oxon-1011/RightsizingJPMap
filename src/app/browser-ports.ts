// ブラウザで手続きが使う副作用の口（ports.ts）を、io の関数で作る。
// 生成物と public/ の URL は data-url.ts で、外部向けの文書の URL は links.ts で組み立てる。

import { type BBox, DATA_FILES } from "../core/data/schema";
import type { DataFile } from "../core/data/url";
import { err, ok, type Result } from "../core/result";
import { fetchBytes, readBlobBytes } from "../io/bytes";
import {
  BASEMAP_STYLE_FILE,
  fitBBox,
  setAdminFill,
  setOverlayLayers,
  startMap,
  stopMap,
} from "../io/map";
import { isPersisted, openStorage, requestPersistence } from "../io/opfs";
import { openParquetUrl } from "../io/parquet";
import { acquireWriterLock, openManifestChannel } from "../io/tabs";
import { baseDataUrl, publicFileUrl } from "./data-url";
import { decodeJson } from "./datasets";
import { createDuckDbEngine } from "./duckdb-engine";
import { ATTRIBUTION_DETAILS_URL } from "./links";
import type { AppPorts, FetchError, MapView } from "./ports";

/** 最初に映す範囲。日本の全体（与那国島から宗谷岬まで）が収まる */
export const INITIAL_BOUNDS: BBox = [122.9, 24.0, 146.0, 45.6];

/** 生成物のファイル全体を読む。admin_geom の都道府県のファイル（数百 KB）と、小さな JSON に使う */
const fetchBaseBytes = async (file: DataFile): Promise<Result<Uint8Array, FetchError>> => {
  const bytes = await fetchBytes(baseDataUrl(file));
  return bytes.ok
    ? bytes
    : err({ kind: "fetch-failed", message: `${file}: ${bytes.error.message}` });
};

const fetchJson = async (file: DataFile): Promise<Result<unknown, FetchError>> => {
  const bytes = await fetchBaseBytes(file);
  if (!bytes.ok) {
    return bytes;
  }
  const json = decodeJson(bytes.value);
  return json.ok ? json : err({ kind: "invalid-json", message: `${file}: ${json.error}` });
};

const readBlob = async (blob: Blob): Promise<Result<Uint8Array, FetchError>> => {
  const bytes = await readBlobBytes(blob);
  return bytes.ok ? bytes : err({ kind: "fetch-failed", message: bytes.error.message });
};

const startMapView = async (container: HTMLElement) => {
  const started = await startMap({
    container,
    styleUrl: publicFileUrl(BASEMAP_STYLE_FILE),
    adminTilesUrl: baseDataUrl(DATA_FILES.adminTiles),
    bounds: INITIAL_BOUNDS,
    attributionDetailsUrl: ATTRIBUTION_DETAILS_URL,
  });
  if (!started.ok) {
    return started;
  }
  const handle = started.value;
  const view: MapView = {
    setAdminFill: (spec) => setAdminFill(handle, spec),
    setOverlayLayers: (layers) => setOverlayLayers(handle, layers),
    fitBBox: (bbox) => fitBBox(handle, bbox),
    stop: () => stopMap(handle),
  };
  return ok(view);
};

export const browserPorts = (): AppPorts<HTMLElement> => ({
  openStorage,
  acquireWriterLock: (options) => acquireWriterLock(options),
  openManifestChannel: () => openManifestChannel(),
  requestPersistence,
  isPersisted,
  openBaseParquet: (file) => openParquetUrl(baseDataUrl(file)),
  fetchBaseJson: fetchJson,
  fetchBaseBytes,
  readBlob,
  tables: createDuckDbEngine(),
  startMap: startMapView,
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
  report: (error) => console.error("[RightsizingJPMap]", error),
});
