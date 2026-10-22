import { describe, expect, it } from "vite-plus/test";

import { SsmSecretStore } from "../../packages/adapters-aws/src/index.ts";
import { BindingSecretStore } from "../../packages/adapters-cloudflare/src/index.ts";

class FakeSsmClient {
  command: unknown;

  async send(command: unknown): Promise<unknown> {
    this.command = command;
    return { Parameter: { Value: "aws-secret" } };
  }
}

describe("secret store adapters", () => {
  it("reads Cloudflare secret bindings through the shared port behavior", async () => {
    const store = new BindingSecretStore({ TOKEN: "cloudflare-secret", EMPTY: "" });

    await expect(store.get("TOKEN")).resolves.toBe("cloudflare-secret");
    await expect(store.get("EMPTY")).resolves.toBeNull();
    await expect(store.get("MISSING")).resolves.toBeNull();
  });

  it("decrypts only SSM parameters below the configured prefix", async () => {
    const client = new FakeSsmClient();
    const store = new SsmSecretStore(client, "/personal-os/");

    await expect(store.get("/personal-os/openai-api-key")).resolves.toBe("aws-secret");
    expect(client.command).toMatchObject({
      input: { Name: "/personal-os/openai-api-key", WithDecryption: true },
    });
    await expect(store.get("/shared/openai-api-key")).rejects.toThrow(
      "SSM parameter must be under /personal-os/.",
    );
  });
});
