import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type DragEventKind, hasFiles, nextDragDepth } from "./file-drag";

describe("hasFiles", () => {
  it("ファイルを含むドラッグだけを受け付ける", () => {
    expect(hasFiles(["Files"])).toBe(true);
    expect(hasFiles(["text/plain", "Files"])).toBe(true);
    expect(hasFiles(["text/plain", "text/uri-list"])).toBe(false);
    expect(hasFiles([])).toBe(false);
  });
});

describe("nextDragDepth", () => {
  it("子の要素へ入って出ても、まだ重ねている", () => {
    const kinds: readonly DragEventKind[] = ["enter", "enter", "leave"];
    expect(kinds.reduce(nextDragDepth, 0)).toBe(1);
  });

  it("入った数だけ出るか、ドロップすると重ねていない", () => {
    expect((["enter", "enter", "leave", "leave"] as const).reduce(nextDragDepth, 0)).toBe(0);
    expect((["enter", "enter", "drop"] as const).reduce(nextDragDepth, 0)).toBe(0);
  });

  it("どの順の出来事でも、数は負にならない", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<DragEventKind>("enter", "leave", "drop")), (kinds) => {
        expect(kinds.reduce(nextDragDepth, 0)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
