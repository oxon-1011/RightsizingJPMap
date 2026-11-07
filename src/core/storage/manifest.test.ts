import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDataset,
  type DatasetEntry,
  datasetFileName,
  EMPTY_MANIFEST,
  LAYER_COLORS,
  type Manifest,
  newDatasetEntry,
  nextLayerColor,
  orphanDatasetFiles,
  parseManifest,
  removeDataset,
  serializeManifest,
  updateDatasetStyle,
} from "./manifest";

const entry = (id: string, overrides: Partial<DatasetEntry> = {}): DatasetEntry => ({
  id,
  name: "医療施設",
  source: { name: "hospitals.csv", size: 1234 },
  imported_at: "2026-11-07T10:00:00.000Z",
  kind: "point",
  join: ["mesh", "municipality"],
  columns: [
    { name: "lat", type: "float" },
    { name: "lon", type: "float" },
    { name: "beds", type: "integer" },
  ],
  style: { color: "#0072b2", size: 4, visible: true },
  stored_format: "parquet",
  ...overrides,
});

const manifest = (...datasets: DatasetEntry[]): Manifest => ({ ...EMPTY_MANIFEST, datasets });

describe("parseManifest", () => {
  it("書き出した目録を読み戻すと同じになる", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), { maxLength: 5 }),
        fc.string(),
        fc.boolean(),
        (ids, name, visible) => {
          const original = manifest(
            ...ids.map((id) => entry(id, { name, style: { color: "#cc79a7", size: 2, visible } })),
          );
          expect(parseManifest(JSON.parse(serializeManifest(original)))).toEqual({
            ok: true,
            value: original,
          });
        },
      ),
    );
  });

  it("版が違う目録は拒否する", () => {
    expect(parseManifest({ schema_version: 2, datasets: [] })).toEqual({
      ok: false,
      error: { kind: "unsupported-version", version: 2 },
    });
    expect(parseManifest({ datasets: [] })).toEqual({
      ok: false,
      error: { kind: "unsupported-version", version: undefined },
    });
  });

  it("形が違う項目は、その場所を示して拒否する", () => {
    const bad = (overrides: Record<string, unknown>) =>
      parseManifest({ schema_version: 1, datasets: [entry("a"), { ...entry("b"), ...overrides }] });
    expect(bad({ id: "../x" })).toEqual({
      ok: false,
      error: { kind: "invalid", path: "datasets[1].id" },
    });
    expect(bad({ style: { color: "blue", size: 4, visible: true } })).toEqual({
      ok: false,
      error: { kind: "invalid", path: "datasets[1].style.color" },
    });
    expect(bad({ join: ["prefecture"] })).toEqual({
      ok: false,
      error: { kind: "invalid", path: "datasets[1].join" },
    });
    expect(bad({ imported_at: "2026/11/07" })).toEqual({
      ok: false,
      error: { kind: "invalid", path: "datasets[1].imported_at" },
    });
    expect(bad({ columns: [{ name: "x", type: "date" }] })).toEqual({
      ok: false,
      error: { kind: "invalid", path: "datasets[1].columns[0].type" },
    });
  });

  it("同じ id が2つある目録は拒否する", () => {
    expect(parseManifest({ schema_version: 1, datasets: [entry("a"), entry("a")] })).toEqual({
      ok: false,
      error: { kind: "duplicate-id", id: "a" },
    });
  });
});

describe("orphanDatasetFiles", () => {
  it("目録にないファイルの名前を返す", () => {
    const m = manifest(entry("a"), entry("b", { stored_format: "geojson" }));
    expect(orphanDatasetFiles(m, ["a.parquet", "b.geojson", "b.parquet", "c.parquet"])).toEqual([
      "b.parquet",
      "c.parquet",
    ]);
  });

  it("目録にあるファイルは決して返さない", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 8 }),
        fc.array(fc.stringMatching(/^[a-z]{1,8}\.(parquet|geojson)$/), { maxLength: 8 }),
        (ids, others) => {
          const m = manifest(...ids.map((id) => entry(id)));
          const known = m.datasets.map(datasetFileName);
          const orphans = orphanDatasetFiles(m, [...known, ...others]);
          expect(orphans.some((name) => known.includes(name))).toBe(false);
        },
      ),
    );
  });
});

describe("目録の操作", () => {
  it("追加、表示設定の変更、削除", () => {
    const added = addDataset(EMPTY_MANIFEST, entry("a"));
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    expect(addDataset(added.value, entry("a"))).toEqual({
      ok: false,
      error: { kind: "duplicate-id", id: "a" },
    });
    const hidden = updateDatasetStyle(added.value, "a", { visible: false });
    expect(hidden.datasets[0]?.style).toEqual({ color: "#0072b2", size: 4, visible: false });
    expect(removeDataset(hidden, "a").datasets).toEqual([]);
  });

  it("新しいデータには、まだ使っていない色を割り当てる", () => {
    expect(nextLayerColor([])).toBe(LAYER_COLORS[0]);
    expect(
      nextLayerColor([entry("a", { style: { color: "#0072B2", size: 4, visible: true } })]),
    ).toBe(LAYER_COLORS[1]);
  });

  it("CSV の点からは、lat と lon を DOUBLE にした Parquet の項目を作る", () => {
    const created = newDatasetEntry({
      id: "x1",
      name: "施設",
      source: { name: "a.csv", size: 10 },
      importedAt: "2026-11-07T10:00:00Z",
      accepted: {
        source: "table",
        table: {
          format: "csv",
          rowCount: 1,
          join: { kind: "point", lat: Float64Array.of(35), lon: Float64Array.of(139) },
          attributes: [{ name: "beds", type: "integer" }],
        },
      },
      existing: [],
    });
    expect(created).toEqual({
      id: "x1",
      name: "施設",
      source: { name: "a.csv", size: 10 },
      imported_at: "2026-11-07T10:00:00Z",
      kind: "point",
      join: ["mesh", "municipality"],
      columns: [
        { name: "lat", type: "float" },
        { name: "lon", type: "float" },
        { name: "beds", type: "integer" },
      ],
      style: { color: LAYER_COLORS[0], size: 4, visible: true },
      stored_format: "parquet",
    });
  });

  it("GeoJSON の面は、どこにも結合しない項目にする", () => {
    const created = newDatasetEntry({
      id: "x2",
      name: "管轄",
      source: { name: "area.geojson", size: 10 },
      importedAt: "2026-11-07T10:00:00Z",
      accepted: {
        source: "geojson",
        geojson: { geometryKind: "polygon", featureCount: 1, attributes: [], points: null },
      },
      existing: [],
    });
    expect(created).toMatchObject({ kind: "polygon", join: [], stored_format: "geojson" });
  });
});
