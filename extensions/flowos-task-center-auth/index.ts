import { readFileSync, statSync } from "node:fs";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

type PluginConfig = { userId?: unknown; tenantId?: unknown };
type DeviceEventBinding = {
  gatewayDeviceId: string;
  hubDeviceId: string;
  tenantId: string;
  subjectUserId: string;
  status: "active" | "revoked";
  updatedAt: string;
  updatedBy: string;
};

const pluginId = "flowos-task-center-auth";
const deviceEventAudience = "assist:health-device-ingest";
const defaultDeviceEventIssuer = "flowos-device-identity";
const deviceEventScope = "health.device-event.write";
const tokenLifetimeSeconds = 300;
const bindingsNamespace = "device-event-bindings";
const knownCredentialNames = [
  "OPENCLAW_GATEWAY_TOKEN",
  "FLOWOS_TASK_CENTER_JWT_SECRET",
  "CODING_BUDDY_PUBLISH_TOKEN",
  "CODING_JOB_TOKEN",
  "HEALTH_CORE_WRITE_TOKEN",
  "MINIAPP_EVENT_CAPABILITY_SECRET",
  "HEALTH_BUDDY_INBOX_TOKEN",
] as const;

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

export async function issueDeviceEventJwt(
  binding: Pick<DeviceEventBinding, "hubDeviceId" | "tenantId" | "subjectUserId">,
  secret: string,
  issuedAt = Math.floor(Date.now() / 1000),
  issuer = defaultDeviceEventIssuer,
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  const accessToken = await signJwt(
    {
      iss: issuer,
      aud: deviceEventAudience,
      sub: `device:${binding.hubDeviceId}`,
      actorType: "DEVICE",
      deviceId: binding.hubDeviceId,
      tenantId: binding.tenantId,
      subjectUserId: binding.subjectUserId,
      scope: deviceEventScope,
      iat: issuedAt,
      exp: issuedAt + tokenLifetimeSeconds,
      jti: globalThis.crypto.randomUUID(),
    },
    secret,
  );
  return { accessToken, tokenType: "Bearer", expiresIn: tokenLifetimeSeconds };
}

function reject(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validIdentifier(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function loadDeviceEventSecret(additionalCredentials: readonly unknown[]): string {
  const path = normalizedString(process.env.FLOWOS_DEVICE_EVENT_JWT_SECRET_FILE);
  if (!path) {
    return "";
  }
  try {
    const stat = statSync(path);
    // The signing key is a Gateway-only credential. Group/other access is always unsafe.
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      return "";
    }
    const secret = readFileSync(path, "utf8").trim();
    const knownCredentials = [
      ...knownCredentialNames.map((name) => process.env[name]),
      ...additionalCredentials,
    ];
    const reused = knownCredentials.some((value) => normalizedString(value) === secret);
    return Buffer.byteLength(secret) >= 32 && !reused ? secret : "";
  } catch {
    return "";
  }
}

async function issueUserToken(
  config: PluginConfig,
  audience: string,
  scopes: readonly string[],
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  const userId = normalizedString(config.userId);
  const tenantId = normalizedString(config.tenantId);
  const secret = normalizedString(process.env.FLOWOS_TASK_CENTER_JWT_SECRET);
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
      exp: issuedAt + tokenLifetimeSeconds,
      jti: globalThis.crypto.randomUUID(),
    },
    secret,
  );
  return { accessToken, tokenType: "Bearer", expiresIn: tokenLifetimeSeconds };
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

function registerDeviceEventBindingMethods(
  api: OpenClawPluginApi,
  bindings: PluginStateKeyedStore<DeviceEventBinding>,
): void {
  api.registerGatewayMethod(
    "flowos.deviceEventBinding.upsert",
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const input = params ?? {};
      const expected = ["gatewayDeviceId", "hubDeviceId", "subjectUserId", "tenantId"].sort();
      const gatewayDeviceId = normalizedString(input.gatewayDeviceId);
      const hubDeviceId = normalizedString(input.hubDeviceId);
      const tenantId = normalizedString(input.tenantId);
      const subjectUserId = normalizedString(input.subjectUserId);
      if (
        !hasExactKeys(input, expected) ||
        !validIdentifier(gatewayDeviceId) ||
        !validIdentifier(hubDeviceId) ||
        !validIdentifier(tenantId) ||
        !validIdentifier(subjectUserId)
      ) {
        reject(respond, "complete device ownership is required");
        return;
      }
      const binding: DeviceEventBinding = {
        gatewayDeviceId,
        hubDeviceId,
        tenantId,
        subjectUserId,
        status: "active",
        updatedAt: new Date().toISOString(),
        updatedBy: client?.connect.device?.id ?? "gateway-admin",
      };
      await bindings.register(gatewayDeviceId, binding);
      respond(true, { binding });
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "flowos.deviceEventBinding.revoke",
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const input = params ?? {};
      const gatewayDeviceId = normalizedString(input.gatewayDeviceId);
      if (!hasExactKeys(input, ["gatewayDeviceId"]) || !validIdentifier(gatewayDeviceId)) {
        reject(respond, "gatewayDeviceId is required");
        return;
      }
      const existing = await bindings.lookup(gatewayDeviceId);
      if (!existing) {
        reject(respond, "device binding not found");
        return;
      }
      const binding: DeviceEventBinding = {
        ...existing,
        status: "revoked",
        updatedAt: new Date().toISOString(),
        updatedBy: client?.connect.device?.id ?? "gateway-admin",
      };
      await bindings.register(gatewayDeviceId, binding);
      respond(true, { binding });
    },
    { scope: "operator.admin" },
  );
}

function registerDeviceEventTokenMethod(
  api: OpenClawPluginApi,
  bindings: PluginStateKeyedStore<DeviceEventBinding>,
  secret: string,
  issuer: string,
): void {
  api.registerGatewayMethod(
    "flowos.deviceEventToken",
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const gatewayDeviceId = client?.connect.device?.id;
      if (!client?.isDeviceTokenAuth || client.connect.role !== "operator" || !gatewayDeviceId) {
        reject(respond, "paired operator device authentication required");
        return;
      }
      if (Object.keys(params ?? {}).length > 0) {
        reject(respond, "this method accepts no identity parameters");
        return;
      }
      if (!secret) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "device event authentication is not configured",
        });
        return;
      }
      const binding = await bindings.lookup(gatewayDeviceId);
      if (!binding || binding.status !== "active") {
        reject(respond, "active device ownership binding required");
        return;
      }
      respond(true, await issueDeviceEventJwt(binding, secret, undefined, issuer));
    },
    { scope: "operator.read" },
  );
}

export default definePluginEntry({
  id: pluginId,
  name: "FlowOS User Auth",
  description: "Issue audience-bound five-minute user and device JWTs for FlowOS services",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const bindings = api.runtime.state.openKeyedStore<DeviceEventBinding>({
      namespace: bindingsNamespace,
      maxEntries: 1024,
    });
    registerUserTokenMethod(api, config, "flowos.taskCenterToken", "assist:task-center", []);
    registerUserTokenMethod(api, config, "flowos.miniAppToken", "assist:miniapps", miniAppScopes);
    registerDeviceEventBindingMethods(api, bindings);
    const issuer =
      normalizedString(process.env.FLOWOS_DEVICE_EVENT_JWT_ISSUER) || defaultDeviceEventIssuer;
    registerDeviceEventTokenMethod(
      api,
      bindings,
      loadDeviceEventSecret([api.config.gateway?.auth?.token, api.config.gateway?.auth?.password]),
      issuer,
    );
  },
});
