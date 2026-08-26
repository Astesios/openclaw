import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { normalizeOwnerAgentId } from "./index.js";
import { RunBindingStore, type RunBinding } from "./src/bindings.js";
import {
  FlowosExecutionClient,
  resolveTrustedAssistEndpoint,
  type AssistRequest,
} from "./src/client.js";
import { FlowosExecutionRuntime } from "./src/runtime.js";
import { createFlowosExecutionTools } from "./src/tools.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    async register(key, value) {
      values.set(key, { value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        values.delete(key);
      } else {
        values.set(key, { value: next, createdAt: Date.now() });
      }
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, entry]) => Object.assign({ key }, entry));
    },
    async clear() {
      values.clear();
    },
  };
}

function fakeClient() {
  const calls: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  let item = {
    executionId: "execution-1",
    currentAttemptId: "attempt-1",
    ownerAgentId: "agent:main",
    status: "PLANNING",
    version: 1,
    stageKey: "planning",
  };
  const request: AssistRequest = vi.fn(async (method, path, payload) => {
    calls.push({ method, path, payload });
    if (method === "GET") {
      return item;
    }
    if (path.endsWith("/stage")) {
      item = {
        ...item,
        status: "RUNNING",
        version: item.version + 1,
        stageKey: String(payload?.stageKey),
      };
    } else if (path.endsWith("/complete")) {
      item = { ...item, status: "SUCCEEDED", version: item.version + 1, stageKey: "completed" };
    } else if (path.endsWith("/fail")) {
      item = { ...item, status: "FAILED", version: item.version + 1, stageKey: "failed" };
    }
    return item;
  });
  return { client: new FlowosExecutionClient(request), calls, getItem: () => item };
}

function fakeSubagent() {
  return {
    run: vi.fn<PluginRuntime["subagent"]["run"]>(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn<PluginRuntime["subagent"]["waitForRun"]>(async () => ({
      status: "timeout",
    })),
    getSessionMessages: vi.fn<PluginRuntime["subagent"]["getSessionMessages"]>(async () => ({
      messages: [],
    })),
    getSession: vi.fn<PluginRuntime["subagent"]["getSession"]>(async () => ({ messages: [] })),
    deleteSession: vi.fn<PluginRuntime["subagent"]["deleteSession"]>(async () => undefined),
  };
}

function tools(params?: {
  context?: { agentId?: string; sessionKey?: string };
  client?: FlowosExecutionClient;
  bindings?: RunBindingStore;
  subagent?: ReturnType<typeof fakeSubagent>;
}) {
  const assist = params?.client ? { client: params.client } : fakeClient();
  const bindings = params?.bindings ?? new RunBindingStore(memoryStore());
  const subagent = params?.subagent ?? fakeSubagent();
  const created = createFlowosExecutionTools({
    api: { runtime: { subagent } } as never,
    context: params?.context ?? { agentId: "main", sessionKey: "agent:main:main" },
    client: assist.client,
    bindings,
    ownerAgentId: "agent:main",
  });
  return {
    byName: new Map(created.map((tool) => [tool.name, tool])),
    bindings,
    subagent,
  };
}

async function startExecution(byName: Map<string, AnyAgentTool>) {
  await byName.get("flowos_execution_start")?.execute("start", {
    source: "USER",
    taskKind: "lushu",
    title: "生成路书",
    idempotencyKey: "request-1",
  });
}

describe("FlowOS Execution plugin boundaries", () => {
  it("allows only native loopback and Compose Assist origins", () => {
    expect(resolveTrustedAssistEndpoint(undefined)?.origin).toBe("http://127.0.0.1:18790");
    expect(resolveTrustedAssistEndpoint("http://assist:18790")?.origin).toBe("http://assist:18790");
    for (const value of [
      "https://assist:18790",
      "http://attacker:18790",
      "http://127.0.0.1:8080",
      "http://user:password@assist:18790",
      "http://assist:18790/path",
      "http://assist:18790/?target=evil",
    ]) {
      expect(resolveTrustedAssistEndpoint(value)).toBeNull();
    }
  });

  it("normalizes only explicit safe owner agent ids", () => {
    expect(normalizeOwnerAgentId("agent:main")).toBe("agent:main");
    expect(normalizeOwnerAgentId("main")).toBeNull();
    expect(normalizeOwnerAgentId("agent:../main")).toBeNull();
  });

  it("registers no tools when private runtime config is missing", () => {
    delete process.env.LONG_TASK_EXECUTION_TOKEN;
    delete process.env.LONG_TASK_EXECUTION_AGENT_ID;
    const registerTool = vi.fn();
    plugin.register({
      runtime: { state: { openKeyedStore: () => memoryStore() }, subagent: fakeSubagent() },
      registerTool,
      on: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
    } as never);
    const factory = registerTool.mock.calls[0]?.[0] as (context: unknown) => unknown;
    expect(factory({ agentId: "main", sessionKey: "agent:main:main" })).toBeNull();
  });

  it("tool schemas never expose owner identity endpoint or credential arguments", () => {
    const { byName } = tools();
    expect([...byName.keys()]).toEqual([
      "flowos_execution_start",
      "flowos_execution_stage",
      "flowos_execution_spawn",
      "flowos_execution_complete",
      "flowos_execution_fail",
    ]);
    for (const tool of byName.values()) {
      const schema = JSON.stringify(tool.parameters);
      expect(schema).not.toContain("token");
      expect(schema).not.toContain("ownerAgentId");
      expect(schema).not.toContain("assistBaseUrl");
      expect(schema).not.toContain("userId");
      expect(schema).not.toContain("tenantId");
    }
  });

  it("start derives owner and requester then replays without cross-session adoption", async () => {
    const store = new RunBindingStore(memoryStore());
    const owner = tools({ bindings: store });
    await startExecution(owner.byName);
    const binding = await store.byExecution("execution-1", "attempt-1");
    expect(binding).toMatchObject({
      ownerAgentId: "agent:main",
      requesterSessionKey: "agent:main:main",
      status: "CREATED",
    });

    const other = tools({
      bindings: store,
      context: { agentId: "main", sessionKey: "agent:main:other" },
    });
    await expect(startExecution(other.byName)).rejects.toThrow("another owner session");
  });

  it("child can only stage its own running Execution Attempt", async () => {
    const assist = fakeClient();
    const store = new RunBindingStore(memoryStore());
    const binding: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:flowos-requester",
      ownerAgentId: "agent:main",
      targetAgentId: "main",
      childSessionKey: "agent:main:subagent:flowos-1",
      runId: "run-1",
      status: "RUNNING",
      createdAt: 1,
      updatedAt: 1,
    };
    await store.save(binding);
    const child = tools({
      bindings: store,
      client: assist.client,
      context: { agentId: "main", sessionKey: binding.childSessionKey },
    });
    await child.byName.get("flowos_execution_stage")?.execute("stage", {
      executionId: "execution-1",
      expectedVersion: 1,
      stageKey: "generating",
      stageLabel: "正在生成",
    });
    expect(assist.getItem()).toMatchObject({ status: "RUNNING", version: 2 });
    await expect(
      child.byName.get("flowos_execution_stage")?.execute("cross", {
        executionId: "execution-other",
        expectedVersion: 2,
        stageKey: "bad",
        stageLabel: "bad",
      }),
    ).rejects.toThrow("does not match");
    await expect(
      child.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        resultType: "RESOURCE",
        resultId: "resource-1",
      }),
    ).rejects.toThrow("owner tool is unavailable");
  });

  it("spawn is stable and writes pending binding before the plugin subagent run", async () => {
    const store = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    subagent.run.mockImplementation(async (params) => {
      const pending = await store.byChild(params.sessionKey);
      expect(pending?.status).toBe("STARTING");
      return { runId: "run-1" };
    });
    const owner = tools({ bindings: store, subagent });
    await startExecution(owner.byName);
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    });
    const running = await store.byExecution("execution-1", "attempt-1");
    expect(running).toMatchObject({ runId: "run-1", status: "RUNNING" });
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: false,
        message: expect.stringContaining("expectedVersion=1"),
      }),
    );
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn-replay", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    });
    expect(subagent.run).toHaveBeenCalledOnce();
  });

  it("re-resolves the writer version before mutation and rejects future versions", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startExecution(owner.byName);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "runtime-stage",
      stageLabel: "运行时已推进",
    });
    await owner.byName.get("flowos_execution_stage")?.execute("stage", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      expectedVersion: 1,
      stageKey: "validated",
      stageLabel: "已按最新版本推进",
    });
    expect(assist.getItem()).toMatchObject({ version: 3, stageKey: "validated" });
    const lastStage = assist.calls.findLast((call) => call.path.endsWith("/stage"));
    expect(lastStage?.payload?.expectedVersion).toBe(2);

    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("future", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 99,
        stageKey: "future",
        stageLabel: "错误未来版本",
      }),
    ).rejects.toThrow("newer than the current");
  });

  it("complete registers RESOURCE before atomically completing the owner Execution", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startExecution(owner.byName);
    await owner.byName.get("flowos_execution_complete")?.execute("complete", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      expectedVersion: 1,
      resultType: "RESOURCE",
      resultId: "resource-1",
    });
    const paths = assist.calls.map((call) => call.path);
    expect(paths.indexOf("/api/executions/execution-1/resources")).toBeLessThan(
      paths.indexOf("/api/executions/execution-1/complete"),
    );
  });
});

describe("FlowOS Execution typed hooks", () => {
  function runtime() {
    const assist = fakeClient();
    const bindings = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    const logger = { warn: vi.fn(), info: vi.fn() };
    return {
      assist,
      bindings,
      subagent,
      instance: new FlowosExecutionRuntime(assist.client, bindings, subagent as never, logger),
    };
  }

  async function pending(bindings: RunBindingStore): Promise<RunBinding> {
    const value: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:main",
      ownerAgentId: "agent:main",
      targetAgentId: "worker",
      childSessionKey: "agent:worker:subagent:flowos-1",
      status: "STARTING",
      createdAt: 1,
      updatedAt: 1,
    };
    await bindings.save(value);
    return value;
  }

  it("subagent_spawned binds only exact child requester agent and run", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.instance.subagentSpawned(
      { runId: "run-1", childSessionKey: value.childSessionKey!, agentId: "worker" },
      { childSessionKey: value.childSessionKey, requesterSessionKey: value.requesterSessionKey },
    );
    expect(await ctx.bindings.byRun("run-1")).toMatchObject({ status: "RUNNING" });
    await ctx.instance.subagentSpawned(
      { runId: "run-evil", childSessionKey: value.childSessionKey!, agentId: "worker" },
      { childSessionKey: value.childSessionKey, requesterSessionKey: "agent:other:main" },
    );
    expect(await ctx.bindings.byRun("run-evil")).toBeUndefined();
  });

  it("ok end moves to validating but never completes and replay is harmless", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    const event = {
      targetSessionKey: value.childSessionKey!,
      targetKind: "subagent" as const,
      runId: "run-1",
      outcome: "ok" as const,
    };
    const hookContext = {
      childSessionKey: value.childSessionKey,
      requesterSessionKey: "agent:main:main",
    };
    await ctx.instance.subagentEnded(event, hookContext);
    await ctx.instance.subagentEnded(event, hookContext);
    expect(ctx.assist.getItem()).toMatchObject({ status: "RUNNING", stageKey: "validating" });
    expect(ctx.assist.calls.filter((call) => call.path.endsWith("/stage"))).toHaveLength(1);
    expect(ctx.assist.calls.some((call) => call.path.endsWith("/complete"))).toBe(false);
  });

  it("timeout end maps to a retryable provider timeout failure", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    await ctx.instance.subagentEnded(
      {
        targetSessionKey: value.childSessionKey!,
        targetKind: "subagent",
        runId: "run-1",
        outcome: "timeout",
      },
      { childSessionKey: value.childSessionKey, requesterSessionKey: value.requesterSessionKey },
    );
    const failure = ctx.assist.calls.find((call) => call.path.endsWith("/fail"));
    expect(failure?.payload).toMatchObject({ errorCode: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("gateway reconciliation closes a completed persisted run exactly once", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    ctx.subagent.waitForRun.mockResolvedValue({ status: "ok" });
    await ctx.instance.reconcile();
    await ctx.instance.reconcile();
    expect(ctx.assist.calls.filter((call) => call.path.endsWith("/stage"))).toHaveLength(1);
    expect(await ctx.bindings.byRun("run-1")).toMatchObject({ status: "ENDED_OK" });
  });
});
