import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { RunBindingStore } from "./src/bindings.js";
import {
  createAssistRequest,
  FlowosExecutionClient,
  resolveTrustedAssistEndpoint,
} from "./src/client.js";
import { getExecutionLocks } from "./src/locks.js";
import { FlowosExecutionRuntime } from "./src/runtime.js";
import { createFlowosExecutionTools } from "./src/tools.js";

const pluginId = "flowos-execution-runtime";
const bindingNamespace = "run-bindings";
const runtimeSecretSymbol = Symbol.for("openclaw.flowosExecutionRuntimeSecret");

type RuntimeSecretState = { token?: string };

function runtimeSecretState(): RuntimeSecretState {
  const root = globalThis as typeof globalThis & { [runtimeSecretSymbol]?: RuntimeSecretState };
  return (root[runtimeSecretSymbol] ??= {});
}

export function clearRuntimeSecretForTest(): void {
  delete runtimeSecretState().token;
}

export function consumeRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const state = runtimeSecretState();
  if (state.token) {
    return state.token;
  }
  if (env.LONG_TASK_EXECUTION_TOKEN?.trim()) {
    return null;
  }
  const filePath = env.LONG_TASK_EXECUTION_TOKEN_FILE?.trim() ?? "";
  if (!filePath || !isAbsolute(filePath)) {
    return null;
  }
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 32 || stat.size > 4096) {
      return null;
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return null;
    }
    const token = readFileSync(filePath, "utf8").trim();
    if (token.length < 32 || token.length > 512) {
      return null;
    }
    state.token = token;
    return token;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      // Another registry in this process may already have consumed the one-shot file.
    }
  }
}

export function normalizeOwnerAgentId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return /^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : null;
}

export default definePluginEntry({
  id: pluginId,
  name: "FlowOS Execution Runtime",
  description: "Bind standard FlowOS long-task Execution tools to OpenClaw subagent runs",
  register(api) {
    const endpoint = resolveTrustedAssistEndpoint(process.env.ASSIST_API_BASE);
    const token = consumeRuntimeToken();
    const ownerAgentId = normalizeOwnerAgentId(process.env.LONG_TASK_EXECUTION_AGENT_ID);
    const locks = getExecutionLocks();
    const bindings = new RunBindingStore(
      api.runtime.state.openKeyedStore({
        namespace: bindingNamespace,
        maxEntries: 4096,
      }),
    );
    const client =
      endpoint && token ? new FlowosExecutionClient(createAssistRequest(endpoint, token)) : null;
    const runtime =
      client && ownerAgentId
        ? new FlowosExecutionRuntime(
            client,
            bindings,
            api.runtime.subagent,
            api.runtime.system,
            api.logger,
            locks,
          )
        : null;

    api.registerTool(
      (context) =>
        client && ownerAgentId && runtime
          ? createFlowosExecutionTools({
              api,
              context,
              client,
              bindings,
              locks,
              runtime,
              ownerAgentId,
            })
          : null,
      {
        names: [
          "flowos_execution_start",
          "flowos_execution_stage",
          "flowos_execution_spawn",
          "flowos_execution_complete",
          "flowos_execution_fail",
        ],
      },
    );

    api.on("subagent_ended", async (event, ctx) => {
      await runtime?.subagentEnded(event, ctx);
    });
    api.on("gateway_start", async () => {
      if (!runtime) {
        api.logger.warn(
          "FlowOS Execution tools are disabled because private runtime config is missing",
        );
        return;
      }
      await runtime.reconcile();
      api.logger.info("FlowOS Execution run bindings reconciled");
    });
  },
});
