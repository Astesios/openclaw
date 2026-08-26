import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { RunBindingStore } from "./src/bindings.js";
import {
  createAssistRequest,
  FlowosExecutionClient,
  resolveTrustedAssistEndpoint,
} from "./src/client.js";
import { FlowosExecutionRuntime } from "./src/runtime.js";
import { createFlowosExecutionTools } from "./src/tools.js";

const pluginId = "flowos-execution-runtime";
const bindingNamespace = "run-bindings";

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
    const token = process.env.LONG_TASK_EXECUTION_TOKEN?.trim() ?? "";
    const ownerAgentId = normalizeOwnerAgentId(process.env.LONG_TASK_EXECUTION_AGENT_ID);
    const bindings = new RunBindingStore(
      api.runtime.state.openKeyedStore({
        namespace: bindingNamespace,
        maxEntries: 4096,
        defaultTtlMs: 6 * 60 * 60 * 1_000,
      }),
    );
    const client =
      endpoint && token ? new FlowosExecutionClient(createAssistRequest(endpoint, token)) : null;
    const runtime =
      client && ownerAgentId
        ? new FlowosExecutionRuntime(client, bindings, api.runtime.subagent, api.logger)
        : null;

    api.registerTool(
      (context) =>
        client && ownerAgentId
          ? createFlowosExecutionTools({ api, context, client, bindings, ownerAgentId })
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

    api.on("subagent_spawned", async (event, ctx) => {
      await runtime?.subagentSpawned(event, ctx);
    });
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
