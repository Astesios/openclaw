import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { RunBindingStore, type RunBinding } from "./bindings.js";
import { FlowosExecutionClient, type ActiveExecution } from "./client.js";
import { ExecutionLocks } from "./locks.js";

const activeStatuses = new Set(["QUEUED", "PLANNING", "RUNNING", "AWAITING_USER", "PAUSED"]);

type RuntimeLogger = {
  warn(message: string): void;
  info(message: string): void;
};

type RuntimeSystem = Pick<PluginRuntime["system"], "enqueueSystemEvent" | "requestHeartbeat">;

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
  return (
    binding.status === "ENDED_OK" ||
    binding.status === "ENDED_ERROR" ||
    binding.status === "SPAWN_FAILED"
  );
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
    private readonly system: RuntimeSystem,
    private readonly logger: RuntimeLogger,
    private readonly locks: ExecutionLocks,
  ) {}

  async subagentEnded(event: EndedEvent, ctx: SubagentContext): Promise<void> {
    if (event.targetKind !== "subagent") {
      return;
    }
    const found = event.runId
      ? await this.bindings.byRun(event.runId)
      : await this.bindings.byChild(event.targetSessionKey);
    if (!found) {
      return;
    }
    let wake: { binding: RunBinding; outcome: string; version: number } | undefined;
    await this.locks.run(found.executionId, found.attemptId, async () => {
      const binding = await this.bindings.byExecution(found.executionId, found.attemptId);
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
      const version = await this.syncTerminalLocked(pending);
      if (version !== null) {
        wake = { binding: pending, outcome, version };
      }
    });
    if (wake) {
      this.wakeRequester(wake.binding, wake.outcome, wake.version);
    }
  }

  async reconcile(): Promise<void> {
    for (const binding of await this.bindings.canonicalEntries()) {
      if (binding.status === "STARTING") {
        await this.locks.run(binding.executionId, binding.attemptId, async () => {
          const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
          if (current?.status !== "STARTING") {
            return;
          }
          const pending: RunBinding = {
            ...current,
            status: "SPAWN_FAILED_PENDING_SYNC",
            updatedAt: Date.now(),
          };
          await this.bindings.save(pending);
          await this.syncSpawnFailureLocked(pending);
        });
        continue;
      }
      if (binding.status === "SPAWN_FAILED_PENDING_SYNC") {
        await this.locks.run(binding.executionId, binding.attemptId, async () => {
          const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
          if (current?.status === "SPAWN_FAILED_PENDING_SYNC") {
            await this.syncSpawnFailureLocked(current);
          }
        });
        continue;
      }
      if (binding.status.endsWith("_PENDING_SYNC")) {
        await this.locks.run(binding.executionId, binding.attemptId, async () => {
          const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
          if (current?.status.endsWith("_PENDING_SYNC")) {
            const version = await this.syncTerminalLocked(current);
            if (version !== null) {
              this.wakeRequester(current, current.outcome ?? "error", version);
            }
          }
        });
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

  async syncSpawnFailure(binding: RunBinding): Promise<void> {
    await this.locks.run(binding.executionId, binding.attemptId, async () => {
      const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
      const candidate =
        current?.status === "SPAWN_FAILED_PENDING_SYNC"
          ? current
          : current?.status === "STARTING" && current.runId === binding.runId
            ? binding
            : undefined;
      if (candidate) {
        await this.syncSpawnFailureLocked(candidate);
      }
    });
  }

  private async syncSpawnFailureLocked(binding: RunBinding): Promise<void> {
    try {
      const detail = await latestStillNeedsSync(this.client, binding);
      if (detail) {
        await this.client.fail(binding.executionId, {
          expectedVersion: detail.version,
          errorCode: "INTERNAL",
          retryable: true,
        });
      }
      await this.bindings.save({
        ...binding,
        status: "SPAWN_FAILED",
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution spawn failure sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
    }
  }

  private async syncTerminalLocked(binding: RunBinding): Promise<number | null> {
    try {
      const detail = await latestStillNeedsSync(this.client, binding);
      let syncedVersion = detail?.version ?? null;
      if (detail) {
        if (binding.outcome === "ok") {
          if (detail.stageKey !== "validating") {
            const validating = await this.client.stage(binding.executionId, {
              expectedVersion: detail.version,
              stageKey: "validating",
              stageLabel: "正在验证结果",
            });
            syncedVersion = validating.version;
          }
        } else {
          const failure = errorForOutcome(binding.outcome);
          const failed = await this.client.fail(binding.executionId, {
            expectedVersion: detail.version,
            ...failure,
          });
          syncedVersion = failed.version;
        }
      }
      await this.bindings.save({
        ...binding,
        status: binding.outcome === "ok" ? "ENDED_OK" : "ENDED_ERROR",
        updatedAt: Date.now(),
      });
      return syncedVersion;
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution terminal sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
      return null;
    }
  }

  private wakeRequester(binding: RunBinding, outcome: string, version: number): void {
    const event =
      `[FlowOS Execution]\nexecutionId=${binding.executionId}\nattemptId=${binding.attemptId}\n` +
      `outcome=${outcome}\nversion=${version}\n` +
      (outcome === "ok"
        ? "The child run ended successfully. Continue the business validator and register the result before completing the Execution."
        : "The child run ended unsuccessfully. Report the controlled failure; do not complete the Execution.");
    const queued = this.system.enqueueSystemEvent(event, {
      sessionKey: binding.requesterSessionKey,
      contextKey: `flowos-execution:${binding.executionId}:${binding.attemptId}:ended`,
    });
    if (queued) {
      this.system.requestHeartbeat({
        source: "background-task",
        intent: "immediate",
        reason: "background-task",
        sessionKey: binding.requesterSessionKey,
      });
    }
  }
}
