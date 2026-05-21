import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { runCommand, scriptPath } from "../exec/run.js";

type Params = {
  keywords: string[];
  city?: string;
  outputPath?: string;
  perPage?: number;
};

export function createFetchImagesTool(_ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "fetch_images",
    label: "搜索在线配图",
    description:
      "调 lushu plugin 包的 fetch-images.mjs(Pexels + Unsplash 回退)给路书景点找在线配图 URL。" +
      "等价替代 `node ~/.openclaw/workspace/skills/image-search/fetch-images.mjs --keywords ... --city ... --output ...`。" +
      "默认会把结果 JSON 写到 outputPath,同时 stdout 透传;不传 outputPath 时仅 stdout。",
    parameters: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "景点 / 地点关键词列表(中文 OK,内部映射英文兜底)。",
        },
        city: {
          type: "string",
          description: "城市名(辅助检索 + 选封面)。",
        },
        outputPath: {
          type: "string",
          description:
            "JSON 文件输出绝对路径,推荐 `~/.openclaw/workspace/spaces/{space_id}/generated/images.json`。" +
            "不传则结果只在 stdout 返回,不落盘。",
        },
        perPage: {
          type: "number",
          description: "每个关键词搜几张图,默认 3。",
        },
      },
      required: ["keywords"],
    },
    async execute(_toolCallId: string, params: Params) {
      const args = ["--keywords", params.keywords.join(",")];
      if (params.city) {
        args.push("--city", params.city);
      }
      if (params.outputPath) {
        args.push("--output", params.outputPath);
      }
      if (typeof params.perPage === "number") {
        args.push("--per-page", String(params.perPage));
      }
      args.unshift(scriptPath("fetch-images.mjs"));

      const result = await runCommand(process.execPath, args, { timeoutMs: 90_000 });
      const text =
        result.exitCode === 0
          ? result.stdout
          : JSON.stringify({
              ok: false,
              exitCode: result.exitCode,
              stderr: result.stderr,
            });
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    },
  };
}
