export type ReviewAction = "approve" | "reject";

export type InboxCommand =
  | { type: "move"; delta: 1 | -1 }
  | { type: "compose"; action: ReviewAction };

interface KeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

const KEY_COMMANDS: Readonly<Record<string, InboxCommand>> = {
  j: { type: "move", delta: 1 },
  ArrowDown: { type: "move", delta: 1 },
  k: { type: "move", delta: -1 },
  ArrowUp: { type: "move", delta: -1 },
  a: { type: "compose", action: "approve" },
  r: { type: "compose", action: "reject" },
};

export function inboxCommand(input: KeyInput): InboxCommand | null {
  if (input.altKey || input.ctrlKey || input.metaKey) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  return KEY_COMMANDS[key] ?? null;
}

export type InboxFocus = "dismiss" | "ignore" | "pass";

export function inboxFocus(input: {
  key: string;
  inReasonForm: boolean;
  typing: boolean;
}): InboxFocus {
  if (input.key === "Escape" && input.inReasonForm) return "dismiss";
  if (input.typing) return "ignore";
  return "pass";
}

export function movedId(
  ids: readonly string[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const index = currentId === null ? -1 : ids.indexOf(currentId);
  if (index === -1) return delta === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(Math.max(index + delta, 0), ids.length - 1)]!;
}

export function idAfterRemoval(ids: readonly string[], removedId: string): string | null {
  const index = ids.indexOf(removedId);
  if (index === -1) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
