/** Model-facing catalog and confirmed creation tool for the agent-creator Skill. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentWithService,
  type AgentCreateServiceResult,
} from "../../gateway/server-methods/agent-create-service.js";
import { loadAgentCreatorCatalog } from "../agent-creator-catalog.js";
import { stringEnum } from "../schema/typebox.js";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const AgentCreatorToolSchema = Type.Object(
  {
    action: stringEnum(["catalog", "prepare", "create"] as const, {
      description:
        "catalog reads current model-visible Skills and built-in avatars; prepare stores the draft before showing it to the user; create consumes that pending draft after a later owner turn confirms it.",
    }),
    confirmation_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    skill_keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 128 })),
    avatar_profile_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    emoji: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    agents_md: Type.Optional(Type.String({ minLength: 1, maxLength: 131072 })),
    soul_md: Type.Optional(Type.String({ minLength: 1, maxLength: 131072 })),
    user_md: Type.Optional(Type.String({ minLength: 1, maxLength: 131072 })),
    tools_md: Type.Optional(Type.String({ minLength: 1, maxLength: 131072 })),
  },
  { additionalProperties: false },
);

const pendingDraftTtlMs = 30 * 60 * 1000;
const catalogKeys = new Set(["action"]);
const prepareKeys = new Set([
  "action",
  "name",
  "description",
  "skill_keys",
  "avatar_profile_id",
  "emoji",
  "agents_md",
  "soul_md",
  "user_md",
  "tools_md",
]);
const createKeys = new Set(["action", "confirmation_id"]);

type PendingAgentDraft = {
  confirmationId: string;
  preparedRunId: string;
  expiresAtMs: number;
  name: string;
  description: string;
  skillKeys: string[];
  avatarProfileId: string;
  emoji: string;
  workspaceFiles: {
    agents: string;
    soul: string;
    user: string;
    tools: string;
  };
};

const pendingDrafts = new Map<string, PendingAgentDraft>();

function requireExactKeys(params: Record<string, unknown>, expected: ReadonlySet<string>): void {
  if (
    Object.keys(params).length !== expected.size ||
    Object.keys(params).some((key) => !expected.has(key))
  ) {
    throw new ToolInputError("agent_creator received fields that do not match its action");
  }
}

function readSkillKeys(params: Record<string, unknown>): string[] {
  const raw = params.skill_keys;
  if (!Array.isArray(raw)) {
    throw new ToolInputError("skill_keys required");
  }
  const keys = raw.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new ToolInputError("skill_keys must contain non-empty strings");
    }
    return value.trim();
  });
  if (new Set(keys).size !== keys.length) {
    throw new ToolInputError("skill_keys contains duplicates");
  }
  return keys;
}

export function createAgentCreatorTool(options: {
  workspaceDir: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  senderIsOwner?: boolean;
}): AnyAgentTool {
  return {
    name: "agent_creator",
    label: "Agent Creator",
    displaySummary: "Prepare or create a new agent",
    description:
      "Read the real Skill/avatar catalog, register a pending draft, or atomically create it. Always call prepare before showing the draft; create is accepted only in a later owner turn after explicit chat confirmation.",
    parameters: AgentCreatorToolSchema,
    execute: async (_toolCallId, input) => {
      const params = asToolParamsRecord(input);
      const action = readStringParam(params, "action", { required: true });
      const { cfg, availableSkills, avatars, assetsDir } = await loadAgentCreatorCatalog(
        options.workspaceDir,
        options.agentId,
      );

      if (action === "catalog") {
        requireExactKeys(params, catalogKeys);
        return jsonResult({
          skills: availableSkills.map((entry) => ({
            skill_key: entry.skillKey,
            name: entry.name,
            description: entry.description,
          })),
          avatars: avatars.map(({ id, name, description }) => ({
            id,
            name,
            description,
          })),
        });
      }
      if (action !== "prepare" && action !== "create") {
        throw new ToolInputError(`unsupported agent_creator action: ${action}`);
      }

      const sessionKey = options.sessionKey?.trim();
      const runId = options.runId?.trim();
      if (!sessionKey || !runId || options.senderIsOwner !== true) {
        throw new ToolInputError("agent_creator confirmation requires an owner chat session");
      }

      if (action === "create") {
        requireExactKeys(params, createKeys);
        const confirmationId = readStringParam(params, "confirmation_id", { required: true });
        const pending = pendingDrafts.get(sessionKey);
        if (
          !pending ||
          pending.confirmationId !== confirmationId ||
          pending.expiresAtMs <= Date.now()
        ) {
          pendingDrafts.delete(sessionKey);
          throw new ToolInputError("confirmed agent draft is missing or expired; prepare it again");
        }
        if (pending.preparedRunId === runId) {
          throw new ToolInputError(
            "agent draft cannot be created in the same run that prepared it; wait for explicit user confirmation",
          );
        }
        pendingDrafts.delete(sessionKey);

        const availableByKey = new Map(availableSkills.map((entry) => [entry.skillKey, entry]));
        const unavailable = pending.skillKeys.filter((key) => !availableByKey.has(key));
        if (unavailable.length > 0) {
          throw new ToolInputError(
            `unknown, disabled, or unavailable Skills: ${unavailable.join(", ")}`,
          );
        }
        const avatar = avatars.find((entry) => entry.id === pending.avatarProfileId);
        if (!avatar) {
          throw new ToolInputError(`unknown avatar_profile_id: ${pending.avatarProfileId}`);
        }
        const result: AgentCreateServiceResult = await createAgentWithService({
          mode: "managed",
          cfg,
          name: pending.name,
          description: pending.description,
          skills: pending.skillKeys,
          skillSources: pending.skillKeys.flatMap((key) => {
            const entry = availableByKey.get(key);
            return entry &&
              (entry.source === "openclaw-workspace" || entry.source === "agents-skills-project")
              ? [{ skillKey: key, sourcePath: entry.baseDir }]
              : [];
          }),
          avatarProfileId: pending.avatarProfileId,
          avatarSourcePath: path.resolve(assetsDir, avatar.file),
          emoji: pending.emoji,
          workspaceFiles: pending.workspaceFiles,
        });
        return jsonResult({
          agent_id: result.agentId,
          display_name: result.name,
          workspace: result.workspace,
          skill_keys: result.skills ?? [],
          avatar_profile_id: result.avatarProfileId,
        });
      }

      requireExactKeys(params, prepareKeys);

      const skillKeys = readSkillKeys(params);
      const availableByKey = new Map(availableSkills.map((entry) => [entry.skillKey, entry]));
      const unavailable = skillKeys.filter((key) => !availableByKey.has(key));
      if (unavailable.length > 0) {
        throw new ToolInputError(
          `unknown, disabled, or unavailable Skills: ${unavailable.join(", ")}`,
        );
      }

      const avatarProfileId = readStringParam(params, "avatar_profile_id", { required: true });
      const avatar = avatars.find((entry) => entry.id === avatarProfileId);
      if (!avatar) {
        throw new ToolInputError(`unknown avatar_profile_id: ${avatarProfileId}`);
      }

      const confirmationId = `agent-draft-${randomUUID()}`;
      const expiresAtMs = Date.now() + pendingDraftTtlMs;
      pendingDrafts.set(sessionKey, {
        confirmationId,
        preparedRunId: runId,
        expiresAtMs,
        name: readStringParam(params, "name", { required: true }),
        description: readStringParam(params, "description", { required: true }),
        skillKeys,
        avatarProfileId,
        emoji: readStringParam(params, "emoji", { required: true }),
        workspaceFiles: {
          agents: readStringParam(params, "agents_md", { required: true, trim: false }),
          soul: readStringParam(params, "soul_md", { required: true, trim: false }),
          user: readStringParam(params, "user_md", { required: true, trim: false }),
          tools: readStringParam(params, "tools_md", { required: true, trim: false }),
        },
      });
      return jsonResult({
        status: "pending_confirmation",
        confirmation_id: confirmationId,
        expires_at_ms: expiresAtMs,
      });
    },
  };
}
