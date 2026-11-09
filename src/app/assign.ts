// 点を行政区域に割り当てる手続き（docs/design/user-data.md の「点から行政区域を求める」、D9）。
// 点の範囲に入る都道府県を core で選び、その admin_geom だけを読んで、DuckDB の spatial 拡張で判定する。

import { adminGeomFile } from "../core/data/schema";
import { type PointAdminAssignment, prefecturesForPoints } from "../core/join/admin";
import { err, ok, type Result } from "../core/result";
import type { BaseData } from "./base-data";
import type { AdminGeometry, AppError, AppPorts } from "./ports";

export const createPointAssigner = (deps: {
  readonly base: BaseData;
  readonly ports: Pick<AppPorts<unknown>, "fetchBaseBytes" | "tables">;
  /** 割り当てを始めたときに true、終えたときに false で呼ぶ。spatial 拡張の取得に時間がかかるので画面に示す */
  readonly onBusy: (busy: boolean) => void;
}) => {
  /** 都道府県ごとの admin_geom。一度読んだものは持っておく */
  const geometries = new Map<string, Promise<Result<AdminGeometry, AppError>>>();
  const geometryOf = (prefCode: string): Promise<Result<AdminGeometry, AppError>> => {
    const cached = geometries.get(prefCode);
    if (cached !== undefined) {
      return cached;
    }
    const file = adminGeomFile(prefCode);
    const loading = deps.ports
      .fetchBaseBytes(file)
      .then(
        (r): Result<AdminGeometry, AppError> =>
          r.ok
            ? ok({ prefCode, bytes: r.value })
            : err({ kind: "base-data", file, message: r.error.message }),
      );
    geometries.set(prefCode, loading);
    void loading.then((r) => {
      if (!r.ok) {
        geometries.delete(prefCode);
      }
    });
    return loading;
  };

  let running = 0;
  const busy = async <T>(task: () => Promise<T>): Promise<T> => {
    running++;
    if (running === 1) {
      deps.onBusy(true);
    }
    try {
      return await task();
    } finally {
      running--;
      if (running === 0) {
        deps.onBusy(false);
      }
    }
  };

  return (lat: Float64Array, lon: Float64Array): Promise<Result<PointAdminAssignment, AppError>> =>
    busy(async () => {
      const index = await deps.base.adminGeomIndex();
      if (!index.ok) {
        return index;
      }
      const prefCodes = prefecturesForPoints(index.value, lat, lon);
      if (prefCodes.length === 0) {
        // どの都道府県の範囲にも入らない点だけなら、spatial 拡張を読み込まずに済む
        return ok({ codes: new Array<string | null>(lat.length).fill(null) });
      }
      const loaded: AdminGeometry[] = [];
      for (const prefCode of prefCodes) {
        const geometry = await geometryOf(prefCode);
        if (!geometry.ok) {
          return geometry;
        }
        loaded.push(geometry.value);
      }
      const assigned = await deps.ports.tables.assignPoints({ lat, lon }, loaded);
      return assigned.ok ? assigned : err({ kind: "engine", error: assigned.error });
    });
};
