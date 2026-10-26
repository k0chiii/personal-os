import { describe, expect, it } from "vite-plus/test";

import { idAfterRemoval, inboxCommand, inboxFocus, movedId } from "./inbox.ts";

const plain = { altKey: false, ctrlKey: false, metaKey: false };

describe("inboxCommand", () => {
  it("maps review and navigation keys regardless of case", () => {
    expect(inboxCommand({ ...plain, key: "a" })).toEqual({ type: "compose", action: "approve" });
    expect(inboxCommand({ ...plain, key: "R" })).toEqual({ type: "compose", action: "reject" });
    expect(inboxCommand({ ...plain, key: "j" })).toEqual({ type: "move", delta: 1 });
    expect(inboxCommand({ ...plain, key: "ArrowUp" })).toEqual({ type: "move", delta: -1 });
  });

  it("leaves browser shortcuts such as Ctrl+R and Cmd+A alone", () => {
    expect(inboxCommand({ ...plain, key: "r", ctrlKey: true })).toBeNull();
    expect(inboxCommand({ ...plain, key: "a", metaKey: true })).toBeNull();
    expect(inboxCommand({ ...plain, key: "j", altKey: true })).toBeNull();
  });

  it("ignores unmapped keys", () => {
    expect(inboxCommand({ ...plain, key: "Enter" })).toBeNull();
    expect(inboxCommand({ ...plain, key: "x" })).toBeNull();
  });
});

describe("movedId", () => {
  const ids = ["p1", "p2", "p3"];

  it("enters the list at the matching end when nothing is focused", () => {
    expect(movedId(ids, null, 1)).toBe("p1");
    expect(movedId(ids, null, -1)).toBe("p3");
  });

  it("steps and clamps at both ends", () => {
    expect(movedId(ids, "p2", 1)).toBe("p3");
    expect(movedId(ids, "p3", 1)).toBe("p3");
    expect(movedId(ids, "p1", -1)).toBe("p1");
  });

  it("returns null for an empty inbox", () => {
    expect(movedId([], null, 1)).toBeNull();
  });
});

describe("inboxFocus", () => {
  it("closes the reason form on Escape even while that field is focused", () => {
    expect(inboxFocus({ key: "Escape", inReasonForm: true, typing: true })).toBe("dismiss");
  });

  it("does not dismiss Escape outside the reason form", () => {
    expect(inboxFocus({ key: "Escape", inReasonForm: false, typing: false })).toBe("pass");
  });

  it("drops review keys while a field is focused", () => {
    expect(inboxFocus({ key: "j", inReasonForm: false, typing: true })).toBe("ignore");
    expect(inboxFocus({ key: "a", inReasonForm: true, typing: true })).toBe("ignore");
  });

  it("lets review keys through when focus is on the page", () => {
    expect(inboxFocus({ key: "j", inReasonForm: false, typing: false })).toBe("pass");
  });
});

describe("idAfterRemoval", () => {
  it("prefers the next card, then the previous one", () => {
    expect(idAfterRemoval(["p1", "p2", "p3"], "p2")).toBe("p3");
    expect(idAfterRemoval(["p1", "p2", "p3"], "p3")).toBe("p2");
  });

  it("returns null when the last card leaves", () => {
    expect(idAfterRemoval(["p1"], "p1")).toBeNull();
  });
});
