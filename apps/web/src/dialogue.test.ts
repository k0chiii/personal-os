import { expect, it } from "vite-plus/test";

import type { SearchResults } from "./api.ts";
import {
  emptyTranscript,
  fail,
  historyOf,
  retry,
  say,
  send,
  settle,
  visible,
  type Transcript,
} from "./dialogue.ts";

const EMPTY_HIT = "記憶には見つかりませんでした。";

function results(
  objects: readonly string[],
  decisions: readonly { problem: string; rationale: string }[],
): SearchResults {
  return {
    assertions: objects.map((object, index) => ({
      id: `assertion-${index}`,
      kind: "preference",
      object,
      privacy: "P1",
      validFrom: "2026-01-01T00:00:00.000Z",
    })),
    decisions: [...decisions],
  };
}

function accept(transcript: Transcript, text: string, id: string) {
  const handoff = send(transcript, text, () => id);
  expect(handoff.accepted).toBe(true);
  if (!handoff.accepted) throw new Error("send refused");
  return handoff;
}

it("sends a trimmed sentence as the open turn", () => {
  const handoff = accept(emptyTranscript(), "  記憶に聞く  ", "id-1");
  expect(handoff.sending).toEqual({
    phase: "sending",
    id: "id-1",
    owner: { text: "記憶に聞く" },
  });
  expect(handoff.transcript.open).toEqual(handoff.sending);
  expect(handoff.transcript.past).toEqual([]);
  expect(visible(handoff.transcript)).toEqual([handoff.sending]);
});

it("refuses a blank or whitespace sentence", () => {
  const transcript = emptyTranscript();
  for (const text of ["", " ", "\n", "\t  "]) {
    const handoff = send(transcript, text, () => "id-1");
    expect(handoff.accepted).toBe(false);
    expect(handoff.transcript).toBe(transcript);
  }
  expect(visible(transcript)).toEqual([]);
});

it("refuses a second send while the first is still sending", () => {
  const first = accept(emptyTranscript(), "最初", "id-1");
  const second = send(first.transcript, "次", () => "id-2");
  expect(second.accepted).toBe(false);
  expect(second.transcript).toBe(first.transcript);
  expect(visible(second.transcript)).toEqual([first.sending]);
});

it("settles assertion object, then problem, then rationale", () => {
  const handoff = accept(emptyTranscript(), "朝の飲み物", "id-1");
  const settled = settle(
    handoff.transcript,
    handoff.sending.id,
    results(["紅茶", "朝"], [{ problem: "どれを淹れるか", rationale: "熱い方がよい" }]),
  );
  expect(settled.open).toEqual({ phase: "idle" });
  expect(visible(settled)).toEqual([
    {
      phase: "reply",
      id: "id-1",
      owner: { text: "朝の飲み物" },
      system: { paragraphs: ["紅茶", "朝", "どれを淹れるか", "熱い方がよい"] },
    },
  ]);
});

it("drops blank search fields and keeps the rest in order", () => {
  const handoff = accept(emptyTranscript(), "朝の飲み物", "id-1");
  const settled = settle(
    handoff.transcript,
    handoff.sending.id,
    results(
      ["   ", "  紅茶  "],
      [
        { problem: " ", rationale: "朝は熱い" },
        { problem: "量は少ない", rationale: "  " },
      ],
    ),
  );
  expect(visible(settled)).toEqual([
    {
      phase: "reply",
      id: "id-1",
      owner: { text: "朝の飲み物" },
      system: { paragraphs: ["紅茶", "朝は熱い", "量は少ない"] },
    },
  ]);
});

it("says nothing was found when settle has no readable fields", () => {
  const handoff = accept(emptyTranscript(), "ない", "id-1");
  const settled = settle(
    handoff.transcript,
    handoff.sending.id,
    results(["  ", ""], [{ problem: " ", rationale: "\n" }]),
  );
  const bare = settle(handoff.transcript, handoff.sending.id, results([], []));
  const reply = {
    phase: "reply" as const,
    id: "id-1",
    owner: { text: "ない" },
    system: { paragraphs: [EMPTY_HIT] },
  };
  expect(visible(settled)).toEqual([reply]);
  expect(visible(bare)).toEqual([reply]);
});

it("keeps the failed sentence open and leaves the past alone", () => {
  const handoff = accept(emptyTranscript(), "最初", "id-1");
  const failed = fail(handoff.transcript, handoff.sending.id, { message: "Request failed (500)" });
  expect(failed.past).toEqual([]);
  expect(visible(failed)).toEqual([
    {
      phase: "failed",
      id: "id-1",
      owner: { text: "最初" },
      failure: { message: "Request failed (500)" },
    },
  ]);
});

it("retries the open failure with the same id", () => {
  const handoff = accept(emptyTranscript(), "最初", "id-1");
  const refused = retry(handoff.transcript);
  expect(refused.accepted).toBe(false);
  expect(refused.transcript).toBe(handoff.transcript);
  const failed = fail(handoff.transcript, handoff.sending.id, { message: "down" });
  const again = retry(failed);
  expect(again.accepted).toBe(true);
  if (!again.accepted) throw new Error("retry refused");
  expect(again.sending.id).toBe(handoff.sending.id);
  expect(again.sending.owner).toEqual({ text: "最初" });
  expect(again.transcript.past).toEqual([]);
  expect(visible(again.transcript)).toEqual([again.sending]);
});

it("moves a failed turn into the past when a new sentence is sent", () => {
  const first = accept(emptyTranscript(), "最初", "id-1");
  const failed = fail(first.transcript, first.sending.id, { message: "timeout" });
  const handoff = send(failed, "次", () => "id-2");
  expect(handoff.accepted).toBe(true);
  if (!handoff.accepted) throw new Error("send refused");
  const sealed = {
    phase: "failed" as const,
    id: "id-1",
    owner: { text: "最初" },
    failure: { message: "timeout" },
  };
  expect(handoff.transcript.past).toEqual([sealed]);
  expect(handoff.sending).toEqual({
    phase: "sending",
    id: "id-2",
    owner: { text: "次" },
  });
  expect(visible(handoff.transcript)).toEqual([sealed, handoff.sending]);
});

it("speaks one paragraph and keeps a blank reply answerable", () => {
  const handoff = accept(emptyTranscript(), "おはよう", "id-1");
  const spoken = say(handoff.transcript, handoff.sending.id, " おはよう。紅茶にする？ ");
  expect(visible(spoken)).toEqual([
    {
      phase: "reply",
      id: "id-1",
      owner: { text: "おはよう" },
      system: { paragraphs: ["おはよう。紅茶にする？"] },
    },
  ]);
  expect(historyOf(spoken)).toEqual([
    { role: "owner", text: "おはよう" },
    { role: "system", text: "おはよう。紅茶にする？" },
  ]);
  expect(historyOf(handoff.transcript)).toEqual([]);
  const blank = say(handoff.transcript, handoff.sending.id, "  ");
  expect(visible(blank)).toEqual([
    {
      phase: "reply",
      id: "id-1",
      owner: { text: "おはよう" },
      system: { paragraphs: ["記憶にはまだない話だね。続きを聞かせて。"] },
    },
  ]);
});

it("ignores a settle or fail once the open turn is no longer that send", () => {
  const current = accept(emptyTranscript(), "今", "id-now");
  const other = accept(emptyTranscript(), "別", "id-other");
  const hits = results(["hit"], []);
  expect(settle(current.transcript, other.sending.id, hits)).toBe(current.transcript);
  expect(say(current.transcript, other.sending.id, "遅い")).toBe(current.transcript);
  expect(fail(current.transcript, other.sending.id, { message: "late" })).toBe(current.transcript);

  const settled = settle(current.transcript, current.sending.id, hits);
  expect(settle(settled, current.sending.id, results(["other"], []))).toBe(settled);
  expect(fail(settled, current.sending.id, { message: "late" })).toBe(settled);

  const failed = fail(current.transcript, current.sending.id, { message: "down" });
  expect(settle(failed, current.sending.id, hits)).toBe(failed);
  expect(fail(failed, current.sending.id, { message: "again" })).toBe(failed);
});
