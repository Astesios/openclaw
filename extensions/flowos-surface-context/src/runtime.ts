import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { SurfaceContextBinding, SurfaceContextBrief } from "./client.js";
import { SurfaceContextClient } from "./client.js";

const maxBindings = 1024;
const runtimeStateSymbol = Symbol.for("openclaw.flowosSurfaceContextRuntimeState");

type ActiveBinding = SurfaceContextBinding & {
  expiresAtMs: number;
};

export type SurfaceContextRuntimeState = {
  bindings: Map<string, ActiveBinding>;
  activeRuns: Map<string, ActiveBinding & { runId: string }>;
  generations: Map<string, number>;
  inFlightBindings: Map<string, number>;
};

export function createSurfaceContextRuntimeState(): SurfaceContextRuntimeState {
  return {
    bindings: new Map(),
    activeRuns: new Map(),
    generations: new Map(),
    inFlightBindings: new Map(),
  };
}

export function sharedSurfaceContextRuntimeState(): SurfaceContextRuntimeState {
  const root = globalThis as typeof globalThis & {
    [runtimeStateSymbol]?: SurfaceContextRuntimeState;
  };
  return (root[runtimeStateSymbol] ??= createSurfaceContextRuntimeState());
}

export function clearSharedSurfaceContextRuntimeStateForTest(): void {
  const root = globalThis as typeof globalThis & {
    [runtimeStateSymbol]?: SurfaceContextRuntimeState;
  };
  delete root[runtimeStateSymbol];
}

function defaultAgentId(config: {
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  return (agents.find((item) => item.default)?.id ?? agents[0]?.id ?? "main").trim().toLowerCase();
}

export function canonicalSessionKey(
  config: {
    session?: { scope?: string; mainKey?: string };
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  },
  value: string,
): string {
  const raw = value.trim().toLowerCase();
  if (!raw || raw === "global" || raw === "unknown") {
    return raw;
  }
  const mainKey = config.session?.mainKey?.trim().toLowerCase() || "main";
  const agentId = defaultAgentId(config);
  if (config.session?.scope === "global" && (raw === "main" || raw === mainKey)) {
    return "global";
  }
  if (
    raw === "main" ||
    raw === mainKey ||
    raw === `agent:main:main` ||
    raw === `agent:${agentId}:main`
  ) {
    return `agent:${agentId}:${mainKey}`;
  }
  return raw.startsWith("agent:") ? raw : `agent:${agentId}:${raw}`;
}

export class SurfaceContextRuntime {
  constructor(
    private readonly client: SurfaceContextClient,
    private readonly config: Parameters<typeof canonicalSessionKey>[0],
    private readonly now: () => number = Date.now,
    private readonly state: SurfaceContextRuntimeState = createSurfaceContextRuntimeState(),
  ) {}

  private bump(sessionKey: string): number {
    const generation = (this.state.generations.get(sessionKey) ?? 0) + 1;
    this.state.generations.set(sessionKey, generation);
    return generation;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [key, binding] of this.state.bindings) {
      if (binding.expiresAtMs <= now) {
        this.state.bindings.delete(key);
      }
    }
    for (const [key, binding] of this.state.activeRuns) {
      if (binding.expiresAtMs <= now) {
        this.state.activeRuns.delete(key);
      }
    }
    for (const key of this.state.generations.keys()) {
      if (
        !this.state.bindings.has(key) &&
        !this.state.activeRuns.has(key) &&
        !this.state.inFlightBindings.has(key)
      ) {
        this.state.generations.delete(key);
      }
    }
  }

  private beginBind(sessionKey: string): void {
    this.state.inFlightBindings.set(
      sessionKey,
      (this.state.inFlightBindings.get(sessionKey) ?? 0) + 1,
    );
  }

  private endBind(sessionKey: string): void {
    const remaining = (this.state.inFlightBindings.get(sessionKey) ?? 1) - 1;
    if (remaining > 0) {
      this.state.inFlightBindings.set(sessionKey, remaining);
    } else {
      this.state.inFlightBindings.delete(sessionKey);
    }
  }

  async bind(rawSessionKey: string, contextRef: string): Promise<ActiveBinding> {
    this.sweepExpired();
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    if (!sessionKey) {
      throw new Error("CONTEXT_SESSION_INVALID");
    }
    const generation = this.bump(sessionKey);
    this.beginBind(sessionKey);
    try {
      const binding = await this.client.consume(contextRef, rawSessionKey);
      if (this.state.generations.get(sessionKey) !== generation) {
        throw new Error("CONTEXT_STALE_BIND");
      }
      const expiresAtMs = Date.parse(binding.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
        throw new Error("CONTEXT_EXPIRED");
      }
      if (
        !this.state.bindings.has(sessionKey) &&
        !this.state.activeRuns.has(sessionKey) &&
        this.state.bindings.size + this.state.activeRuns.size >= maxBindings
      ) {
        throw new Error("CONTEXT_BINDING_LIMIT_REACHED");
      }
      const active = { ...binding, expiresAtMs };
      // 新页面 Ref 先撤销当前 run 的旧对象；旧工具调用随后只能得到 unavailable。
      this.state.activeRuns.delete(sessionKey);
      this.state.bindings.set(sessionKey, active);
      return active;
    } finally {
      this.endBind(sessionKey);
    }
  }

  clear(rawSessionKey: string): boolean {
    this.sweepExpired();
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    this.bump(sessionKey);
    const pending = this.state.bindings.delete(sessionKey);
    const active = this.state.activeRuns.delete(sessionKey);
    return pending || active;
  }

  active(rawSessionKey: string | undefined): ActiveBinding | undefined {
    this.sweepExpired();
    if (!rawSessionKey) {
      return undefined;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    const binding = this.state.activeRuns.get(sessionKey);
    if (!binding) {
      return undefined;
    }
    if (binding.expiresAtMs <= this.now()) {
      this.state.activeRuns.delete(sessionKey);
      return undefined;
    }
    return binding;
  }

  claimForRun(
    rawSessionKey: string | undefined,
    runId: string | undefined,
  ): ActiveBinding | undefined {
    this.sweepExpired();
    if (!rawSessionKey || !runId) {
      return undefined;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    const current = this.state.activeRuns.get(sessionKey);
    if (current?.runId === runId) {
      return current;
    }
    if (current) {
      this.state.activeRuns.delete(sessionKey);
    }
    const pending = this.state.bindings.get(sessionKey);
    if (!pending) {
      return undefined;
    }
    this.state.bindings.delete(sessionKey);
    this.state.activeRuns.set(sessionKey, { ...pending, runId });
    return pending;
  }

  endRun(rawSessionKey: string | undefined, runId: string | undefined): void {
    this.sweepExpired();
    if (!rawSessionKey || !runId) {
      return;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    if (this.state.activeRuns.get(sessionKey)?.runId === runId) {
      this.state.activeRuns.delete(sessionKey);
      if (!this.state.bindings.has(sessionKey)) {
        this.state.generations.delete(sessionKey);
      }
    }
  }
}

function requireSession(context: OpenClawPluginToolContext): string {
  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("Surface Context tools require a trusted session context");
  }
  return sessionKey;
}

export function createSurfaceContextTools(
  runtime: SurfaceContextRuntime,
  context: OpenClawPluginToolContext,
): AnyAgentTool[] {
  const emptyParameters = Type.Object({}, { additionalProperties: false });
  const status: AnyAgentTool = {
    name: "surface_context_status",
    label: "Surface Context Status",
    description:
      "Check whether this exact OpenClaw session has a live FlowOS Surface Context binding. Takes no ref or identity arguments.",
    executionMode: "sequential",
    parameters: emptyParameters,
    async execute() {
      const binding = runtime.active(requireSession(context));
      if (!binding) {
        return jsonResult({ available: false, reason: "CONTEXT_UNAVAILABLE" });
      }
      return jsonResult({
        available: true,
        providerId: binding.context.providerId,
        objectType: binding.context.objectType,
        expiresAt: binding.expiresAt,
      });
    },
  };
  const resolve: AnyAgentTool = {
    name: "surface_context_resolve",
    label: "Surface Context Resolve",
    description:
      "Read the permission-filtered minimal Space or Artifact brief bound to this exact session. Takes no ref, path, user, tenant, endpoint, or credential arguments.",
    executionMode: "sequential",
    parameters: emptyParameters,
    async execute() {
      const binding = runtime.active(requireSession(context));
      if (!binding) {
        return jsonResult({ available: false, reason: "CONTEXT_UNAVAILABLE" });
      }
      return jsonResult({
        available: true,
        context: binding.context satisfies SurfaceContextBrief,
      });
    },
  };
  return [status, resolve];
}

export function buildPromptContext(binding: ActiveBinding | undefined): string | undefined {
  if (!binding) {
    return undefined;
  }
  return [
    "<flowos_surface_context>",
    "当前 OpenClaw session 已绑定一份由 FlowOS 验证的短时手机 Surface Context。",
    `对象类型：${binding.context.objectType}；Provider：${binding.context.providerId}。`,
    "如需理解当前对象，调用 surface_context_status 与 surface_context_resolve。",
    "不要向用户索要 ContextRef、userId、tenantId、文件路径或凭据。",
    "</flowos_surface_context>",
  ].join("\n");
}
