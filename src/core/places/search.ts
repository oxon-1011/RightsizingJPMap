// 場所への移動の候補を作る（docs/design/ui.md の「場所への移動」）。
// 名前は NFKC で正規化して比べ、前方一致を部分一致より上に並べる。読み仮名での検索はしない。

import type { BBox, Place } from "../data/schema";
import { err, ok, type Result } from "../result";

/**
 * 比べる前の正規化。NFKC で全角と半角の違いをなくし、空白を取り除く。
 * 空白を取り除くのは「浜松市 中央区」と「浜松市中央区」を同じに扱うため。
 */
export const normalizePlaceText = (text: string): string =>
  text.normalize("NFKC").replace(/\s+/gu, "");

type IndexedPlace = {
  readonly place: Place;
  /** 正規化した名前 */
  readonly name: string;
  /** 正規化した、都道府県名を前に付けた名前（「静岡県浜松市」）。都道府県は名前と同じ */
  readonly fullName: string;
};

/** 検索のための索引。places.json を読んだあと一度だけ作る */
export type PlaceIndex = readonly IndexedPlace[];

export const buildPlaceIndex = (places: readonly Place[]): PlaceIndex =>
  places.map((place) => {
    const name = normalizePlaceText(place.name);
    return {
      place,
      name,
      fullName:
        place.kind === "prefecture" ? name : normalizePlaceText(`${place.pref_name}${place.name}`),
    };
  });

export type PlaceCandidate = {
  readonly place: Place;
  /** 一致の種類。前方一致の候補を部分一致の候補より上に並べる */
  readonly match: "prefix" | "substring";
  /** 候補に添える都道府県名。都道府県そのものには添えないので null */
  readonly prefName: string | null;
};

/** 先頭に出す候補の数の既定値 */
export const DEFAULT_CANDIDATE_LIMIT = 10;

const matchOf = (entry: IndexedPlace, query: string): PlaceCandidate["match"] | null => {
  if (entry.name.startsWith(query) || entry.fullName.startsWith(query)) {
    return "prefix";
  }
  if (entry.name.includes(query) || entry.fullName.includes(query)) {
    return "substring";
  }
  return null;
};

/**
 * 入力に一致する場所の候補。前方一致、部分一致の順に並べ、同じ一致の中では名前の短い順、団体コードの順にする。
 * 正規化した入力が空なら候補を出さない。
 */
export const searchPlaces = (
  index: PlaceIndex,
  input: string,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): readonly PlaceCandidate[] => {
  const query = normalizePlaceText(input);
  if (query === "") {
    return [];
  }
  const rank = { prefix: 0, substring: 1 } as const;
  return index
    .flatMap((entry) => {
      const match = matchOf(entry, query);
      return match === null ? [] : [{ entry, match }];
    })
    .sort(
      (a, b) =>
        rank[a.match] - rank[b.match] ||
        a.entry.name.length - b.entry.name.length ||
        (a.entry.place.code < b.entry.place.code
          ? -1
          : a.entry.place.code > b.entry.place.code
            ? 1
            : 0),
    )
    .slice(0, limit)
    .map(({ entry, match }) => ({
      place: entry.place,
      match,
      prefName: entry.place.kind === "prefecture" ? null : entry.place.pref_name,
    }));
};

export type PlacesError = { readonly kind: "invalid"; readonly index: number | null };

const KINDS: readonly string[] = ["prefecture", "designated-city", "ward", "municipality"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlaceKind = (value: unknown): value is Place["kind"] =>
  typeof value === "string" && KINDS.includes(value);

const parseBBox = (value: unknown): BBox | null => {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const [west, south, east, north]: readonly unknown[] = value;
  return typeof west === "number" &&
    typeof south === "number" &&
    typeof east === "number" &&
    typeof north === "number" &&
    [west, south, east, north].every(Number.isFinite) &&
    west <= east &&
    south <= north
    ? [west, south, east, north]
    : null;
};

const parsePlace = (value: unknown): Place | null => {
  if (!isRecord(value)) {
    return null;
  }
  const { code, name, pref_name, kind, bbox } = value;
  const parsedBBox = parseBBox(bbox);
  return typeof code === "string" &&
    /^\d{5}$/.test(code) &&
    typeof name === "string" &&
    name !== "" &&
    typeof pref_name === "string" &&
    isPlaceKind(kind) &&
    parsedBBox !== null
    ? { code, name, pref_name, kind, bbox: parsedBBox }
    : null;
};

/** JSON.parse した places.json を検査する。形の違う要素があれば、その番号（0始まり）を返す */
export const parsePlaces = (input: unknown): Result<readonly Place[], PlacesError> => {
  if (!Array.isArray(input)) {
    return err({ kind: "invalid", index: null });
  }
  const places: Place[] = [];
  for (const [i, value] of input.entries()) {
    const place = parsePlace(value);
    if (place === null) {
      return err({ kind: "invalid", index: i });
    }
    places.push(place);
  }
  return ok(places);
};
