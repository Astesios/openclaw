import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("celia-canvas clean-cut contract", () => {
  it("exposes push_card without the retired live notification tool", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(manifest.contracts?.tools).toEqual(["push_card"]);
    expect(source).not.toContain("notify_live");
    expect(source).not.toContain("canvas.live.start");
    expect(source).not.toContain("canvas.live.done");
  });
});
