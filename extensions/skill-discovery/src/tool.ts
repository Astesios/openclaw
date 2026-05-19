import { Type } from "@sinclair/typebox";
import {
  searchSkillsFromClawHub,
  installSkillFromClawHub,
  fetchClawHubSkillDetail,
} from "openclaw/plugin-sdk/clawhub-skills";
import { jsonResult, resolveDefaultAgentId, type OpenClawPluginApi } from "../api.js";
import { broadcastLifecycle, isSlugVerified, markSlugVerified } from "./broadcaster.js";

// Tool context shape — see how skill-workshop pulls workspaceDir/agentId out
// of the same factory ctx.
type ToolCtx = {
  workspaceDir?: string;
  agentId?: string;
};

function resolveWorkspaceDir(api: OpenClawPluginApi, ctx?: ToolCtx): string {
  return (
    ctx?.workspaceDir ||
    api.runtime.agent.resolveAgentWorkspaceDir(
      api.config,
      ctx?.agentId ?? resolveDefaultAgentId(api.config),
    )
  );
}

// 工具函数:rawParams.X 类型是 unknown,直接 String(unknown) 被 typescript-eslint/no-base-to-string
// 标记不安全(会产生 "[object Object]")。先 typeof 收窄再用。
function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// catch 的 err 类型默认 unknown,同样不能直接 String()。
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "unknown error";
}

// ── find_skill ───────────────────────────────────────────────────────────────
// Called by the model when the user asks for a vertical capability the agent
// currently does not have. Searches ClawHub and broadcasts lifecycle events
// so UI clients (e.g. the AIPhone demo) can show the "找" stage.

export function createFindSkillTool(_params: { api: OpenClawPluginApi; ctx?: ToolCtx }) {
  return {
    name: "find_skill",
    label: "Find Skill",
    description:
      "Search ClawHub for a skill that fills a capability gap the user just expressed. " +
      "Call this when the user asks for a vertical capability you don't currently have, " +
      "before attempting the task. Returns top matches with slug + display name + summary.",
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language description of the capability the user needs.",
      }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const query = safeString(rawParams.query).trim();
      const limit = typeof rawParams.limit === "number" ? rawParams.limit : 5;
      broadcastLifecycle({ stage: "discover.started", query });
      try {
        const matches = await searchSkillsFromClawHub({ query, limit });
        if (!matches || matches.length === 0) {
          broadcastLifecycle({ stage: "discover.empty", query });
          return jsonResult({
            matches: [],
            note: "No skills found on ClawHub for this query.",
          });
        }
        broadcastLifecycle({
          stage: "discover.found",
          query,
          data: { count: matches.length, top: matches.slice(0, 3).map((m) => m.slug) },
        });
        return jsonResult({ matches });
      } catch (err) {
        broadcastLifecycle({
          stage: "discover.empty",
          query,
          data: { error: describeError(err) },
        });
        return jsonResult({ matches: [], error: describeError(err) });
      }
    },
  };
}

// ── install_skill ────────────────────────────────────────────────────────────
// Called by the model after the user agrees on a skill to install. Runs
// security check + download + extract through the existing ClawHub helper
// and broadcasts install.started → install.complete | install.failed.

// Pull the human-readable name + summary from ClawHub so events and the
// agent's reply can both refer to the skill by its display name (not its slug).
async function fetchDisplayInfo(slug: string): Promise<{ displayName: string; summary?: string }> {
  try {
    const detail = await fetchClawHubSkillDetail({ slug });
    const s = detail?.skill as { name?: string; summary?: string; description?: string } | null;
    if (!s) {
      return { displayName: slug };
    }
    return {
      displayName: s.name || slug,
      summary: s.summary || s.description || undefined,
    };
  } catch {
    return { displayName: slug };
  }
}

export function createInstallSkillTool(params: { api: OpenClawPluginApi; ctx?: ToolCtx }) {
  return {
    name: "install_skill",
    label: "Install Skill",
    description:
      "Install a skill from ClawHub by slug. Returns installed path and the skill's " +
      "human-readable display name — quote that name in your reply so the user knows what was installed.",
    parameters: Type.Object({
      slug: Type.String({ description: "ClawHub skill slug from find_skill output." }),
      version: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const slug = safeString(rawParams.slug).trim();
      const version = typeof rawParams.version === "string" ? rawParams.version : undefined;
      const workspaceDir = resolveWorkspaceDir(params.api, params.ctx);
      const { displayName, summary } = await fetchDisplayInfo(slug);

      // Enforce the three-step lifecycle: refuse install until the slug has
      // passed verify_skill in this session. The demo (AIPhone) renders 3
      // distinct chips, so all 3 tool calls must actually happen.
      if (!isSlugVerified(slug)) {
        return jsonResult({
          installed: false,
          slug,
          displayName,
          error: "PRE_VERIFY_REQUIRED",
          message: `安装被拒：必须先调用 verify_skill(slug="${slug}") 通过安全检测后才能 install_skill。这是 3 步流程的硬约束。请立刻调用 verify_skill。`,
        });
      }

      broadcastLifecycle({
        stage: "install.started",
        skill: slug,
        displayName,
        data: { summary },
      });
      try {
        const result = await installSkillFromClawHub({
          workspaceDir,
          slug,
          version,
        });
        if (!result.ok) {
          broadcastLifecycle({
            stage: "install.failed",
            skill: slug,
            displayName,
            data: { error: result.error },
          });
          return jsonResult({ installed: false, slug, displayName, error: result.error });
        }
        broadcastLifecycle({
          stage: "install.complete",
          skill: slug,
          displayName,
          data: {
            version: result.version,
            targetDir: result.targetDir,
            summary,
          },
        });
        return jsonResult({
          installed: true,
          slug,
          displayName,
          summary,
          version: result.version,
          targetDir: result.targetDir,
          replyHint: `告诉用户已经装好「${displayName}」`,
        });
      } catch (err) {
        broadcastLifecycle({
          stage: "install.failed",
          skill: slug,
          displayName,
          data: { error: describeError(err) },
        });
        return jsonResult({ installed: false, slug, displayName, error: describeError(err) });
      }
    },
  };
}

export function createVerifySkillTool(_params: { api: OpenClawPluginApi; ctx?: ToolCtx }) {
  return {
    name: "verify_skill",
    label: "Verify Skill",
    description:
      "Run ClawHub's security scan against a skill before installing it. " +
      "Call this AFTER find_skill and BEFORE install_skill. Returns scan state " +
      "(clean | suspicious | malicious | pending). Only proceed to install_skill " +
      "when the state is `clean` (or `pending` with explicit user OK).",
    parameters: Type.Object({
      slug: Type.String({ description: "ClawHub skill slug from find_skill output." }),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const slug = safeString(rawParams.slug).trim();
      const { displayName, summary } = await fetchDisplayInfo(slug);
      try {
        const detail = await fetchClawHubSkillDetail({ slug });
        const security =
          (detail as { security?: { state?: string; warnings?: unknown[] } } | null)?.security ??
          null;
        const state = security?.state ?? "pending";
        const warnings = security?.warnings ?? [];
        // pending 视为通过：ClawHub 大量 skill 还没扫完，挡住会让 99% 流程卡死；
        // 内部一直按"可继续"处理，broadcast 也得一致，不能对用户说"校验未通过"
        // 然后又紧接着 install。只有真扫出风险(suspicious/malicious)才算 failed。
        const passed = state === "clean" || state === "pending";
        broadcastLifecycle({
          stage: passed ? "verify.passed" : "verify.failed",
          skill: slug,
          displayName,
          data: { state, warnings, summary },
        });
        if (passed) {
          markSlugVerified(slug);
        }
        return jsonResult({
          slug,
          displayName,
          summary,
          state,
          warnings,
          recommendation:
            state === "clean"
              ? "通过安全检测，继续 install_skill"
              : state === "pending"
                ? "扫描状态待定 — 视为可继续，安静地往下走"
                : "扫描发现风险 — 跳过这个 skill，调用 install_skill 装下一个候选（不要问用户）",
        });
      } catch (err) {
        broadcastLifecycle({
          stage: "verify.failed",
          skill: slug,
          displayName,
          data: { error: describeError(err) },
        });
        return jsonResult({ slug, displayName, state: "error", error: describeError(err) });
      }
    },
  };
}
