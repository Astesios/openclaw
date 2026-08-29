import { createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { injectMessageBySessionKey } from "openclaw/plugin-sdk/celia-card-inject";
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
import { validateSpaceArtifact } from "./src/validation.js";

const pluginId = "flowos-execution-runtime";
const bindingNamespace = "run-bindings";
const executionRuntimePurpose = "flowos-execution-runtime-v1";
const standardOwnerAgentId = "agent:main";

type ResultCardParams = {
  sessionKey: string;
  executionId: string;
  attemptId: string;
  spaceId: string;
  artifactTitle: string;
  artifactFilePath: string;
  caption: string;
};

export async function deliverExecutionResultCard(
  params: ResultCardParams,
  inject: typeof injectMessageBySessionKey = injectMessageBySessionKey,
): Promise<void> {
  const cardJson = JSON.stringify({
    type: "resource_card",
    resourceType: "file",
    id: params.spaceId,
    title: params.artifactTitle,
    filePath: params.artifactFilePath,
    action: "create",
    caption: params.caption,
  });
  const delivered = await inject(params.sessionKey, `[celia_card]${cardJson}`, undefined, {
    idempotencyKey: `flowos-execution:${params.executionId}:${params.attemptId}:result-card`,
  });
  if (!delivered.ok) {
    throw new Error("FlowOS Execution result card delivery is unavailable");
  }
}

function loadPrivateSecretFile(filePath: string): string {
  if (!filePath) {
    return "";
  }
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      return "";
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return "";
    }
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function deriveExecutionRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const master =
    env.FLOWOS_TASK_CENTER_JWT_SECRET?.trim() ||
    loadPrivateSecretFile(env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE?.trim() ?? "");
  if (Buffer.byteLength(master, "utf8") < 32) {
    return null;
  }
  return createHmac("sha256", master).update(executionRuntimePurpose).digest("hex");
}

export default definePluginEntry({
  id: pluginId,
  name: "FlowOS Execution Runtime",
  description: "Bind standard FlowOS long-task Execution tools to OpenClaw subagent runs",
  register(api) {
    const endpoint = resolveTrustedAssistEndpoint(process.env.ASSIST_API_BASE);
    const token = deriveExecutionRuntimeToken();
    if (!endpoint || !token) {
      throw new Error("FlowOS standard tenant identity config is required");
    }
    const ownerAgentId = standardOwnerAgentId;
    const locks = getExecutionLocks();
    const bindings = new RunBindingStore(
      api.runtime.state.openKeyedStore({
        namespace: bindingNamespace,
        maxEntries: 4096,
      }),
    );
    const client = new FlowosExecutionClient(createAssistRequest(endpoint, token));
    const runtime = new FlowosExecutionRuntime(
      client,
      bindings,
      api.runtime.subagent,
      api.runtime.system,
      api.logger,
      locks,
    );

    api.registerTool(
      (context) =>
        createFlowosExecutionTools({
          api,
          context,
          client,
          bindings,
          locks,
          runtime,
          ownerAgentId,
          validateArtifact: (params) => {
            const workspaceDir = context.workspaceDir?.trim();
            if (!workspaceDir) {
              throw new Error("FlowOS Execution validator requires a trusted workspace");
            }
            return validateSpaceArtifact({
              runtime: api.runtime,
              workspaceDir,
              ...params,
            });
          },
          deliverResultCard: deliverExecutionResultCard,
        }),
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
      await runtime.subagentEnded(event, ctx);
    });
    api.on("gateway_start", async () => {
      await runtime.reconcile();
      api.logger.info("FlowOS Execution run bindings reconciled");
    });
  },
});
