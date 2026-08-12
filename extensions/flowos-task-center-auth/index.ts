import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type PluginConfig = { userId?: unknown; tenantId?: unknown };

const miniAppScopes = [
  "miniapp.data.read",
  "miniapp.data.write",
  "miniapp.inbox.read",
  "miniapp.inbox.ack",
  "miniapp.function.invoke",
] as const;

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

async function issueUserToken(
  config: PluginConfig,
  audience: string,
  scopes: readonly string[],
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  const userId = typeof config.userId === "string" ? config.userId.trim() : "";
  const tenantId = typeof config.tenantId === "string" ? config.tenantId.trim() : "";
  const secret = process.env.FLOWOS_TASK_CENTER_JWT_SECRET?.trim() ?? "";
  if (!userId || !tenantId || Buffer.byteLength(secret) < 32) {
    throw new Error("user auth is not configured");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessToken = await signJwt(
    {
      iss: "flowos-gateway",
      aud: audience,
      sub: `user:${userId}`,
      tenantId,
      actorType: "USER",
      scope: scopes.join(" "),
      iat: issuedAt,
      exp: issuedAt + 300,
      jti: globalThis.crypto.randomUUID(),
    },
    secret,
  );
  return { accessToken, tokenType: "Bearer", expiresIn: 300 };
}

function registerUserTokenMethod(
  api: OpenClawPluginApi,
  config: PluginConfig,
  name: string,
  audience: string,
  scopes: readonly string[],
): void {
  api.registerGatewayMethod(
    name,
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      if (!client?.isDeviceTokenAuth || !client.connect.device?.id) {
        reject(respond, "paired device authentication required");
        return;
      }
      if (Object.keys(params ?? {}).length > 0) {
        reject(respond, "this method accepts no identity parameters");
        return;
      }
      try {
        respond(true, await issueUserToken(config, audience, scopes));
      } catch {
        respond(false, undefined, { code: "UNAVAILABLE", message: "user auth is not configured" });
      }
    },
    { scope: "operator.read" },
  );
}

export default definePluginEntry({
  id: "flowos-task-center-auth",
  name: "FlowOS User Auth",
  description: "Issue audience-bound five-minute user JWTs for FlowOS services",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    registerUserTokenMethod(api, config, "flowos.taskCenterToken", "assist:task-center", []);
    registerUserTokenMethod(api, config, "flowos.miniAppToken", "assist:miniapps", miniAppScopes);
  },
});
