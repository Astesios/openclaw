import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { runCommand, scriptPath } from "../exec/run.js";

type Mode = "head" | "day" | "fix-head" | "insert-transit";

type Params = {
  mode: Mode;
  style?: "minimalist" | "elegant" | "scrapbook" | "dynamic" | "imperial";
  day?: number;
  stops?: Array<{ name: string; lnglat: [number, number] }>;
  file?: string;
  afterStop?: number;
  transport?: string;
  duration?: string;
  distance?: string;
  nextStop?: string;
};

async function withTempStopsFile<T>(
  stops: Params["stops"],
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const tmp = path.join(os.tmpdir(), `lushu-stops-${randomUUID()}.json`);
  await fs.writeFile(tmp, JSON.stringify(stops), "utf8");
  try {
    return await fn(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function runRenderMap(args: string[]) {
  return runCommand(process.execPath, [scriptPath("render-map.mjs"), ...args], {
    timeoutMs: 30_000,
  });
}

export function createRenderMapBlockTool(_ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "render_map_block",
    label: "渲染地图块 / 修复地图",
    description:
      "包 render-map.mjs 的 4 种 mode,生成路书 HTML 里地图相关的片段或就地修复地图相关结构。" +
      "字节级等价于直接 `node render-map.mjs --mode ...`,所有命名 / 配色 / 关键值由脚本保证一致。" +
      "\n- mode='head':输出 head 段(高德 SDK 引入 + createLushuMap helper + CSS),拷到 <head> 末尾。" +
      "\n- mode='day':输出某日地图块(map-wrap + script 调 createLushuMap),拷到 day-section 内。需 day + stops。" +
      "\n- mode='fix-head':就地修复(把误粘到 body 的 head 块剪贴回 </head> 前)。需 file。" +
      "\n- mode='insert-transit':就地插入 transit-next 块(验证 WARN 修复用,幂等)。需 file + day + afterStop + transport。",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["head", "day", "fix-head", "insert-transit"],
          description: "渲染或修复模式。",
        },
        style: {
          type: "string",
          enum: ["minimalist", "elegant", "scrapbook", "dynamic", "imperial"],
          description: "风格(head / day 模式可选,默认 minimalist)。决定地图描边色和 mapStyle。",
        },
        day: {
          type: "number",
          description: "第几日(day / insert-transit 模式必填,正整数)。",
        },
        stops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              lnglat: {
                type: "array",
                items: { type: "number" },
                description: "[lng, lat] 经度纬度。",
              },
            },
            required: ["name", "lnglat"],
          },
          description: "当日站点列表(day 模式必填,非空)。",
        },
        file: {
          type: "string",
          description: "要修改的 HTML 文件绝对路径(fix-head / insert-transit 模式必填)。",
        },
        afterStop: {
          type: "number",
          description: "在第几个 timeline-item 之后插入(insert-transit 模式必填,从 1 起)。",
        },
        transport: {
          type: "string",
          description: "交通方式(insert-transit 必填),如 `驾车` `步行` `高铁` `航班`。",
        },
        duration: {
          type: "string",
          description: "时长描述,如 `30min` `1h20min`(insert-transit 可选)。",
        },
        distance: {
          type: "string",
          description: "距离描述,如 `10km`(insert-transit 可选)。",
        },
        nextStop: {
          type: "string",
          description: "下一站名(insert-transit 可选,会渲染成 `→ X`)。",
        },
      },
      required: ["mode"],
    },
    async execute(_toolCallId: string, params: Params) {
      const styleArgs = params.style ? ["--style", params.style] : [];

      if (params.mode === "head") {
        const result = await runRenderMap(["--mode", "head", ...styleArgs]);
        const text =
          result.exitCode === 0
            ? result.stdout
            : JSON.stringify({ ok: false, exitCode: result.exitCode, stderr: result.stderr });
        return {
          content: [{ type: "text" as const, text }],
          details: {
            ok: result.exitCode === 0,
            mode: "head",
            html: result.exitCode === 0 ? result.stdout : undefined,
            exitCode: result.exitCode,
            stderr: result.stderr,
          },
        };
      }

      if (params.mode === "day") {
        if (
          typeof params.day !== "number" ||
          !Array.isArray(params.stops) ||
          params.stops.length === 0
        ) {
          const err = "render_map_block mode=day requires day(number) and non-empty stops[]";
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: err }) }],
            details: { ok: false, error: err },
          };
        }
        return withTempStopsFile(params.stops, async (stopsFile) => {
          const result = await runRenderMap([
            "--mode",
            "day",
            "--day",
            String(params.day),
            "--stops-file",
            stopsFile,
            ...styleArgs,
          ]);
          const text =
            result.exitCode === 0
              ? result.stdout
              : JSON.stringify({ ok: false, exitCode: result.exitCode, stderr: result.stderr });
          return {
            content: [{ type: "text" as const, text }],
            details: {
              ok: result.exitCode === 0,
              mode: "day",
              day: params.day,
              html: result.exitCode === 0 ? result.stdout : undefined,
              exitCode: result.exitCode,
              stderr: result.stderr,
            },
          };
        });
      }

      if (params.mode === "fix-head") {
        if (!params.file) {
          const err = "render_map_block mode=fix-head requires file(string)";
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: err }) }],
            details: { ok: false, error: err },
          };
        }
        const result = await runRenderMap(["--mode", "fix-head", "--file", params.file]);
        return {
          content: [{ type: "text" as const, text: result.stdout || result.stderr }],
          details: {
            ok: result.exitCode === 0,
            mode: "fix-head",
            file: params.file,
            log: result.stdout,
            exitCode: result.exitCode,
            stderr: result.stderr,
          },
        };
      }

      if (params.mode === "insert-transit") {
        if (
          !params.file ||
          typeof params.day !== "number" ||
          typeof params.afterStop !== "number" ||
          !params.transport
        ) {
          const err =
            "render_map_block mode=insert-transit requires file + day(number) + afterStop(number) + transport(string)";
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: err }) }],
            details: { ok: false, error: err },
          };
        }
        const args = [
          "--mode",
          "insert-transit",
          "--file",
          params.file,
          "--day",
          String(params.day),
          "--after-stop",
          String(params.afterStop),
          "--transport",
          params.transport,
        ];
        if (params.duration) {
          args.push("--duration", params.duration);
        }
        if (params.distance) {
          args.push("--distance", params.distance);
        }
        if (params.nextStop) {
          args.push("--next-stop", params.nextStop);
        }
        const result = await runRenderMap(args);
        return {
          content: [{ type: "text" as const, text: result.stdout || result.stderr }],
          details: {
            ok: result.exitCode === 0,
            mode: "insert-transit",
            file: params.file,
            day: params.day,
            afterStop: params.afterStop,
            log: result.stdout,
            exitCode: result.exitCode,
            stderr: result.stderr,
          },
        };
      }

      const err = `unknown mode: ${(params as { mode?: string }).mode ?? ""}`;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: err }) }],
        details: { ok: false, error: err },
      };
    },
  };
}
