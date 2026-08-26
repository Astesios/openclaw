import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import { childSessionKey, type RunBinding, RunBindingStore } from "./bindings.js";
import { FlowosExecutionClient, type ActiveExecution } from "./client.js";

const activeStatuses = new Set(["QUEUED", "PLANNING", "RUNNING", "AWAITING_USER", "PAUSED"]);
const errorCodes = [
  "AUTHORIZATION_DENIED",
  "GRANT_EXPIRED",
  "CONFLICT",
  "VALIDATION_FAILED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED",
  "CHECKPOINT_INVALID",
  "CANCELLED_BY_USER",
  "INTERNAL",
] as const;

type ToolDeps = {
  api: OpenClawPluginApi;
  context: OpenClawPluginToolContext;
  client: FlowosExecutionClient;
  bindings: RunBindingStore;
  ownerAgentId: string;
};

function requireSession(context: OpenClawPluginToolContext): string {
  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("FlowOS Execution tools require a trusted session context");
  }
  return sessionKey;
}

function contextAgentId(context: OpenClawPluginToolContext): string {
  const agentId = context.agentId?.trim();
  if (!agentId) {
    throw new Error("FlowOS Execution tools require a trusted agent context");
  }
  return agentId.startsWith("agent:") ? agentId : `agent:${agentId}`;
}

function requireOwnerContext(context: OpenClawPluginToolContext, ownerAgentId: string): string {
  const sessionKey = requireSession(context);
  if (isSubagentSessionKey(sessionKey) || contextAgentId(context) !== ownerAgentId) {
    throw new Error("FlowOS Execution owner tool is unavailable to this agent");
  }
  return sessionKey;
}

function requireOwnerBinding(binding: RunBinding, sessionKey: string, ownerAgentId: string): void {
  if (binding.ownerAgentId !== ownerAgentId || binding.requesterSessionKey !== sessionKey) {
    throw new Error("FlowOS Execution belongs to another owner session");
  }
}

async function requireStageBinding(
  deps: ToolDeps,
  executionId: string,
  attemptId?: string,
): Promise<RunBinding> {
  const sessionKey = requireSession(deps.context);
  const agentId = contextAgentId(deps.context);
  const childBinding = await deps.bindings.byChild(sessionKey);
  if (childBinding) {
    const childAgentId = agentId.startsWith("agent:") ? agentId.slice("agent:".length) : agentId;
    if (
      childBinding.executionId !== executionId ||
      childBinding.targetAgentId !== childAgentId ||
      childBinding.status !== "RUNNING"
    ) {
      throw new Error("child progress capability is unavailable or does not match this Execution");
    }
    if (attemptId && childBinding.attemptId !== attemptId) {
      throw new Error("child progress capability does not match this Attempt");
    }
    return childBinding;
  }
  if (agentId === deps.ownerAgentId) {
    if (!attemptId) {
      throw new Error("owner stage requires attemptId");
    }
    const binding = await deps.bindings.byExecution(executionId, attemptId);
    if (!binding) {
      throw new Error("FlowOS Execution binding not found");
    }
    requireOwnerBinding(binding, sessionKey, deps.ownerAgentId);
    return binding;
  }
  throw new Error("child progress capability is unavailable or does not match this Execution");
}

async function requireCurrentExecution(
  deps: ToolDeps,
  binding: RunBinding,
  expectedVersion: number,
): Promise<ActiveExecution> {
  const detail = await deps.client.detail(binding.executionId);
  if (
    detail.ownerAgentId !== binding.ownerAgentId ||
    detail.currentAttemptId !== binding.attemptId ||
    !activeStatuses.has(detail.status)
  ) {
    throw new Error("FlowOS Execution is no longer active for this binding");
  }
  if (expectedVersion > detail.version) {
    throw new Error("expectedVersion is newer than the current FlowOS Execution");
  }
  return detail;
}

function executionBinding(params: {
  executionId: string;
  attemptId: string;
  requesterSessionKey: string;
  ownerAgentId: string;
}): RunBinding {
  const now = Date.now();
  return {
    ...params,
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
  };
}

export function createFlowosExecutionTools(deps: ToolDeps): AnyAgentTool[] {
  const start: AnyAgentTool = {
    name: "flowos_execution_start",
    label: "FlowOS Execution Start",
    description:
      "Create one standard USER or SPACE_TASK long-running Execution for this owner session.",
    parameters: Type.Object(
      {
        source: Type.Union([Type.Literal("USER"), Type.Literal("SPACE_TASK")]),
        taskKind: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }),
        spaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        surfaceKind: Type.Optional(
          Type.Union([Type.Literal("AI_TASK"), Type.Literal("DELIVERY"), Type.Literal("TAKEOUT")]),
        ),
        visibilityPolicy: Type.Optional(
          Type.Union([Type.Literal("DEFAULT"), Type.Literal("SUPPRESS_ISLAND_WHILE_CALL_ACTIVE")]),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        source: "USER" | "SPACE_TASK";
        taskKind: string;
        title: string;
        idempotencyKey: string;
        spaceId?: string;
        taskId?: string;
        surfaceKind?: "AI_TASK" | "DELIVERY" | "TAKEOUT";
        visibilityPolicy?: "DEFAULT" | "SUPPRESS_ISLAND_WHILE_CALL_ACTIVE";
      };
      const requesterSessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
      const item = await deps.client.create({
        source: params.source,
        taskKind: params.taskKind,
        title: params.title,
        idempotencyKey: params.idempotencyKey,
        ownerAgentId: deps.ownerAgentId,
        surfaceKind: params.surfaceKind ?? "AI_TASK",
        visibilityPolicy: params.visibilityPolicy ?? "DEFAULT",
        ...(params.spaceId ? { spaceId: params.spaceId } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
      });
      const attemptId = item.currentAttemptId;
      if (!attemptId) {
        throw new Error("Assist created an Execution without a current Attempt");
      }
      const current = await deps.bindings.byExecution(item.executionId, attemptId);
      if (current) {
        requireOwnerBinding(current, requesterSessionKey, deps.ownerAgentId);
      } else {
        await deps.bindings.save(
          executionBinding({
            executionId: item.executionId,
            attemptId,
            requesterSessionKey,
            ownerAgentId: deps.ownerAgentId,
          }),
        );
      }
      return jsonResult(item);
    },
  };

  const stage: AnyAgentTool = {
    name: "flowos_execution_stage",
    label: "FlowOS Execution Stage",
    description:
      "Update the structured stage for the bound Execution. Child agents can only update their current Attempt.",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        expectedVersion: Type.Integer({ minimum: 1 }),
        stageKey: Type.String({ minLength: 1, maxLength: 64 }),
        stageLabel: Type.String({ minLength: 1, maxLength: 120 }),
        progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId?: string;
        expectedVersion: number;
        stageKey: string;
        stageLabel: string;
        progress?: number;
      };
      const binding = await requireStageBinding(deps, params.executionId, params.attemptId);
      const current = await requireCurrentExecution(deps, binding, params.expectedVersion);
      const item = await deps.client.stage(params.executionId, {
        expectedVersion: current.version,
        stageKey: params.stageKey,
        stageLabel: params.stageLabel,
        ...(params.progress === undefined ? {} : { progress: params.progress }),
      });
      return jsonResult(item);
    },
  };

  const spawn: AnyAgentTool = {
    name: "flowos_execution_spawn",
    label: "FlowOS Execution Spawn",
    description: "Spawn one idempotent subagent run bound to an existing FlowOS Execution Attempt.",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        agentId: Type.String({ minLength: 1, maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 100_000 }),
        idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId: string;
        agentId: string;
        task: string;
        idempotencyKey?: string;
      };
      const requesterSessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
      const current = await deps.bindings.byExecution(params.executionId, params.attemptId);
      if (!current) {
        throw new Error("FlowOS Execution binding not found");
      }
      requireOwnerBinding(current, requesterSessionKey, deps.ownerAgentId);
      if (current.runId) {
        return jsonResult(current);
      }
      const detail = await deps.client.detail(params.executionId);
      if (
        detail.currentAttemptId !== params.attemptId ||
        detail.ownerAgentId !== deps.ownerAgentId ||
        !activeStatuses.has(detail.status)
      ) {
        throw new Error("FlowOS Execution is not eligible for subagent spawn");
      }
      const childKey = childSessionKey(params.agentId, params.executionId, params.attemptId);
      const starting: RunBinding = {
        ...current,
        targetAgentId: params.agentId,
        childSessionKey: childKey,
        status: "STARTING",
        updatedAt: Date.now(),
      };
      await deps.bindings.save(starting);
      try {
        const run = await deps.api.runtime.subagent.run({
          sessionKey: childKey,
          message:
            `[FlowOS Execution]\nexecutionId=${params.executionId}\nattemptId=${params.attemptId}\nexpectedVersion=${detail.version}\n` +
            "Only report structured progress with flowos_execution_stage. Do not complete or fail the Execution.\n\n" +
            params.task,
          deliver: false,
          lightContext: true,
          lane: `flowos-execution:${params.executionId}`,
          idempotencyKey:
            params.idempotencyKey ??
            `flowos:${params.executionId}:${params.attemptId}:${params.agentId}`,
        });
        const hooked = await deps.bindings.byExecution(params.executionId, params.attemptId);
        if (hooked?.runId && hooked.runId !== run.runId) {
          throw new Error("subagent hook returned a conflicting runId");
        }
        const running: RunBinding = {
          ...(hooked ?? starting),
          runId: run.runId,
          status: "RUNNING",
          updatedAt: Date.now(),
        };
        await deps.bindings.save(running);
        return jsonResult(running);
      } catch (error) {
        await deps.bindings.save({ ...starting, status: "SPAWN_FAILED", updatedAt: Date.now() });
        const latest = await deps.client.detail(params.executionId).catch(() => undefined);
        if (latest && activeStatuses.has(latest.status)) {
          await deps.client
            .fail(params.executionId, {
              expectedVersion: latest.version,
              errorCode: "INTERNAL",
              retryable: true,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
  };

  const complete: AnyAgentTool = {
    name: "flowos_execution_complete",
    label: "FlowOS Execution Complete",
    description:
      "Complete the owner session Execution only after registering one controlled result reference.",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: Type.Integer({ minimum: 1 }),
        resultType: Type.Union([
          Type.Literal("CASE_DETAIL"),
          Type.Literal("SPACE_ARTIFACT"),
          Type.Literal("RESOURCE"),
        ]),
        resultId: Type.String({ minLength: 1, maxLength: 128 }),
        spaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        resourceKind: Type.Optional(
          Type.Union([Type.Literal("GENERIC"), Type.Literal("CODING_JOB")]),
        ),
        backingId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId: string;
        expectedVersion: number;
        resultType: "CASE_DETAIL" | "SPACE_ARTIFACT" | "RESOURCE";
        resultId: string;
        spaceId?: string;
        resourceKind?: "GENERIC" | "CODING_JOB";
        backingId?: string;
      };
      const sessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
      const binding = await deps.bindings.byExecution(params.executionId, params.attemptId);
      if (!binding) {
        throw new Error("FlowOS Execution binding not found");
      }
      requireOwnerBinding(binding, sessionKey, deps.ownerAgentId);
      const current = await requireCurrentExecution(deps, binding, params.expectedVersion);
      const resultRef = {
        type: params.resultType,
        id: params.resultId,
        ...(params.spaceId ? { spaceId: params.spaceId } : {}),
      };
      const resourceRegistration =
        params.resultType === "RESOURCE"
          ? {
              resourceId: params.resultId,
              resourceKind: params.resourceKind ?? "GENERIC",
              ...(params.backingId ? { backingId: params.backingId } : {}),
            }
          : undefined;
      const item = await deps.client.complete({
        executionId: params.executionId,
        expectedVersion: current.version,
        resultRef,
        resourceRegistration,
      });
      return jsonResult(item);
    },
  };

  const fail: AnyAgentTool = {
    name: "flowos_execution_fail",
    label: "FlowOS Execution Fail",
    description: "Fail the owner session Execution with a fixed safe error code.",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: Type.Integer({ minimum: 1 }),
        errorCode: Type.Union(errorCodes.map((value) => Type.Literal(value))),
        retryable: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId: string;
        expectedVersion: number;
        errorCode: (typeof errorCodes)[number];
        retryable?: boolean;
      };
      const sessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
      const binding = await deps.bindings.byExecution(params.executionId, params.attemptId);
      if (!binding) {
        throw new Error("FlowOS Execution binding not found");
      }
      requireOwnerBinding(binding, sessionKey, deps.ownerAgentId);
      const current = await requireCurrentExecution(deps, binding, params.expectedVersion);
      const item = await deps.client.fail(params.executionId, {
        expectedVersion: current.version,
        errorCode: params.errorCode,
        retryable: params.retryable ?? false,
      });
      return jsonResult(item);
    },
  };

  return [start, stage, spawn, complete, fail];
}
