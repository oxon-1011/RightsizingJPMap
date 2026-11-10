// テストで使う地図の偽物。渡された描画の指定を順に記録する。node とブラウザのテストの両方から使う。
// ポインタの知らせは、テストが pointer で送る。

import type { BBox } from "../core/data/schema";
import type { AdminFillSpec } from "../core/render/admin";
import type { BasemapVisibility } from "../core/render/basemap";
import { ok } from "../core/result";
import type { OverlayLayers } from "../io/deck-layers";
import type { MapPointerEvent } from "../io/map";
import type { MapView } from "./ports";

export type MapCall =
  | { readonly kind: "admin"; readonly spec: AdminFillSpec }
  | { readonly kind: "overlay"; readonly layers: OverlayLayers }
  | { readonly kind: "basemap"; readonly visibility: BasemapVisibility }
  | { readonly kind: "fit"; readonly bbox: BBox };

export const fakeMap = (): {
  readonly view: MapView;
  readonly calls: MapCall[];
  /** watchPointer で登録された聞き手に、ポインタの知らせを送る */
  readonly pointer: (event: MapPointerEvent) => void;
  /** いま登録されている聞き手の数 */
  readonly pointerListeners: () => number;
} => {
  const calls: MapCall[] = [];
  const listeners = new Set<(event: MapPointerEvent) => void>();
  return {
    calls,
    pointer: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    pointerListeners: () => listeners.size,
    view: {
      setAdminFill: (spec) => {
        calls.push({ kind: "admin", spec });
        return ok(undefined);
      },
      setOverlayLayers: (layers) => {
        calls.push({ kind: "overlay", layers });
        return ok(undefined);
      },
      setBasemapVisibility: (visibility) => {
        calls.push({ kind: "basemap", visibility });
        return ok(undefined);
      },
      fitBBox: (bbox) => {
        calls.push({ kind: "fit", bbox });
      },
      watchPointer: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      stop: () => undefined,
    },
  };
};
