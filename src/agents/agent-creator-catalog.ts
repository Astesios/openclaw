import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { getRemoteSkillEligibility } from "../skills/runtime/remote.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import { canExecRequestNode } from "./exec-defaults.js";

export type AgentCreatorAvatar = {
  id: string;
  name: string;
  file: string;
  description: string;
};

type AvatarCatalogFile = {
  version: number;
  avatars: AgentCreatorAvatar[];
};

export async function loadAgentCreatorCatalog(workspaceDir: string, agentId?: string) {
  const cfg = getRuntimeConfig();
  const resolvedWorkspace = agentId ? resolveAgentWorkspaceDir(cfg, agentId) : workspaceDir;
  const report = buildWorkspaceSkillStatus(resolvedWorkspace, {
    config: cfg,
    agentId,
    eligibility: agentId
      ? {
          remote: getRemoteSkillEligibility({
            advertiseExecNode: canExecRequestNode({ cfg, agentId }),
          }),
        }
      : undefined,
  });
  const creatorSkill = report.skills.find(
    (entry) => entry.skillKey === "agent-creator" || entry.name === "agent-creator",
  );
  if (!creatorSkill) {
    throw new Error("agent-creator Skill is not discoverable");
  }
  const assetsDir = path.join(creatorSkill.baseDir, "assets", "avatars");
  const raw = await fs.readFile(path.join(assetsDir, "catalog.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<AvatarCatalogFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.avatars) || parsed.avatars.length === 0) {
    throw new Error("agent-creator avatar catalog is invalid");
  }
  const seen = new Set<string>();
  const avatars = parsed.avatars.map((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.file !== "string" ||
      typeof entry.description !== "string" ||
      !entry.id.trim() ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id) ||
      !entry.name.trim() ||
      !entry.file.trim() ||
      seen.has(entry.id)
    ) {
      throw new Error("agent-creator avatar catalog contains an invalid entry");
    }
    seen.add(entry.id);
    const resolvedFile = path.resolve(assetsDir, entry.file);
    const relative = path.relative(assetsDir, resolvedFile);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`avatar catalog file escapes assets directory: ${entry.id}`);
    }
    return {
      id: entry.id.trim(),
      name: entry.name.trim(),
      file: entry.file.trim(),
      description: entry.description.trim(),
    };
  });
  return {
    cfg,
    report,
    availableSkills: report.skills.filter(
      (entry) => entry.eligible && entry.modelVisible && !entry.disabled,
    ),
    avatars,
    assetsDir,
  };
}
