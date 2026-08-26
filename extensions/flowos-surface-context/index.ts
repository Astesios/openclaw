import { createHash } from "node:crypto";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearRuntimeSecretForTest,
  consumeRuntimeToken,
  resolveTrustedAssistEndpoint,
  SurfaceContextClient,
  SurfaceContextClientError,
} from "./src/client.js";
import {
  buildPromptContext,
  canonicalSessionKey,
  createSurfaceContextTools,
  SurfaceContextRuntime,
} from "./src/runtime.js";

export { clearRuntimeSecretForTest, consumeRuntimeToken, resolveTrustedAssistEndpoint };
export { buildPromptContext, canonicalSessionKey, SurfaceContextRuntime };

function normalizedString(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : "";
}

function reject(
  respond: GatewayRequestHandlerOptions["respond"],
  code: string,
  message: string,
): void {
  respond(false, undefined, { code, message });
}

function trustedOperator(client: GatewayRequestHandlerOptions["client"]): boolean {
  return Boolean(
    client?.isDeviceTokenAuth && client.connect.role === "operator" && client.connect.device?.id,
  );
}

function sessionAuditHash(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

export default definePluginEntry({
  id: "flowos-surface-context",
  name: "FlowOS Surface Context",
  description: "Bind pointer-only phone Surface Context to one trusted OpenClaw session",
  register(api) {
    const endpoint = resolveTrustedAssistEndpoint(process.env.ASSIST_API_BASE);
    const token = consumeRuntimeToken();
    const runtime =
      endpoint && token
        ? new SurfaceContextRuntime(new SurfaceContextClient(endpoint, token), api.config)
        : null;

    api.registerGatewayMethod(
      "flowos.surfaceContext.bind",
      async ({ params, client, respond }) => {
        if (!trustedOperator(client)) {
          api.logger.warn("FlowOS Surface Context bind rejected: untrusted operator client");
          reject(respond, "INVALID_REQUEST", "paired operator device authentication required");
          return;
        }
        const input = params ?? {};
        if (
          Object.keys(input).toSorted().join(",") !== "contextRef,sessionKey" ||
          !normalizedString(input.contextRef, 2048) ||
          !normalizedString(input.sessionKey, 512) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(String(input.sessionKey))
        ) {
          api.logger.warn("FlowOS Surface Context bind rejected: invalid pointer-only request");
          reject(respond, "INVALID_REQUEST", "valid ContextRef and sessionKey are required");
          return;
        }
        if (!runtime) {
          api.logger.warn("FlowOS Surface Context bind rejected: runtime unavailable");
          reject(respond, "UNAVAILABLE", "Surface Context runtime is not configured");
          return;
        }
        try {
          const binding = await runtime.bind(String(input.sessionKey), String(input.contextRef));
          api.logger.info(
            `FlowOS Surface Context bound session=${sessionAuditHash(String(input.sessionKey))} objectType=${binding.context.objectType}`,
          );
          respond(true, {
            bound: true,
            objectType: binding.context.objectType,
            expiresAt: binding.expiresAt,
          });
        } catch (error) {
          const code =
            error instanceof SurfaceContextClientError
              ? error.code
              : error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
                ? error.message
                : "CONTEXT_BIND_FAILED";
          api.logger.warn(
            `FlowOS Surface Context bind rejected session=${sessionAuditHash(String(input.sessionKey))} code=${code}`,
          );
          reject(respond, code, code);
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "flowos.surfaceContext.clear",
      async ({ params, client, respond }) => {
        if (!trustedOperator(client)) {
          reject(respond, "INVALID_REQUEST", "paired operator device authentication required");
          return;
        }
        const input = params ?? {};
        const sessionKey = normalizedString(input.sessionKey, 512);
        if (
          Object.keys(input).length !== 1 ||
          !sessionKey ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(sessionKey)
        ) {
          reject(respond, "INVALID_REQUEST", "valid sessionKey is required");
          return;
        }
        const canonical = canonicalSessionKey(api.config, sessionKey);
        respond(true, { cleared: runtime?.clear(sessionKey) ?? false, sessionKey: canonical });
      },
      { scope: "operator.write" },
    );

    api.registerTool((context) => (runtime ? createSurfaceContextTools(runtime, context) : null), {
      names: ["surface_context_status", "surface_context_resolve"],
    });

    api.on("before_prompt_build", async (_event, context) => {
      const prependContext = runtime ? buildPromptContext(runtime, context.sessionKey) : undefined;
      return prependContext ? { prependContext } : undefined;
    });

    api.on("gateway_start", async () => {
      if (!runtime) {
        api.logger.warn(
          "FlowOS Surface Context is disabled because private runtime config is missing",
        );
      }
    });
  },
});
