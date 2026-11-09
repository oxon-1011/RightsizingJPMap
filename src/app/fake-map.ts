// テストで使う地図の偽物。渡された描画の指定を順に記録する。node とブラウザのテストの両方から使う。

import type { BBox } from "../core/data/schema";
import type { AdminFillSpec } from "../core/render/admin";
import { ok } from "../core/result";
import type { OverlayLayers } from "../io/deck-layers";
import type { MapView } from "./ports";

export type MapCall =
  | { readonly kind: "admin"; readonly spec: AdminFillSpec }
  | { readonly kind: "overlay"; readonly layers: OverlayLayers }
  | { readonly kind: "fit"; readonly bbox: BBox };

export const fakeMap = (): { readonly view: MapView; readonly calls: MapCall[] } => {
  const calls: MapCall[] = [];
  return {
    calls,
    view: {
      setAdminFill: (spec) => {
        calls.push({ kind: "admin", spec });
        return ok(undefined);
      },
      setOverlayLayers: (layers) => {
        calls.push({ kind: "overlay", layers });
        return ok(undefined);
      },
      fitBBox: (bbox) => {
        calls.push({ kind: "fit", bbox });
      },
      stop: () => undefined,
    },
  };
};
