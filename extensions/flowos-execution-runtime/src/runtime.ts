import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { RunBindingStore, type RunBinding } from "./bindings.js";
import { FlowosExecutionClient, type ActiveExecution } from "./client.js";

const activeStatuses = new Set(["QUEUED", "PLANNING", "RUNNING", "AWAITING_USER", "PAUSED"]);

type RuntimeLogger = {
  warn(message: string): void;
  info(message: string): void;
};

type SpawnedEvent = {
  runId: string;
  childSessionKey: string;
  agentId: string;
};

type EndedEvent = {
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
  runId?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
};

type SubagentContext = {
  childSessionKey?: string;
  requesterSessionKey?: string;
};

function terminal(binding: RunBinding): boolean {
  return binding.status === "ENDED_OK" || binding.status === "ENDED_ERROR";
}

function errorForOutcome(outcome: string | undefined): { errorCode: string; retryable: boolean } {
  if (outcome === "timeout") {
    return { errorCode: "PROVIDER_TIMEOUT", retryable: true };
  }
  if (outcome === "error") {
    return { errorCode: "PROVIDER_REJECTED", retryable: true };
  }
  if (outcome === "killed") {
    return { errorCode: "CANCELLED_BY_USER", retryable: false };
  }
  return { errorCode: "INTERNAL", retryable: false };
}

async function latestStillNeedsSync(
  client: FlowosExecutionClient,
  binding: RunBinding,
): Promise<ActiveExecution | null> {
  const detail = await client.detail(binding.executionId);
  if (detail.currentAttemptId !== binding.attemptId || !activeStatuses.has(detail.status)) {
    return null;
  }
  return detail;
}

export class FlowosExecutionRuntime {
  constructor(
    private readonly client: FlowosExecutionClient,
    private readonly bindings: RunBindingStore,
    private readonly subagent: PluginRuntime["subagent"],
    private readonly logger: RuntimeLogger,
  ) {}

  async subagentSpawned(event: SpawnedEvent, ctx: SubagentContext): Promise<void> {
    const pending = await this.bindings.byChild(event.childSessionKey);
    if (
      !pending ||
      pending.requesterSessionKey !== ctx.requesterSessionKey ||
      pending.childSessionKey !== ctx.childSessionKey ||
      pending.targetAgentId !== event.agentId ||
      (pending.runId && pending.runId !== event.runId)
    ) {
      return;
    }
    await this.bindings.save({
      ...pending,
      runId: event.runId,
      status: "RUNNING",
      updatedAt: Date.now(),
    });
  }

  async subagentEnded(event: EndedEvent, ctx: SubagentContext): Promise<void> {
    if (event.targetKind !== "subagent") {
      return;
    }
    const binding = event.runId
      ? await this.bindings.byRun(event.runId)
      : await this.bindings.byChild(event.targetSessionKey);
    if (
      !binding ||
      terminal(binding) ||
      binding.childSessionKey !== event.targetSessionKey ||
      binding.childSessionKey !== ctx.childSessionKey ||
      (event.runId && binding.runId !== event.runId)
    ) {
      return;
    }
    const outcome = event.outcome ?? "error";
    const pending: RunBinding = {
      ...binding,
      outcome,
      status: outcome === "ok" ? "ENDED_OK_PENDING_SYNC" : "ENDED_ERROR_PENDING_SYNC",
      updatedAt: Date.now(),
    };
    await this.bindings.save(pending);
    await this.syncTerminal(pending);
  }

  async reconcile(): Promise<void> {
    for (const binding of await this.bindings.canonicalEntries()) {
      if (binding.status.endsWith("_PENDING_SYNC")) {
        await this.syncTerminal(binding);
        continue;
      }
      if (binding.status !== "RUNNING" || !binding.runId || !binding.childSessionKey) {
        continue;
      }
      const result = await this.subagent
        .waitForRun({ runId: binding.runId, timeoutMs: 1 })
        .catch(() => undefined);
      if (!result || result.status === "timeout") {
        continue;
      }
      await this.subagentEnded(
        {
          targetSessionKey: binding.childSessionKey,
          targetKind: "subagent",
          runId: binding.runId,
          outcome: result.status === "ok" ? "ok" : "error",
        },
        {
          childSessionKey: binding.childSessionKey,
          requesterSessionKey: binding.requesterSessionKey,
        },
      );
    }
  }

  private async syncTerminal(binding: RunBinding): Promise<void> {
    try {
      const detail = await latestStillNeedsSync(this.client, binding);
      if (detail) {
        if (binding.outcome === "ok") {
          await this.client.stage(binding.executionId, {
            expectedVersion: detail.version,
            stageKey: "validating",
            stageLabel: "正在验证结果",
          });
        } else {
          const failure = errorForOutcome(binding.outcome);
          await this.client.fail(binding.executionId, {
            expectedVersion: detail.version,
            ...failure,
          });
        }
      }
      await this.bindings.save({
        ...binding,
        status: binding.outcome === "ok" ? "ENDED_OK" : "ENDED_ERROR",
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution terminal sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
    }
  }
}
