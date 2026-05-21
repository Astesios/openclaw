import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { CommandNotFoundError, runCommand } from "../exec/run.js";
import { normalizePriceFieldsDeep } from "../normalize/price.js";
import { stripInsecureUrlFieldsDeep } from "../normalize/url.js";

type FlyaiKind = "search-flight" | "search-train" | "search-hotel" | "search-poi";

type Query = {
  kind: FlyaiKind;
  params: Record<string, string>;
};

type Params = {
  queries: Query[];
};

type ResultEntry =
  | { kind: FlyaiKind; ok: true; data: unknown }
  | { kind: FlyaiKind; ok: false; error: string; exitCode?: number; stderr?: string }
  | { kind: FlyaiKind; ok: false; degraded: { reason: string } };

function flattenParams(params: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    out.push(`--${k}`, v);
  }
  return out;
}

async function runOne(q: Query): Promise<ResultEntry> {
  try {
    const result = await runCommand("flyai", [q.kind, ...flattenParams(q.params)], {
      timeoutMs: 45_000,
    });
    if (result.exitCode !== 0) {
      return {
        kind: q.kind,
        ok: false,
        error: `flyai ${q.kind} exited ${result.exitCode}`,
        exitCode: result.exitCode,
        stderr: result.stderr,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch (e) {
      return {
        kind: q.kind,
        ok: false,
        error: `failed to parse flyai stdout as JSON: ${(e as Error).message}`,
        stderr: result.stdout.slice(0, 500),
      };
    }
    const data = stripInsecureUrlFieldsDeep(normalizePriceFieldsDeep(raw));
    return { kind: q.kind, ok: true, data };
  } catch (e) {
    if (e instanceof CommandNotFoundError) {
      return {
        kind: q.kind,
        ok: false,
        degraded: { reason: "flyai CLI not found on PATH" },
      };
    }
    return {
      kind: q.kind,
      ok: false,
      error: (e as Error).message,
    };
  }
}

export function createQueryFlyaiTool(_ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "query_flyai",
    label: "查 FlyAI 真实出行数据",
    description:
      "并发批量调外部 `flyai` CLI 查航班 / 火车 / 酒店 / POI 真实数据。" +
      "tool 内部已做 `¥Nxx → ¥N00+/晚` 价格归一化和非 https 链接字段剥离,Agent 拿到的数据可直接拼进 HTML,不需要再写正则。" +
      "等价替代当前 SKILL.md 教 Agent 写的 `flyai search-* ...` heredoc 批量。" +
      "若 flyai 不在 PATH,返回 result.ok=false + degraded.reason,不抛错。",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["search-flight", "search-train", "search-hotel", "search-poi"],
                description: "flyai 子命令名。",
              },
              params: {
                type: "object",
                additionalProperties: { type: "string" },
                description:
                  "传给 flyai 的 `--key value` 参数对(直接对应 CLI flag),如 " +
                  "`{origin: '深圳', destination: '秦皇岛', 'dep-date': '2026-02-01'}`。",
              },
            },
            required: ["kind", "params"],
          },
          description: "并发执行的多条查询。建议把跨城段 / 酒店 / POI 一次性传进来。",
        },
      },
      required: ["queries"],
    },
    async execute(_toolCallId: string, params: Params) {
      const results = await Promise.all(params.queries.map(runOne));
      const allDegraded = results.length > 0 && results.every((r) => "degraded" in r);
      const payload = {
        results,
        ...(allDegraded ? { degraded: { reason: "flyai CLI not found on PATH" } } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  };
}
