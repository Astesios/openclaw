import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { runCommand, scriptPath } from "../exec/run.js";

type Params = {
  path: string;
};

type ParsedValidation = {
  exit: number;
  passes: string[];
  fails: string[];
  warns: string[];
  rawStdout: string;
};

export function parseValidatorOutput(stdout: string, exitCode: number): ParsedValidation {
  const passes: string[] = [];
  const fails: string[] = [];
  const warns: string[] = [];
  for (const lineRaw of stdout.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("✅")) {
      passes.push(line.slice(1).trim());
    } else if (line.startsWith("❌")) {
      fails.push(line.slice(1).trim());
    } else if (line.startsWith("⚠️")) {
      warns.push(line.slice(2).trim());
    }
  }
  return { exit: exitCode, passes, fails, warns, rawStdout: stdout };
}

export function createValidateLushuTool(_ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "validate_lushu",
    label: "验证路书 HTML",
    description:
      "包 validate-lushu.sh 跑路书规范检查(12 项 check)。" +
      "等价 `bash validate-lushu.sh <path>`,但 stdout 已解析成 passes / fails / warns 三个列表方便 Agent 决策。" +
      "exit code: 0=全 PASS,1=有 FAIL(必须修复),2=仅 WARN(语义判断),3=参数 / 文件错误。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "路书 HTML 文件绝对路径。",
        },
      },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: Params) {
      const result = await runCommand("bash", [scriptPath("validate-lushu.sh"), params.path], {
        timeoutMs: 30_000,
      });
      const parsed = parseValidatorOutput(result.stdout, result.exitCode);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
        details: parsed,
      };
    },
  };
}
