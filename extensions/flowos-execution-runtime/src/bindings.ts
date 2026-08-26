import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type RunBindingStatus =
  | "CREATED"
  | "STARTING"
  | "RUNNING"
  | "ENDED_OK_PENDING_SYNC"
  | "ENDED_ERROR_PENDING_SYNC"
  | "ENDED_OK"
  | "ENDED_ERROR"
  | "SPAWN_FAILED";

export type RunBinding = {
  executionId: string;
  attemptId: string;
  requesterSessionKey: string;
  ownerAgentId: string;
  targetAgentId?: string;
  childSessionKey?: string;
  runId?: string;
  status: RunBindingStatus;
  outcome?: string;
  createdAt: number;
  updatedAt: number;
};

const bindingTtlMs = 6 * 60 * 60 * 1_000;

export class RunBindingStore {
  constructor(private readonly store: PluginStateKeyedStore<RunBinding>) {}

  async byExecution(executionId: string, attemptId: string): Promise<RunBinding | undefined> {
    return await this.store.lookup(this.executionKey(executionId, attemptId));
  }

  async byChild(sessionKey: string): Promise<RunBinding | undefined> {
    return await this.store.lookup(`child:${sessionKey}`);
  }

  async byRun(runId: string): Promise<RunBinding | undefined> {
    return await this.store.lookup(`run:${runId}`);
  }

  async save(binding: RunBinding): Promise<void> {
    const opts = { ttlMs: bindingTtlMs };
    await this.store.register(
      this.executionKey(binding.executionId, binding.attemptId),
      binding,
      opts,
    );
    if (binding.childSessionKey) {
      await this.store.register(`child:${binding.childSessionKey}`, binding, opts);
    }
    if (binding.runId) {
      await this.store.register(`run:${binding.runId}`, binding, opts);
    }
  }

  async canonicalEntries(): Promise<RunBinding[]> {
    const entries = await this.store.entries();
    return entries
      .filter((entry) => entry.key.startsWith("execution:"))
      .map((entry) => entry.value);
  }

  private executionKey(executionId: string, attemptId: string): string {
    return `execution:${executionId}:${attemptId}`;
  }
}

export function childSessionKey(agentId: string, executionId: string, attemptId: string): string {
  const safeAgent = agentId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "agent";
  const suffix = `${executionId}-${attemptId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  return `agent:${safeAgent}:subagent:flowos-${suffix}`;
}
