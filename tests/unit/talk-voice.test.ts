import { describe, expect, it } from "vite-plus/test";

import { workersAiVoice } from "../../apps/worker/src/index.ts";

const memory = [
  "他責思考にしたくないんだよね。ちゃんと全部自分で責任持って行動したい",
  "イケメンで引き締まった体になりたいなあ",
];

describe("workers AI talk voice", () => {
  it("keeps a reply that speaks from memory instead of reciting it", async () => {
    const calls: string[] = [];
    const voice = workersAiVoice({
      async run(_model, input) {
        calls.push(input.messages[0]?.content ?? "");
        return { response: "こんにちは。自分で責任を持って動きたいんだね。" };
      },
    });

    await expect(
      voice.reply({ message: "こんにちわ〜", memory, history: [] }),
    ).resolves.toBe("こんにちは。自分で責任を持って動きたいんだね。");
    expect(calls).toHaveLength(1);
  });

  it("asks again when the first reply is the memory text", async () => {
    const systems: string[] = [];
    const voice = workersAiVoice({
      async run(_model, input) {
        const system = input.messages[0]?.content ?? "";
        systems.push(system);
        if (systems.length === 1) return { response: memory.join("\n") };
        return { result: { response: "自分で責任を持って動いて、体も引き締めたいんだね。" } };
      },
    });

    await expect(voice.reply({ message: "僕の目標は？", memory, history: [] })).resolves.toBe(
      "自分で責任を持って動いて、体も引き締めたいんだね。",
    );
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain("原文は出さず");
  });

  it("retries after the model call fails", async () => {
    let calls = 0;
    const voice = workersAiVoice({
      run() {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("model down"));
        return Promise.resolve({ response: "うん、こんにちは。" });
      },
    });

    await expect(voice.reply({ message: "こんにちわ〜", memory: [], history: [] })).resolves.toBe(
      "うん、こんにちは。",
    );
    expect(calls).toBe(2);
  });
});
