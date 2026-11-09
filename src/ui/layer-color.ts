// レイヤーの色の候補（core の LAYER_COLORS）の名前。色を選ぶときに、スクリーンリーダーが読み上げる。

/** LAYER_COLORS の色の名前。Okabe と Ito の配色の呼び方に合わせる */
const NAMES: Readonly<Record<string, string>> = {
  "#0072b2": "青",
  "#009e73": "青緑",
  "#cc79a7": "赤紫",
  "#56b4e9": "空色",
  "#d55e00": "朱色",
  "#e69f00": "オレンジ",
  "#f0e442": "黄",
  "#000000": "黒",
};

/** 色の名前。候補にない色は、16 進数の表記のまま返す */
export const layerColorName = (color: string): string => NAMES[color.toLowerCase()] ?? color;
