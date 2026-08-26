import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  buildPromptContext,
  canonicalSessionKey,
  clearRuntimeSecretForTest,
  consumeRuntimeToken,
  resolveTrustedAssistEndpoint,
  SurfaceContextRuntime,
} from "./index.js";
import {
  SurfaceContextClient,
  SurfaceContextClientError,
  type SurfaceContextBinding,
} from "./src/client.js";
import { createSurfaceContextTools } from "./src/runtime.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  clearRuntimeSecretForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tokenFile(token = "r".repeat(48), mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowos-surface-context-"));
  tempDirs.push(dir);
  const file = path.join(dir, "runtime-token");
  fs.writeFileSync(file, token, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function binding(overrides: Partial<SurfaceContextBinding> = {}): SurfaceContextBinding {
  return {
    bindingId: "ctxbind_0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    context: {
      schemaVersion: 1,
      objectType: "SPACE",
      providerId: "com.flowos.floai",
      spaceId: "sp_trip",
      artifactId: null,
      focusedId: null,
      title: "关西旅行",
      summary: "旅行、黄金样例",
      stableRef: "space:sp_trip",
      revision: "7",
    },
    ...overrides,
  };
}

function pairedOperator() {
  return {
    isDeviceTokenAuth: true,
    connect: { role: "operator", device: { id: "android-device" } },
  } as never;
}

function setupPlugin() {
  const registerGatewayMethod = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  plugin.register({
    config: { session: { mainKey: "main" }, agents: { list: [{ id: "main", default: true }] } },
    registerGatewayMethod,
    registerTool,
    on,
    logger: { warn: vi.fn(), info: vi.fn() },
  } as never);
  return { registerGatewayMethod, registerTool, on };
}

describe("Surface Context private runtime config", () => {
  it("accepts only the bounded local Assist topology", () => {
    expect(resolveTrustedAssistEndpoint(undefined)?.origin).toBe("http://127.0.0.1:18790");
    expect(resolveTrustedAssistEndpoint("http://assist:18790")?.origin).toBe("http://assist:18790");
    for (const value of [
      "https://assist:18790",
      "http://attacker:18790",
      "http://127.0.0.1:8080",
      "http://user:password@assist:18790",
      "http://assist:18790/redirect",
      "http://assist:18790/?target=evil",
    ]) {
      expect(resolveTrustedAssistEndpoint(value)).toBeNull();
    }
  });

  it("consumes a private one-shot token file and rejects env retention", () => {
    const file = tokenFile();
    const env = { FLOWOS_SURFACE_CONTEXT_RUNTIME_TOKEN_FILE: file };
    expect(consumeRuntimeToken(env)).toBe("r".repeat(48));
    expect(fs.existsSync(file)).toBe(false);
    clearRuntimeSecretForTest();
    expect(
      consumeRuntimeToken({
        SURFACE_CONTEXT_RUNTIME_TOKEN: "r".repeat(48),
        FLOWOS_SURFACE_CONTEXT_RUNTIME_TOKEN_FILE: tokenFile(),
      }),
    ).toBeNull();
  });
});

describe("Surface Context Assist client", () => {
  it("posts the ContextRef in the body, never the URL, and parses only the minimal contract", async () => {
    let requestUrl = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      expect(request.headers.authorization).toBe("Bearer runtime-token");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
          contextRef: "context-ref-secret",
          sessionKey: "main",
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(binding()));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SurfaceContextClient(new URL(`http://127.0.0.1:${port}`), "runtime-token");
      await expect(client.consume("context-ref-secret", "main")).resolves.toMatchObject({
        context: { spaceId: "sp_trip", title: "关西旅行" },
      });
      expect(requestUrl).toBe("/api/surface-context/refs:consume");
      expect(requestUrl).not.toContain("context-ref-secret");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("rejects redirects and unexpected response fields", async () => {
    let responseBody: Record<string, unknown> | undefined;
    const server = createServer((_request, response) => {
      if (responseBody) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseBody));
      } else {
        response.writeHead(302, { location: "http://attacker.invalid/collect" });
        response.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const client = new SurfaceContextClient(new URL(`http://127.0.0.1:${port}`), "runtime-token");
    try {
      await expect(client.consume("ref", "main")).rejects.toMatchObject({
        code: "CONTEXT_ASSIST_REJECTED",
      });
      responseBody = { ...binding(), filePath: "/private/space" };
      await expect(client.consume("ref", "main")).rejects.toBeInstanceOf(SurfaceContextClientError);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});

describe("session-bound runtime", () => {
  it("canonicalizes Android aliases without changing the ContextRef consume binding", async () => {
    const consume = vi.fn(async () => binding());
    const runtime = new SurfaceContextRuntime({ consume } as unknown as SurfaceContextClient, {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    });
    await runtime.bind("main", "secret-ref");
    expect(consume).toHaveBeenCalledWith("secret-ref", "main");
    expect(runtime.active("agent:main:main")?.context.spaceId).toBe("sp_trip");
    expect(runtime.active("agent:main:other")).toBeUndefined();
    expect(runtime.clear("main")).toBe(true);
    expect(runtime.active("agent:main:main")).toBeUndefined();
  });

  it("does not let an older async bind overwrite a newer clear", async () => {
    let finish: ((value: SurfaceContextBinding) => void) | undefined;
    const consume = vi.fn(
      async () =>
        await new Promise<SurfaceContextBinding>((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new SurfaceContextRuntime({ consume } as unknown as SurfaceContextClient, {
      agents: { list: [{ id: "main", default: true }] },
    });
    const pending = runtime.bind("main", "ref");
    runtime.clear("main");
    finish?.(binding());
    await expect(pending).rejects.toThrow("CONTEXT_STALE_BIND");
    expect(runtime.active("main")).toBeUndefined();
  });

  it("expires bindings and exposes tools with no ref or identity arguments", async () => {
    let now = Date.now();
    const consume = vi.fn(async () => binding({ expiresAt: new Date(now + 1_000).toISOString() }));
    const runtime = new SurfaceContextRuntime(
      { consume } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
      () => now,
    );
    await runtime.bind("main", "ref");
    const tools = createSurfaceContextTools(runtime, { sessionKey: "agent:main:main" } as never);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ additionalProperties: false, properties: {} });
    }
    const resolved = await tools[1]?.execute("call-1", {});
    expect(JSON.stringify(resolved)).toContain("sp_trip");
    now += 1_001;
    const status = await tools[0]?.execute("call-2", {});
    expect(JSON.stringify(status)).toContain("CONTEXT_UNAVAILABLE");
  });

  it("injects availability only, never pointer data or a ContextRef", async () => {
    const runtime = new SurfaceContextRuntime(
      { consume: vi.fn(async () => binding()) } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
    );
    await runtime.bind("main", "super-secret-ref");
    const prompt = buildPromptContext(runtime, "agent:main:main") ?? "";
    expect(prompt).toContain("surface_context_resolve");
    for (const forbidden of ["super-secret-ref", "sp_trip", "关西旅行", "旅行、黄金样例"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });
});

describe("plugin registration", () => {
  it("registers paired-operator bind/clear, session tools and a prompt hook", async () => {
    delete process.env.FLOWOS_SURFACE_CONTEXT_RUNTIME_TOKEN_FILE;
    const { registerGatewayMethod, registerTool, on } = setupPlugin();
    expect(registerGatewayMethod.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["flowos.surfaceContext.bind", { scope: "operator.write" }],
      ["flowos.surfaceContext.clear", { scope: "operator.write" }],
    ]);
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      names: ["surface_context_status", "surface_context_resolve"],
    });
    expect(on.mock.calls.some((call) => call[0] === "before_prompt_build")).toBe(true);
    const bindHandler = registerGatewayMethod.mock.calls[0]?.[1];
    const respond = vi.fn();
    await bindHandler({ params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("canonical session keys", () => {
  it("maps main and bare app keys to the same keys used by prompt/tool contexts", () => {
    const config = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    };
    expect(canonicalSessionKey(config, "main")).toBe("agent:main:main");
    expect(canonicalSessionKey(config, "session_123")).toBe("agent:main:session_123");
    expect(canonicalSessionKey(config, "agent:main:session_123")).toBe("agent:main:session_123");
  });
});
