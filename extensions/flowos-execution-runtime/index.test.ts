import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  clearRuntimeSecretForTest,
  consumeRuntimeToken,
  normalizeOwnerAgentId,
} from "./index.js";
import { RunBindingStore, type RunBinding } from "./src/bindings.js";
import {
  type ActiveExecution,
  FlowosExecutionClient,
  resolveTrustedAssistEndpoint,
  type AssistRequest,
} from "./src/client.js";
import { ExecutionLocks } from "./src/locks.js";
import { FlowosExecutionRuntime } from "./src/runtime.js";
import { createFlowosExecutionTools } from "./src/tools.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  clearRuntimeSecretForTest();
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

function fakeClient(options?: {
  beforeRequest?: (
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ) => Promise<void> | void;
}) {
  const calls: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  let item: ActiveExecution = {
    executionId: "execution-1",
    currentAttemptId: "attempt-1",
    ownerAgentId: "agent:main",
    status: "PLANNING",
    version: 1,
    stageKey: "planning",
  };
  const request: AssistRequest = vi.fn(async (method, path, payload) => {
    await options?.beforeRequest?.(method, path, payload);
    calls.push({ method, path, payload });
    if (method === "GET") {
      return item;
    }
    if (path === "/api/executions") {
      item = {
        ...item,
        spaceId: typeof payload?.spaceId === "string" ? payload.spaceId : null,
        taskId: typeof payload?.taskId === "string" ? payload.taskId : null,
      };
      return item;
    }
    if (path.endsWith("/space-artifacts")) {
      return {
        type: "SPACE_ARTIFACT",
        id: "art-flowos-1",
        spaceId: item.spaceId ?? "",
      };
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
    run: vi.fn<PluginRuntime["subagent"]["run"]>(async (params) => ({
      runId: params.idempotencyKey ?? "run-1",
    })),
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

function fakeSystem() {
  return {
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeat: vi.fn(),
  };
}

function tools(params?: {
  context?: { agentId?: string; sessionKey?: string };
  client?: FlowosExecutionClient;
  bindings?: RunBindingStore;
  subagent?: ReturnType<typeof fakeSubagent>;
  system?: ReturnType<typeof fakeSystem>;
  locks?: ExecutionLocks;
  runtime?: FlowosExecutionRuntime;
}) {
  const assist = params?.client ? { client: params.client } : fakeClient();
  const bindings = params?.bindings ?? new RunBindingStore(memoryStore());
  const subagent = params?.subagent ?? fakeSubagent();
  const system = params?.system ?? fakeSystem();
  const locks = params?.locks ?? new ExecutionLocks();
  const runtime =
    params?.runtime ??
    new FlowosExecutionRuntime(
      assist.client,
      bindings,
      subagent as never,
      system as never,
      { warn: vi.fn(), info: vi.fn() },
      locks,
    );
  const created = createFlowosExecutionTools({
    api: { runtime: { subagent } } as never,
    context: params?.context ?? { agentId: "main", sessionKey: "agent:main:main" },
    client: assist.client,
    bindings,
    locks,
    runtime,
    ownerAgentId: "agent:main",
  });
  return {
    byName: new Map(created.map((tool) => [tool.name, tool])),
    bindings,
    subagent,
    system,
    locks,
    runtime,
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

async function startSpaceExecution(byName: Map<string, AnyAgentTool>) {
  await byName.get("flowos_execution_start")?.execute("start", {
    source: "SPACE_TASK",
    taskKind: "lushu",
    title: "生成路书",
    idempotencyKey: "request-space-1",
    spaceId: "sp-trip",
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

  it("consumes a mode-600 one-shot token file and rejects process-env secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowos-execution-secret-"));
    const tokenFile = join(directory, "writer.token");
    try {
      writeFileSync(tokenFile, "t".repeat(64), { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      expect(consumeRuntimeToken({ LONG_TASK_EXECUTION_TOKEN_FILE: tokenFile })).toBe(
        "t".repeat(64),
      );
      expect(existsSync(tokenFile)).toBe(false);
      clearRuntimeSecretForTest();
      expect(consumeRuntimeToken({ LONG_TASK_EXECUTION_TOKEN: "x".repeat(64) })).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers no tools when private runtime config is missing", () => {
    delete process.env.LONG_TASK_EXECUTION_TOKEN;
    delete process.env.LONG_TASK_EXECUTION_TOKEN_FILE;
    delete process.env.LONG_TASK_EXECUTION_AGENT_ID;
    const registerTool = vi.fn();
    plugin.register({
      runtime: {
        state: { openKeyedStore: () => memoryStore() },
        subagent: fakeSubagent(),
        system: fakeSystem(),
      },
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

  it("scopes Assist idempotency to the trusted requester session when local state is empty", async () => {
    const assist = fakeClient();
    const first = tools({
      client: assist.client,
      context: { agentId: "main", sessionKey: "agent:main:first" },
    });
    const second = tools({
      client: assist.client,
      context: { agentId: "main", sessionKey: "agent:main:second" },
    });
    await startExecution(first.byName);
    await startExecution(second.byName);
    const keys = assist.calls
      .filter((call) => call.path === "/api/executions")
      .map((call) => call.payload?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("derives Space task identity and trusted AI surface outside the model schema", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startSpaceExecution(owner.byName);
    const create = assist.calls.find((call) => call.path === "/api/executions");
    expect(create?.payload).toMatchObject({
      source: "SPACE_TASK",
      spaceId: "sp-trip",
      surfaceKind: "AI_TASK",
    });
    expect(create?.payload?.taskId).toMatch(/^task-flowos-[a-f0-9]{24}$/);
    const schema = JSON.stringify(owner.byName.get("flowos_execution_start")?.parameters);
    expect(schema).not.toContain("taskId");
    expect(schema).not.toContain("surfaceKind");
  });

  it("persists one canonical active binding without expiring aliases", async () => {
    const state = memoryStore<RunBinding>();
    const bindings = new RunBindingStore(state);
    await bindings.save({
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:main",
      ownerAgentId: "agent:main",
      targetAgentId: "worker",
      childSessionKey: "agent:worker:subagent:flowos-1",
      runId: "run-1",
      status: "RUNNING",
      createdAt: 1,
      updatedAt: 1,
    });
    const entries = await state.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("execution:execution-1:attempt-1");
    expect(entries[0]?.expiresAt).toBeUndefined();
    expect(await bindings.byChild("agent:worker:subagent:flowos-1")).toMatchObject({
      runId: "run-1",
    });
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
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
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
    const schema = JSON.stringify(owner.byName.get("flowos_execution_spawn")?.parameters);
    expect(schema).not.toContain("idempotencyKey");
  });

  it("serializes concurrent spawn calls into one atomic run claim", async () => {
    const store = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    let releaseRun = () => {};
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    subagent.run.mockImplementation(async (params) => {
      markEntered();
      await gate;
      return { runId: params.idempotencyKey! };
    });
    const owner = tools({ bindings: store, subagent });
    await startExecution(owner.byName);
    const input = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    };
    const first = owner.byName.get("flowos_execution_spawn")!.execute("spawn-1", input);
    await entered;
    const second = owner.byName
      .get("flowos_execution_spawn")!
      .execute("spawn-2", { ...input, task: "different model text" });
    releaseRun();
    await Promise.all([first, second]);
    expect(subagent.run).toHaveBeenCalledOnce();
    expect(await store.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "RUNNING",
      targetAgentId: "worker",
    });
  });

  it("rejects completion while a bound child is still active", async () => {
    const owner = tools();
    await startExecution(owner.byName);
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    });
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 1,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
      }),
    ).rejects.toThrow("has not ended successfully");
  });

  it("rejects stale and future writer versions without changing state", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startExecution(owner.byName);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "runtime-stage",
      stageLabel: "运行时已推进",
    });
    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("stale", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 1,
        stageKey: "stale",
        stageLabel: "错误旧阶段",
      }),
    ).rejects.toThrow("does not match");
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "runtime-stage" });

    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("future", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 99,
        stageKey: "future",
        stageLabel: "错误未来版本",
      }),
    ).rejects.toThrow("does not match");
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "runtime-stage" });
  });

  it("complete registers the bound Space Artifact before completing the owner Execution", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startSpaceExecution(owner.byName);
    await owner.byName.get("flowos_execution_complete")?.execute("complete", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      expectedVersion: 1,
      spaceId: "sp-trip",
      artifactTitle: "旅行路书",
      artifactFilePath: "generated/lushu.html",
      artifactType: "html",
    });
    const paths = assist.calls.map((call) => call.path);
    expect(paths.indexOf("/api/executions/execution-1/space-artifacts")).toBeLessThan(
      paths.indexOf("/api/executions/execution-1/complete"),
    );
    const schema = JSON.stringify(owner.byName.get("flowos_execution_complete")?.parameters);
    expect(schema).not.toContain("resultId");
    expect(schema).not.toContain("RESOURCE");
    expect(schema).not.toContain("CASE_DETAIL");
  });
});

describe("FlowOS Execution typed hooks", () => {
  function runtime() {
    const assist = fakeClient();
    const bindings = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    const system = fakeSystem();
    const logger = { warn: vi.fn(), info: vi.fn() };
    return {
      assist,
      bindings,
      subagent,
      system,
      instance: new FlowosExecutionRuntime(
        assist.client,
        bindings,
        subagent as never,
        system as never,
        logger,
        new ExecutionLocks(),
      ),
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
    expect(ctx.system.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(ctx.system.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("version=2"),
      expect.objectContaining({ sessionKey: value.requesterSessionKey }),
    );
    expect(ctx.system.requestHeartbeat).toHaveBeenCalledOnce();
    expect(ctx.system.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "background-task",
        intent: "immediate",
        reason: "background-task",
        sessionKey: value.requesterSessionKey,
      }),
    );
  });

  it("serializes an ended hook ahead of a late child stage", async () => {
    let releaseValidation = () => {};
    let markValidationEntered = () => {};
    const validationEntered = new Promise<void>((resolve) => {
      markValidationEntered = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const assist = fakeClient({
      async beforeRequest(_method, path, payload) {
        if (path.endsWith("/stage") && payload?.stageKey === "validating") {
          markValidationEntered();
          await validationGate;
        }
      },
    });
    const owner = tools({ client: assist.client });
    const binding: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:owner",
      ownerAgentId: "agent:main",
      targetAgentId: "main",
      childSessionKey: "agent:main:subagent:flowos-1",
      runId: "run-1",
      status: "RUNNING",
      createdAt: 1,
      updatedAt: 1,
    };
    await owner.bindings.save(binding);
    const child = tools({
      client: assist.client,
      bindings: owner.bindings,
      subagent: owner.subagent,
      locks: owner.locks,
      runtime: owner.runtime,
      context: { agentId: "main", sessionKey: binding.childSessionKey },
    });
    const ended = owner.runtime.subagentEnded(
      {
        targetSessionKey: binding.childSessionKey!,
        targetKind: "subagent",
        runId: "run-1",
        outcome: "ok",
      },
      { childSessionKey: binding.childSessionKey, requesterSessionKey: "agent:main:main" },
    );
    await validationEntered;
    const lateStage = child.byName.get("flowos_execution_stage")!.execute("late-stage", {
      executionId: "execution-1",
      expectedVersion: 1,
      stageKey: "late",
      stageLabel: "迟到阶段",
    });
    releaseValidation();
    await ended;
    await expect(lateStage).rejects.toThrow("capability is unavailable");
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "validating" });
  });

  it("replays terminal sync without incrementing version after a local checkpoint failure", async () => {
    const base = memoryStore<RunBinding>();
    let registerCount = 0;
    const flakyStore: PluginStateKeyedStore<RunBinding> = {
      ...base,
      async register(key, value, opts) {
        registerCount += 1;
        if (registerCount === 4) {
          throw new Error("checkpoint unavailable");
        }
        await base.register(key, value, opts);
      },
    };
    const assist = fakeClient();
    const bindings = new RunBindingStore(flakyStore);
    const subagent = fakeSubagent();
    const system = fakeSystem();
    const executionRuntime = new FlowosExecutionRuntime(
      assist.client,
      bindings,
      subagent as never,
      system as never,
      { warn: vi.fn(), info: vi.fn() },
      new ExecutionLocks(),
    );
    const value = await pending(bindings);
    await bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    const event = {
      targetSessionKey: value.childSessionKey!,
      targetKind: "subagent" as const,
      runId: "run-1",
      outcome: "ok" as const,
    };
    const hookContext = {
      childSessionKey: value.childSessionKey,
      requesterSessionKey: value.requesterSessionKey,
    };
    await executionRuntime.subagentEnded(event, hookContext);
    expect(await bindings.byRun("run-1")).toMatchObject({ status: "ENDED_OK_PENDING_SYNC" });
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "validating" });
    await executionRuntime.reconcile();
    expect(await bindings.byRun("run-1")).toMatchObject({ status: "ENDED_OK" });
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "validating" });
    expect(assist.calls.filter((call) => call.path.endsWith("/stage"))).toHaveLength(1);
    expect(system.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(system.requestHeartbeat).toHaveBeenCalledOnce();
  });

  it("reconciles a deferred spawn failure to a terminal Execution", async () => {
    let failUnavailable = true;
    const assist = fakeClient({
      beforeRequest(_method, path) {
        if (failUnavailable && path.endsWith("/fail")) {
          throw new Error("Assist unavailable");
        }
      },
    });
    const subagent = fakeSubagent();
    subagent.run.mockRejectedValue(new Error("spawn rejected"));
    const owner = tools({ client: assist.client, subagent });
    await startExecution(owner.byName);
    await expect(
      owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        agentId: "worker",
        task: "generate result",
      }),
    ).rejects.toThrow("spawn rejected");
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "SPAWN_FAILED_PENDING_SYNC",
    });
    failUnavailable = false;
    await owner.runtime.reconcile();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "SPAWN_FAILED",
    });
    expect(assist.getItem()).toMatchObject({ status: "FAILED", version: 2 });
  });

  it("fails closed after restart when a spawn claim was never accepted", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.instance.reconcile();
    expect(await ctx.bindings.byExecution(value.executionId, value.attemptId)).toMatchObject({
      status: "SPAWN_FAILED",
    });
    expect(ctx.assist.getItem()).toMatchObject({ status: "FAILED", version: 2 });
    expect(ctx.subagent.waitForRun).not.toHaveBeenCalled();
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
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
