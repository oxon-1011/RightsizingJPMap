import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";

describe("createAppStore", () => {
  it("操作を core の reduce に渡し、状態が変わらなければ購読者に知らせない", () => {
    const store = createAppStore();
    let notified = 0;
    store.subscribe(() => {
      notified++;
    });
    store.getState().dispatch({ type: "year-selected", year: 2030 });
    expect(store.getState().state.year).toBe(2030);
    expect(notified).toBe(1);
    // メッシュの年齢別の指標では 2020 年を選べないので、reduce は同じ状態を返す
    store.getState().dispatch({ type: "year-selected", year: 2020 });
    expect(notified).toBe(1);
  });

  it("手続きの結果を runtime に書く", () => {
    const store = createAppStore();
    store.getState().setRuntime({ importing: true });
    expect(store.getState().runtime).toMatchObject({ importing: true, assigningPoints: false });
  });
});
