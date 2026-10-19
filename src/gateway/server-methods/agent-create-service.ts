/**
 * Shared agent creation service for the public agents.create RPC and the
 * model-facing agent_creator tool.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { mergeIdentityMarkdownContent } from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  markWorkspaceSetupCompleted,
} from "../../agents/workspace.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError, root } from "../../infra/fs-safe.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { resolveUserPath } from "../../utils.js";
import {
  AgentConfigPreconditionError,
  createAgentConfigEntry,
  isConfiguredAgent,
} from "./agents-config-mutations.js";

const MANAGED_WORKSPACE_FILE_MAX_BYTES = 128 * 1024;
const MANAGED_AVATAR_MAX_BYTES = 8 * 1024 * 1024;

const agentCreateServiceDeps = { root };

export const testing = {
  setDepsForTests(overrides: Partial<{ root: typeof root }>) {
    if (overrides.root) {
      agentCreateServiceDeps.root = overrides.root;
    }
  },
  resetDepsForTests() {
    agentCreateServiceDeps.root = root;
  },
};

type CommonCreateParams = {
  cfg: OpenClawConfig;
  name: string;
  description?: string;
  skills?: string[];
  model?: string;
  emoji?: string;
  avatar?: string;
};

export type LegacyAgentCreateParams = CommonCreateParams & {
  mode: "legacy";
  workspace: string;
};

export type ManagedAgentCreateParams = CommonCreateParams & {
  mode: "managed";
  avatarProfileId: string;
  avatarSourcePath: string;
  workspaceFiles: {
    agents: string;
    soul: string;
    user: string;
    tools: string;
  };
  skillSources?: Array<{
    skillKey: string;
    sourcePath: string;
  }>;
};

export type AgentCreateServiceParams = LegacyAgentCreateParams | ManagedAgentCreateParams;

export type AgentCreateServiceResult = {
  agentId: string;
  name: string;
  workspace: string;
  model?: string;
  skills?: string[];
  avatarProfileId?: string;
};

export class AgentCreateServiceError extends Error {
  constructor(
    readonly kind: "invalid" | "reserved" | "already-exists" | "path-conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentCreateServiceError";
  }
}

function sanitizeIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Derive a stable, path-safe id when a display name contains no Latin id characters. */
export function deriveAgentCreatorId(name: string): string {
  const trimmed = name.trim();
  const normalized = normalizeAgentId(trimmed);
  if (normalized !== DEFAULT_AGENT_ID || trimmed.toLowerCase() === DEFAULT_AGENT_ID) {
    return normalized;
  }
  const digest = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12);
  return `agent-${digest}`;
}

function resolveAgentId(params: AgentCreateServiceParams): string {
  const agentId =
    params.mode === "managed" ? deriveAgentCreatorId(params.name) : normalizeAgentId(params.name);
  if (agentId === DEFAULT_AGENT_ID) {
    throw new AgentCreateServiceError("reserved", `"${DEFAULT_AGENT_ID}" is reserved`);
  }
  if (isConfiguredAgent(params.cfg, agentId)) {
    throw new AgentCreateServiceError("already-exists", `agent "${agentId}" already exists`);
  }
  return agentId;
}

function buildIdentity(params: CommonCreateParams, avatar?: string): IdentityConfig {
  const name = sanitizeIdentityLine(params.name);
  const emoji = params.emoji ? sanitizeIdentityLine(params.emoji) : undefined;
  const resolvedAvatar = avatar ? sanitizeIdentityLine(avatar) : undefined;
  return {
    name,
    ...(emoji ? { emoji } : {}),
    ...(resolvedAvatar ? { avatar: resolvedAvatar } : {}),
  };
}

function buildNextConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
  name: string;
  workspace: string;
  description?: string;
  skills?: string[];
  model?: string;
  identity: IdentityConfig;
}): { nextConfig: OpenClawConfig; agentDir: string } {
  let nextConfig = applyAgentConfig(params.cfg, {
    agentId: params.agentId,
    name: params.name,
    workspace: params.workspace,
    description: params.description,
    skills: params.skills,
    model: params.model,
    identity: params.identity,
  });
  const agentDir = resolveAgentDir(nextConfig, params.agentId);
  nextConfig = applyAgentConfig(nextConfig, { agentId: params.agentId, agentDir });
  return { nextConfig, agentDir };
}

async function commitAgentConfig(params: {
  agentId: string;
  name: string;
  workspace: string;
  description?: string;
  skills?: string[];
  model?: string;
  identity: IdentityConfig;
  agentDir: string;
  skillSymlinkTargets?: string[];
}): Promise<void> {
  await createAgentConfigEntry(params);
}

async function createLegacyAgent(
  params: LegacyAgentCreateParams,
  agentId: string,
): Promise<AgentCreateServiceResult> {
  const name = sanitizeIdentityLine(params.name);
  const workspace = resolveUserPath(params.workspace.trim());
  const identity = buildIdentity(params, params.avatar);
  const { nextConfig, agentDir } = buildNextConfig({
    cfg: params.cfg,
    agentId,
    name,
    workspace,
    description: params.description,
    skills: params.skills,
    model: params.model,
    identity,
  });

  const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
  await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !skipBootstrap,
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

  const workspaceRoot = await agentCreateServiceDeps.root(workspace);
  const persistedIdentity = resolveAgentIdentity(nextConfig, agentId) ?? identity;
  let currentIdentity: string | undefined;
  try {
    const read = await workspaceRoot.read(DEFAULT_IDENTITY_FILENAME, {
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    currentIdentity = read.buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      currentIdentity = undefined;
    } else {
      throw error;
    }
  }
  await workspaceRoot.write(
    DEFAULT_IDENTITY_FILENAME,
    mergeIdentityMarkdownContent(currentIdentity, persistedIdentity),
    { encoding: "utf8" },
  );

  await commitAgentConfig({
    agentId,
    name,
    workspace,
    description: params.description,
    skills: params.skills,
    model: params.model,
    identity,
    agentDir,
  });
  return { agentId, name, workspace, model: params.model, skills: params.skills };
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.lstat(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function validateManagedWorkspaceContent(name: string, content: string): string {
  if (!content.trim()) {
    throw new AgentCreateServiceError("invalid", `${name} must not be empty`);
  }
  if (Buffer.byteLength(content, "utf8") > MANAGED_WORKSPACE_FILE_MAX_BYTES) {
    throw new AgentCreateServiceError("invalid", `${name} exceeds 128 KiB`);
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function validateAvatarSource(sourcePath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new AgentCreateServiceError("invalid", "avatar asset must be a regular owned file");
  }
  if (stat.size <= 0 || stat.size > MANAGED_AVATAR_MAX_BYTES) {
    throw new AgentCreateServiceError("invalid", "avatar asset size is invalid");
  }
}

async function resolveManagedSkillSources(
  sources: ManagedAgentCreateParams["skillSources"],
): Promise<Array<{ skillKey: string; sourcePath: string }>> {
  const resolved: Array<{ skillKey: string; sourcePath: string }> = [];
  const seen = new Set<string>();
  for (const source of sources ?? []) {
    const skillKey = source.skillKey.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(skillKey) || seen.has(skillKey)) {
      throw new AgentCreateServiceError("invalid", `invalid managed Skill key: ${skillKey}`);
    }
    const sourcePath = await fs.realpath(source.sourcePath);
    const stat = await fs.lstat(sourcePath);
    const skillFile = path.join(sourcePath, "SKILL.md");
    const skillStat = await fs.lstat(skillFile);
    if (!stat.isDirectory() || !skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new AgentCreateServiceError(
        "invalid",
        `managed Skill source is unavailable: ${skillKey}`,
      );
    }
    seen.add(skillKey);
    resolved.push({ skillKey, sourcePath });
  }
  return resolved;
}

function withSkillSymlinkTargets(cfg: OpenClawConfig, targets: readonly string[]): OpenClawConfig {
  if (targets.length === 0) {
    return cfg;
  }
  const existing = cfg.skills?.load?.allowSymlinkTargets ?? [];
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      load: {
        ...cfg.skills?.load,
        allowSymlinkTargets: [...new Set([...existing, ...targets])],
      },
    },
  };
}

async function removeOwnedPath(pathname: string): Promise<void> {
  await fs.rm(pathname, { recursive: true, force: true });
}

async function createManagedAgent(
  params: ManagedAgentCreateParams,
  agentId: string,
): Promise<AgentCreateServiceResult> {
  const name = sanitizeIdentityLine(params.name);
  const controlledRoot = path.join(resolveStateDir(), "workspace", "agents");
  const workspace = path.join(controlledRoot, agentId);
  const staging = path.join(controlledRoot, `.${agentId}.staging-${randomUUID()}`);
  const avatarRelativePath = path.posix.join("avatars", `${params.avatarProfileId}.png`);
  const identity = buildIdentity(params, avatarRelativePath);
  const skillSources = await resolveManagedSkillSources(params.skillSources);
  const skillSymlinkTargets = skillSources.map((source) => source.sourcePath);
  const cfgWithSkillTargets = withSkillSymlinkTargets(params.cfg, skillSymlinkTargets);
  const { nextConfig, agentDir } = buildNextConfig({
    cfg: cfgWithSkillTargets,
    agentId,
    name,
    workspace,
    description: params.description,
    skills: params.skills,
    model: params.model,
    identity,
  });
  const agentRoot = path.dirname(agentDir);

  if (await pathExists(workspace)) {
    throw new AgentCreateServiceError("path-conflict", `workspace already exists for "${agentId}"`);
  }
  if (await pathExists(agentRoot)) {
    throw new AgentCreateServiceError(
      "path-conflict",
      `agent state directory already exists for "${agentId}"`,
    );
  }
  await validateAvatarSource(params.avatarSourcePath);
  await fs.mkdir(controlledRoot, { recursive: true });

  let workspaceOwned = false;
  let agentRootOwned = false;
  try {
    await fs.mkdir(staging, { recursive: false });
    const files = [
      [DEFAULT_AGENTS_FILENAME, params.workspaceFiles.agents],
      [DEFAULT_SOUL_FILENAME, params.workspaceFiles.soul],
      [DEFAULT_USER_FILENAME, params.workspaceFiles.user],
      [DEFAULT_TOOLS_FILENAME, params.workspaceFiles.tools],
    ] as const;
    for (const [fileName, content] of files) {
      await fs.writeFile(
        path.join(staging, fileName),
        validateManagedWorkspaceContent(fileName, content),
        { encoding: "utf8", flag: "wx" },
      );
    }
    await fs.writeFile(
      path.join(staging, DEFAULT_IDENTITY_FILENAME),
      mergeIdentityMarkdownContent(undefined, identity),
      { encoding: "utf8", flag: "wx" },
    );
    const avatarDir = path.join(staging, "avatars");
    await fs.mkdir(avatarDir, { recursive: false });
    await fs.copyFile(
      params.avatarSourcePath,
      path.join(avatarDir, `${params.avatarProfileId}.png`),
      fsConstants.COPYFILE_EXCL,
    );
    if (skillSources.length > 0) {
      const skillsDir = path.join(staging, "skills");
      await fs.mkdir(skillsDir, { recursive: false });
      for (const source of skillSources) {
        await fs.symlink(source.sourcePath, path.join(skillsDir, source.skillKey), "dir");
      }
    }

    await fs.rename(staging, workspace);
    workspaceOwned = true;
    await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: false });
    await markWorkspaceSetupCompleted(workspace);

    await fs.mkdir(agentDir, { recursive: true });
    agentRootOwned = true;
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    const status = buildWorkspaceSkillStatus(workspace, {
      config: nextConfig,
      agentId,
    });
    const visibleSkillKeys = new Set(
      status.skills.filter((entry) => entry.modelVisible).map((entry) => entry.skillKey),
    );
    const unavailableSkills = (params.skills ?? []).filter((key) => !visibleSkillKeys.has(key));
    if (unavailableSkills.length > 0) {
      throw new AgentCreateServiceError(
        "invalid",
        `managed Skills are not visible to the new agent: ${unavailableSkills.join(", ")}`,
      );
    }

    await commitAgentConfig({
      agentId,
      name,
      workspace,
      description: params.description,
      skills: params.skills,
      model: params.model,
      identity,
      agentDir,
      skillSymlinkTargets,
    });
    workspaceOwned = false;
    agentRootOwned = false;
    return {
      agentId,
      name,
      workspace,
      model: params.model,
      skills: params.skills,
      avatarProfileId: params.avatarProfileId,
    };
  } catch (error) {
    const cleanupPaths = [
      staging,
      ...(workspaceOwned ? [workspace] : []),
      ...(agentRootOwned ? [agentRoot] : []),
    ];
    const cleanup = await Promise.allSettled(cleanupPaths.map(removeOwnedPath));
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `agent "${agentId}" creation failed and cleanup was incomplete`,
      );
    }
    if (error instanceof AgentConfigPreconditionError) {
      throw new AgentCreateServiceError("already-exists", error.message);
    }
    throw error;
  }
}

/** Create an agent through either the compatible public-RPC path or managed atomic path. */
export async function createAgentWithService(
  params: AgentCreateServiceParams,
): Promise<AgentCreateServiceResult> {
  const name = params.name.trim();
  if (!name) {
    throw new AgentCreateServiceError("invalid", "name is required");
  }
  const agentId = resolveAgentId(params);
  return params.mode === "managed"
    ? createManagedAgent(params, agentId)
    : createLegacyAgent(params, agentId);
}
