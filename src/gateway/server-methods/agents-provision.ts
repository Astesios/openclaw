import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateAgentsProvisionConfirmParams,
  validateAgentsProvisionDismissParams,
  validateAgentsProvisionOperationGetParams,
  validateAgentsProvisionProposeParams,
  validateAgentsProvisionStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions.js";
import type { AgentToolsConfig } from "../../config/types.tools.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { loadWorkspaceSkillEntries } from "../../skills/loading/workspace.js";
import type { ProfessionalAgentSkillTemplate, SkillEntry } from "../../skills/types.js";
import { resolveConfigDir } from "../../utils.js";
import { loadSessionEntry } from "../session-utils.js";
import { createAgentConfigEntry } from "./agents-config-mutations.js";
import { chatHandlers } from "./chat.js";
import { sessionsHandlers } from "./sessions.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./shared-types.js";
import { respondInvalidMethodParams } from "./validation.js";

const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const MAX_RECORDS = 256;
const MARKER_FILE = ".flowos-agent.json";
const PERSONA_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md"] as const;

type ProvisionState =
  | "offered"
  | "pending"
  | "provisioning"
  | "ready"
  | "failed"
  | "expired"
  | "dismissed";

type ResolvedRecipe = {
  template: ProfessionalAgentSkillTemplate;
  sourceSkill: string;
  sourceDigest: string;
  entries: SkillEntry[];
  parentAgentId: string;
};

type ProvisionRecord = {
  offerId: string;
  proposalId?: string;
  operationId?: string;
  state: ProvisionState;
  createdAtMs: number;
  expiresAtMs: number;
  templateId: string;
  templateVersion: number;
  sourceSkill: string;
  sourceDigest: string;
  planDigest?: string;
  parentSessionKey: string;
  subject: string;
  originalRequest: string;
  idempotencyKey?: string;
  agentId?: string;
  sessionKey?: string;
  error?: string;
};

const records = new Map<string, ProvisionRecord>();

const TOOL_PROFILES: Record<string, { tools: AgentToolsConfig; permissionSummary: string[] }> = {
  "health-buddy-v1": {
    tools: { profile: "full", deny: ["gateway"] },
    permissionSummary: [
      "健康资料与长期计划 workspace",
      "本地文件与受控运行工具",
      "不开放原始 Gateway 管理工具",
    ],
  },
  "coding-buddy-v1": {
    tools: {
      profile: "coding",
      alsoAllow: [
        "professional_agent",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "session_status",
      ],
    },
    permissionSummary: ["独立工程 workspace", "代码、文件与命令工具", "受控会话协作工具"],
  },
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function subjectFor(options: GatewayRequestHandlerOptions): string {
  // OpenClaw Gateway is single-owner. Device ids differ between the model backend and native
  // clients, so the stable authorization subject is the authenticated gateway owner role.
  return `gateway-owner:${options.client?.connect.role ?? "operator"}`;
}

function sweepRecords(now = Date.now()): void {
  // Proposals are intentionally process-local, short-lived and bounded. This prevents stale
  // authorization from surviving template changes while still supporting ordinary reconnects.
  for (const [key, record] of records) {
    if (record.expiresAtMs <= now && (record.state === "offered" || record.state === "pending")) {
      record.state = "expired";
    }
    if (records.size > MAX_RECORDS && record.createdAtMs < now - PROPOSAL_TTL_MS) {
      records.delete(key);
    }
  }
}

function putRecord(record: ProvisionRecord): void {
  sweepRecords();
  records.set(record.offerId, record);
  if (record.proposalId) {
    records.set(record.proposalId, record);
  }
  if (record.operationId) {
    records.set(record.operationId, record);
  }
}

function publicResult(record: ProvisionRecord, card?: Record<string, unknown>) {
  return {
    status: record.state,
    templateId: record.templateId,
    offerId: record.offerId,
    ...(record.proposalId ? { proposalId: record.proposalId } : {}),
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.planDigest ? { planDigest: record.planDigest } : {}),
    expiresAtMs: record.expiresAtMs,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(card ? { card } : {}),
  };
}

async function resolveRecipe(params: {
  context: GatewayRequestContext;
  parentSessionKey: string;
  templateId: string;
}): Promise<ResolvedRecipe> {
  const cfg = params.context.getRuntimeConfig();
  const parent = loadSessionEntry(params.parentSessionKey);
  if (!parent.entry?.sessionId) {
    throw new Error(`unknown parent session: ${params.parentSessionKey}`);
  }
  const parentAgentId = normalizeAgentId(
    resolveAgentIdFromSessionKey(parent.canonicalKey) ?? resolveDefaultAgentId(cfg),
  );
  const workspace = resolveAgentWorkspaceDir(cfg, parentAgentId);
  const allEntries = loadWorkspaceSkillEntries(workspace, {
    config: cfg,
    agentId: parentAgentId,
  });
  const source = allEntries.find(
    (entry) => entry.metadata?.professionalAgent?.templateId === params.templateId,
  );
  const template = source?.metadata?.professionalAgent;
  if (!source || !template) {
    throw new Error(`professional agent template not found: ${params.templateId}`);
  }
  if (!TOOL_PROFILES[template.toolProfile]) {
    throw new Error(`professional agent tool profile is not approved: ${template.toolProfile}`);
  }
  const entries = template.entrySkills.map((skillName) => {
    const entry = allEntries.find((candidate) => candidate.skill.name === skillName);
    if (!entry) {
      throw new Error(`entry skill not found: ${skillName}`);
    }
    return entry;
  });
  const skillContents = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.skill.name,
      content: await fs.readFile(entry.skill.filePath, "utf8"),
    })),
  );
  return {
    template,
    sourceSkill: source.skill.name,
    sourceDigest: digest(skillContents),
    entries,
    parentAgentId,
  };
}

function managedAgentState(
  context: GatewayRequestContext,
  recipe: ResolvedRecipe,
): "missing" | "ready" | "conflict" {
  const cfg = context.getRuntimeConfig();
  const entry = cfg.agents?.list?.find(
    (candidate) => normalizeAgentId(candidate.id) === recipe.template.templateId,
  );
  if (!entry) {
    return "missing";
  }
  const managed = entry.professionalAgent;
  return managed?.managed === true &&
    managed.templateId === recipe.template.templateId &&
    managed.templateVersion === recipe.template.templateVersion &&
    managed.sourceDigest === recipe.sourceDigest &&
    managed.toolProfile === recipe.template.toolProfile
    ? "ready"
    : "conflict";
}

async function copyTreeSafe(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`unsupported Skill file type: ${source}`);
  }
  if (stat.isFile()) {
    await fs.copyFile(source, target);
    return;
  }
  await fs.mkdir(target, { recursive: true });
  for (const name of await fs.readdir(source)) {
    await copyTreeSafe(path.join(source, name), path.join(target, name));
  }
}

async function createSession(
  options: GatewayRequestHandlerOptions,
  params: {
    config: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
    agentId: string;
    parentSessionKey: string;
    originalRequest: string;
  },
): Promise<string> {
  let payload: Record<string, unknown> | undefined;
  let failure: string | undefined;
  await sessionsHandlers["sessions.create"]({
    ...options,
    params: {
      agentId: params.agentId,
      parentSessionKey: params.parentSessionKey,
      label: `Professional: ${params.agentId}`,
      message: params.originalRequest,
    },
    context: { ...options.context, getRuntimeConfig: () => params.config },
    respond: (ok, value, error) => {
      if (ok && value && typeof value === "object") {
        payload = value as Record<string, unknown>;
      } else {
        failure = error?.message ?? "session creation failed";
      }
    },
  });
  const key = typeof payload?.key === "string" ? payload.key : undefined;
  if (!key) {
    throw new Error(failure ?? "session creation returned no key");
  }
  return key;
}

function cardFor(record: ProvisionRecord, recipe: ResolvedRecipe): Record<string, unknown> {
  const profile = TOOL_PROFILES[recipe.template.toolProfile];
  return {
    type: "professional_agent_confirmation",
    proposalId: record.proposalId,
    operationId: record.operationId,
    planDigest: record.planDigest,
    templateId: recipe.template.templateId,
    templateVersion: recipe.template.templateVersion,
    displayName: recipe.template.displayName,
    description: recipe.template.description,
    isolation: recipe.template.isolation,
    isolationReason:
      recipe.template.isolation === "required"
        ? "该任务需要与主智能体的权限和工程上下文严格隔离。"
        : "独立智能体可持续维护该专业领域的资料、目标与复盘。",
    entrySkills: recipe.template.entrySkills,
    permissionSummary: profile.permissionSummary,
    state: record.state,
    expiresAtMs: record.expiresAtMs,
  };
}

async function injectCard(options: GatewayRequestHandlerOptions, card: Record<string, unknown>) {
  let failure: string | undefined;
  await chatHandlers["chat.inject"]({
    ...options,
    params: {
      sessionKey: options.params.parentSessionKey,
      message: `[celia_card]${JSON.stringify(card)}`,
      label: "professional_agent_confirmation",
    },
    respond: (ok, _payload, error) => {
      if (!ok) {
        failure = error?.message ?? "confirmation card injection failed";
      }
    },
  });
  if (failure) {
    throw new Error(failure);
  }
}

async function provision(
  options: GatewayRequestHandlerOptions,
  record: ProvisionRecord,
): Promise<void> {
  record.state = "provisioning";
  record.error = undefined;
  options.context.broadcast("agents.provision.operation", publicResult(record), {
    dropIfSlow: true,
  });
  try {
    const recipe = await resolveRecipe({
      context: options.context,
      parentSessionKey: record.parentSessionKey,
      templateId: record.templateId,
    });
    if (
      recipe.template.templateVersion !== record.templateVersion ||
      recipe.sourceDigest !== record.sourceDigest ||
      digest({ template: recipe.template, sourceDigest: recipe.sourceDigest }) !== record.planDigest
    ) {
      throw new Error("professional agent template changed; request a new confirmation");
    }
    const existing = managedAgentState(options.context, recipe);
    if (existing === "conflict") {
      throw new Error(`agent id conflict: ${record.templateId}`);
    }
    let config = options.context.getRuntimeConfig();
    if (existing === "missing") {
      const profile = TOOL_PROFILES[recipe.template.toolProfile];
      const workspaceRoot = path.join(resolveConfigDir(), "workspace", "domain-agents");
      const workspace = path.join(workspaceRoot, recipe.template.templateId);
      const staging = path.join(
        workspaceRoot,
        `.staging-${recipe.template.templateId}-${randomUUID()}`,
      );
      if (
        await fs
          .stat(workspace)
          .then(() => true)
          .catch(() => false)
      ) {
        throw new Error(`workspace conflict: ${workspace}`);
      }
      await fs.mkdir(staging, { recursive: true });
      try {
        for (const entry of recipe.entries) {
          await copyTreeSafe(entry.skill.baseDir, path.join(staging, "skills", entry.skill.name));
        }
        const personaDir = path.join(recipe.entries[0].skill.baseDir, "persona");
        for (const file of PERSONA_FILES) {
          const source = path.join(personaDir, file);
          if (
            await fs
              .stat(source)
              .then((value) => value.isFile())
              .catch(() => false)
          ) {
            await fs.copyFile(source, path.join(staging, file));
          }
        }
        await fs.writeFile(
          path.join(staging, MARKER_FILE),
          `${JSON.stringify(
            {
              managed: true,
              templateId: recipe.template.templateId,
              templateVersion: recipe.template.templateVersion,
              sourceSkill: recipe.sourceSkill,
              sourceDigest: recipe.sourceDigest,
              toolProfile: recipe.template.toolProfile,
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        await fs.rename(staging, workspace);
        let nextConfig = applyAgentConfig(config, {
          agentId: recipe.template.templateId,
          name: recipe.template.displayName,
          description: recipe.template.description,
          workspace,
          identity: { name: recipe.template.displayName },
          skills: recipe.template.entrySkills,
          tools: profile.tools,
          professionalAgent: {
            managed: true,
            templateId: recipe.template.templateId,
            templateVersion: recipe.template.templateVersion,
            sourceSkill: recipe.sourceSkill,
            sourceDigest: recipe.sourceDigest,
            toolProfile: recipe.template.toolProfile,
          },
        });
        const agentDir = resolveAgentDir(nextConfig, recipe.template.templateId);
        const agentStateRoot = path.dirname(agentDir);
        nextConfig = applyAgentConfig(nextConfig, {
          agentId: recipe.template.templateId,
          agentDir,
        });
        let ownsAgentStateRoot = false;
        try {
          // Non-recursive creation is the ownership claim. Cleanup below is permitted only
          // after this exact operation acquired the previously absent agent-state directory.
          await fs.mkdir(agentStateRoot);
          ownsAgentStateRoot = true;
          await fs.mkdir(resolveSessionTranscriptsDirForAgent(recipe.template.templateId), {
            recursive: true,
          });
          config = await createAgentConfigEntry({
            agentId: recipe.template.templateId,
            name: recipe.template.displayName,
            description: recipe.template.description,
            workspace,
            agentDir,
            identity: { name: recipe.template.displayName },
            skills: recipe.template.entrySkills,
            tools: profile.tools,
            professionalAgent: {
              managed: true,
              templateId: recipe.template.templateId,
              templateVersion: recipe.template.templateVersion,
              sourceSkill: recipe.sourceSkill,
              sourceDigest: recipe.sourceDigest,
              toolProfile: recipe.template.toolProfile,
            },
          });
        } catch (error) {
          // Config is committed last. A failed commit only removes the workspace created by
          // this operation and never touches a pre-existing agent or user directory.
          await fs.rm(workspace, { recursive: true, force: true });
          if (ownsAgentStateRoot) {
            await fs.rm(agentStateRoot, { recursive: true, force: true });
          }
          throw error;
        }
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    record.agentId = recipe.template.templateId;
    record.sessionKey = await createSession(options, {
      config,
      agentId: recipe.template.templateId,
      parentSessionKey: record.parentSessionKey,
      originalRequest: record.originalRequest,
    });
    record.state = "ready";
  } catch (error) {
    record.state = "failed";
    record.error = formatErrorMessage(error);
  }
  options.context.broadcast("agents.provision.operation", publicResult(record), {
    dropIfSlow: true,
  });
}

function findRecord(id: string): ProvisionRecord | undefined {
  sweepRecords();
  return records.get(id);
}

export const agentsProvisionHandlers: GatewayRequestHandlers = {
  "agents.provision.status": async (options) => {
    if (!validateAgentsProvisionStatusParams(options.params)) {
      respondInvalidMethodParams(
        options.respond,
        "agents.provision.status",
        validateAgentsProvisionStatusParams.errors,
      );
      return;
    }
    try {
      const recipe = await resolveRecipe({
        context: options.context,
        parentSessionKey: options.params.parentSessionKey as string,
        templateId: options.params.templateId as string,
      });
      const state = managedAgentState(options.context, recipe);
      options.respond(true, {
        status: state === "ready" ? "ready" : state === "conflict" ? "failed" : "pending",
        templateId: recipe.template.templateId,
        ...(state === "ready" ? { agentId: recipe.template.templateId } : {}),
        ...(state === "conflict"
          ? { error: `agent id conflict: ${recipe.template.templateId}` }
          : {}),
      });
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
      );
    }
  },

  "agents.provision.propose": async (options) => {
    if (!validateAgentsProvisionProposeParams(options.params)) {
      respondInvalidMethodParams(
        options.respond,
        "agents.provision.propose",
        validateAgentsProvisionProposeParams.errors,
      );
      return;
    }
    try {
      if (options.params.mode === "offer") {
        const recipe = await resolveRecipe({
          context: options.context,
          parentSessionKey: options.params.parentSessionKey as string,
          templateId: options.params.templateId as string,
        });
        const managed = managedAgentState(options.context, recipe);
        if (managed === "conflict") {
          throw new Error(`agent id conflict: ${recipe.template.templateId}`);
        }
        const now = Date.now();
        const record: ProvisionRecord = {
          offerId: randomUUID(),
          state: "offered",
          createdAtMs: now,
          expiresAtMs: now + PROPOSAL_TTL_MS,
          templateId: recipe.template.templateId,
          templateVersion: recipe.template.templateVersion,
          sourceSkill: recipe.sourceSkill,
          sourceDigest: recipe.sourceDigest,
          parentSessionKey: options.params.parentSessionKey as string,
          subject: subjectFor(options),
          originalRequest: options.params.originalRequest as string,
        };
        putRecord(record);
        if (managed === "ready") {
          record.proposalId = record.offerId;
          record.operationId = record.offerId;
          record.planDigest = digest({
            template: recipe.template,
            sourceDigest: recipe.sourceDigest,
          });
          record.agentId = recipe.template.templateId;
          record.sessionKey = await createSession(options, {
            config: options.context.getRuntimeConfig(),
            agentId: recipe.template.templateId,
            parentSessionKey: record.parentSessionKey,
            originalRequest: record.originalRequest,
          });
          record.state = "ready";
          putRecord(record);
          await injectCard(
            {
              ...options,
              params: { ...options.params, parentSessionKey: record.parentSessionKey },
            },
            cardFor(record, recipe),
          );
          options.context.broadcast("agents.provision.operation", publicResult(record), {
            dropIfSlow: true,
          });
        }
        options.respond(true, publicResult(record));
        return;
      }
      const record = findRecord(options.params.offerId as string);
      if (!record || record.state !== "offered") {
        throw new Error("offer is unavailable or already consumed");
      }
      if (
        record.parentSessionKey !== options.params.parentSessionKey ||
        record.subject !== subjectFor(options)
      ) {
        throw new Error("offer does not belong to this user or parent session");
      }
      const recipe = await resolveRecipe({
        context: options.context,
        parentSessionKey: record.parentSessionKey,
        templateId: record.templateId,
      });
      if (
        recipe.template.templateVersion !== record.templateVersion ||
        recipe.sourceDigest !== record.sourceDigest
      ) {
        throw new Error("professional agent template changed; request a new offer");
      }
      record.proposalId = randomUUID();
      record.operationId = record.proposalId;
      record.planDigest = digest({ template: recipe.template, sourceDigest: recipe.sourceDigest });
      record.state = "pending";
      putRecord(record);
      const card = cardFor(record, recipe);
      await injectCard(
        { ...options, params: { ...options.params, parentSessionKey: record.parentSessionKey } },
        card,
      );
      options.respond(true, publicResult(record, card));
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
      );
    }
  },

  "agents.provision.confirm": async (options) => {
    if (!validateAgentsProvisionConfirmParams(options.params)) {
      respondInvalidMethodParams(
        options.respond,
        "agents.provision.confirm",
        validateAgentsProvisionConfirmParams.errors,
      );
      return;
    }
    const record = findRecord(options.params.proposalId as string);
    if (!record) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "proposal not found"),
      );
      return;
    }
    if (record.subject !== subjectFor(options)) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "proposal belongs to a different user"),
      );
      return;
    }
    if (record.state === "ready" || record.state === "provisioning") {
      options.respond(true, publicResult(record));
      return;
    }
    if (record.state === "failed" && record.agentId && !record.sessionKey) {
      await provision(options, record);
      options.respond(true, publicResult(record));
      return;
    }
    if (record.state !== "pending" || record.expiresAtMs <= Date.now()) {
      record.state = record.expiresAtMs <= Date.now() ? "expired" : record.state;
      options.respond(true, publicResult(record));
      return;
    }
    if (record.planDigest !== options.params.planDigest) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "plan digest mismatch"),
      );
      return;
    }
    // proposalId is the operation id, so retries and duplicate taps always observe one transaction.
    record.idempotencyKey = options.params.idempotencyKey as string;
    await provision(options, record);
    options.respond(true, publicResult(record));
  },

  "agents.provision.dismiss": async (options) => {
    if (!validateAgentsProvisionDismissParams(options.params)) {
      respondInvalidMethodParams(
        options.respond,
        "agents.provision.dismiss",
        validateAgentsProvisionDismissParams.errors,
      );
      return;
    }
    const id = (options.params.proposalId ?? options.params.offerId) as string | undefined;
    const record = id ? findRecord(id) : undefined;
    if (!record) {
      options.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "offer not found"));
      return;
    }
    if (record.subject !== subjectFor(options)) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "offer belongs to a different user"),
      );
      return;
    }
    if (record.state === "offered" || record.state === "pending") {
      record.state = "dismissed";
    }
    options.respond(true, publicResult(record));
  },

  "agents.provision.operation.get": async (options) => {
    if (!validateAgentsProvisionOperationGetParams(options.params)) {
      respondInvalidMethodParams(
        options.respond,
        "agents.provision.operation.get",
        validateAgentsProvisionOperationGetParams.errors,
      );
      return;
    }
    const record = findRecord(options.params.operationId as string);
    if (!record) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "operation not found"),
      );
      return;
    }
    if (record.subject !== subjectFor(options)) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "operation belongs to a different user"),
      );
      return;
    }
    options.respond(true, publicResult(record));
  },
};
