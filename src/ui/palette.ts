// コマンドパレット（CommandPalette.tsx）に並べる項目。操作と、場所への移動の候補を1つの一覧にする。
// 場所の候補は app が core の searchPlaces で作る。ここでは、操作を入力で絞り、場所の候補の前に並べる。

import { normalizePlaceText, type PlaceCandidate } from "../core/places/search";

/** パレットから呼べる操作 */
export type PaletteCommand = {
  readonly id: "region";
  readonly label: string;
  /** 名前のほかに、入力と突き合わせる言葉 */
  readonly keywords: readonly string[];
};

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "region",
    label: "表示する都道府県を選ぶ",
    keywords: ["地域モード", "絞る", "しぼる", "フィルタ", "フィルター"],
  },
];

export type PaletteItem =
  | { readonly kind: "command"; readonly command: PaletteCommand }
  | { readonly kind: "place"; readonly candidate: PlaceCandidate };

const matchesCommand = (command: PaletteCommand, query: string): boolean =>
  [command.label, ...command.keywords].some((text) => normalizePlaceText(text).includes(query));

/**
 * 入力に合う項目。入力が空なら、操作をすべて出す（場所の候補は、入力が空なら app が出さない）。
 * 入力があれば、名前か言葉に入力を含む操作を先に、場所の候補をあとに並べる。
 * 入力は、場所の名前と同じ正規化（core の normalizePlaceText）をしてから突き合わせる
 */
export const paletteItems = (
  input: string,
  places: readonly PlaceCandidate[],
): readonly PaletteItem[] => {
  const query = normalizePlaceText(input);
  const commands = PALETTE_COMMANDS.filter((c) => query === "" || matchesCommand(c, query));
  return [
    ...commands.map((command): PaletteItem => ({ kind: "command", command })),
    ...places.map((candidate): PaletteItem => ({ kind: "place", candidate })),
  ];
};

/** 一覧の項目を見分ける文字列（React の key） */
export const paletteItemKey = (item: PaletteItem): string =>
  item.kind === "command" ? `command:${item.command.id}` : `place:${item.candidate.place.code}`;
