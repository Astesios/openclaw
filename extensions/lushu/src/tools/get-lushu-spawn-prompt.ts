import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { buildSpawnTaskPrompt, type SpawnPromptInput, type StyleKey } from "../spawn-guide.js";

type Params = {
  outputPath: string;
  style: StyleKey;
  planMdPath: string;
  imagesJsonPath?: string;
  flyaiSummary?: string;
  spaceId?: string;
  stopsByDay?: Array<{ day: number; stops: Array<{ name: string; lnglat: [number, number] }> }>;
};

export function createGetLushuSpawnPromptTool(_ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "get_lushu_spawn_prompt",
    label: "拼 subagent 路书 spawn prompt",
    description:
      "父 Agent 在调 `sessions_spawn` 之前调本工具,拿到 subagent 路书生成 task prompt(已含必读 references 的绝对路径、修复决策、HTML 总要求)。" +
      "返回的字符串直接作为 sessions_spawn 的 prompt 参数。**禁止**父 Agent 自己手拼 spawn prompt(会漏 reference / 漏修复约束)。",
    parameters: {
      type: "object",
      properties: {
        outputPath: {
          type: "string",
          description: "路书 HTML 绝对输出路径,推荐 `<space>/generated/路书.html`",
        },
        style: {
          type: "string",
          enum: ["minimalist", "elegant", "scrapbook", "dynamic", "imperial"],
          description:
            "风格 key,由父 Agent 按目的地自动选(自然→minimalist, 古城→elegant, 乐园→scrapbook, 都市→dynamic, 古都→imperial)",
        },
        planMdPath: {
          type: "string",
          description: "原始行程规划 markdown 绝对路径(让 subagent read 全文,不要 paste 概要)",
        },
        imagesJsonPath: {
          type: "string",
          description: "fetch_images tool 输出的 images.json 绝对路径",
        },
        flyaiSummary: {
          type: "string",
          description:
            "query_flyai 返回数据的人类可读摘要(航班/酒店/景点价格 + 链接),inline 进 prompt 让 subagent 直接用",
        },
        spaceId: {
          type: "string",
          description: "任务空间 id(如有)",
        },
        stopsByDay: {
          type: "array",
          items: {
            type: "object",
            properties: {
              day: { type: "number" },
              stops: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    lnglat: { type: "array", items: { type: "number" } },
                  },
                  required: ["name", "lnglat"],
                },
              },
            },
            required: ["day", "stops"],
          },
          description:
            "每 day 的站点经纬度列表(给 render_map_block --mode day 用);不传则 subagent 自行从规划 md 推导",
        },
      },
      required: ["outputPath", "style", "planMdPath"],
    },
    async execute(_toolCallId: string, params: Params) {
      const input: SpawnPromptInput = {
        outputPath: params.outputPath,
        style: params.style,
        planMdPath: params.planMdPath,
        imagesJsonPath: params.imagesJsonPath,
        flyaiSummary: params.flyaiSummary,
        spaceId: params.spaceId,
        stopsByDay: params.stopsByDay,
      };
      const prompt = buildSpawnTaskPrompt(input);
      return {
        content: [{ type: "text" as const, text: prompt }],
        details: { prompt, length: prompt.length },
      };
    },
  };
}
