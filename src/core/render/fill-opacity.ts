// 塗り分け（メッシュと行政区域の塗り）の不透明度（docs/design/ui.md の「地図の設定」）。
// 背景地図を写真などに替えても、塗りが不透明のままでは、人のいる場所の背景地図が見えないので選べるようにする。

/**
 * 選べる不透明度。連続の値にしないのは、凡例の色との差を確かめる組み合わせを3つに限るためである。
 * 1 より小さい値では、塗りの色が背景地図の色と混ざり、凡例の色と一致しなくなる
 */
export const FILL_OPACITIES = [1, 0.7, 0.4] as const;

export type FillOpacity = (typeof FILL_OPACITIES)[number];

/** 既定は不透明。段階 B より前と同じ見た目になる */
export const DEFAULT_FILL_OPACITY: FillOpacity = 1;
