import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type PluginConfig = { userId?: unknown; tenantId?: unknown };

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}

function reject(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

export default definePluginEntry({
  id: "flowos-task-center-auth",
  name: "FlowOS Task Center Auth",
  description: "Issue a five-minute user JWT for Assist task-center reads",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    api.registerGatewayMethod(
      "flowos.taskCenterToken",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        if (!client?.isDeviceTokenAuth || !client.connect.device?.id) {
          reject(respond, "paired device authentication required");
          return;
        }
        if (Object.keys(params ?? {}).length > 0) {
          reject(respond, "this method accepts no identity parameters");
          return;
        }
        const userId = typeof config.userId === "string" ? config.userId.trim() : "";
        const tenantId = typeof config.tenantId === "string" ? config.tenantId.trim() : "";
        const secret = process.env.FLOWOS_TASK_CENTER_JWT_SECRET?.trim() ?? "";
        if (!userId || !tenantId || Buffer.byteLength(secret) < 32) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "task-center auth is not configured",
          });
          return;
        }
        const issuedAt = Math.floor(Date.now() / 1000);
        const accessToken = await signJwt(
          {
            iss: "flowos-gateway",
            aud: "assist:task-center",
            sub: `user:${userId}`,
            tenantId,
            actorType: "USER",
            iat: issuedAt,
            exp: issuedAt + 300,
            jti: globalThis.crypto.randomUUID(),
          },
          secret,
        );
        respond(true, { accessToken, tokenType: "Bearer", expiresIn: 300 });
      },
      { scope: "operator.read" },
    );
  },
});
