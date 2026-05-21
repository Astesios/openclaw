import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { runCommand, scriptPath } from "../exec/run.js";

type Params = {
  apiBaseUrl?: string;
};

export function createRenderIconsTool(_ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "render_icons",
    label: "渲染图标 CSS",
    description:
      "包 render-icons.mjs,输出整段 <style>...</style> 含 transit-icon / flight-icon 系列 mask-image 定义," +
      "Agent 把整段拷到 <head> 内即可。字节级等价 `node render-icons.mjs`。" +
      "图标源走对外 URL(默认 https://assist.ucblab.com/static/lushu-icons/*.svg),可用 apiBaseUrl 覆盖。",
    parameters: {
      type: "object",
      properties: {
        apiBaseUrl: {
          type: "string",
          description:
            "图标静态资源 URL 前缀(覆盖 API_BASE_URL 环境变量)。一般不传,用 server 默认即可。",
        },
      },
    },
    async execute(_toolCallId: string, params: Params) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (params.apiBaseUrl) {
        env.API_BASE_URL = params.apiBaseUrl;
      }
      const result = await runCommand(process.execPath, [scriptPath("render-icons.mjs")], {
        timeoutMs: 10_000,
        env,
      });
      const text =
        result.exitCode === 0
          ? result.stdout
          : JSON.stringify({ ok: false, exitCode: result.exitCode, stderr: result.stderr });
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ok: result.exitCode === 0,
          html: result.exitCode === 0 ? result.stdout : undefined,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    },
  };
}
