import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const resolveFlowGoNewSessionRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../flowgo-device-routing.js", () => ({
  resolveFlowGoNewSessionRoute: resolveFlowGoNewSessionRouteMock,
}));

function createOptions(
  method: string,
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    respond: vi.fn() as unknown as RespondFn,
    context: {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }, { id: "pet-agent" }] } }),
    },
    client: null,
    isWebchatConnect: () => false,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("FlowGo new-session handler wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFlowGoNewSessionRouteMock.mockResolvedValue({
      kind: "error",
      message: "FlowGo device Agent is unavailable; rebind the device before starting a session",
    });
  });

  it.each([
    [
      "agent",
      agentHandlers.agent,
      { message: "hello", idempotencyKey: "run-1", sessionKey: "main" },
    ],
    [
      "chat.send",
      chatHandlers["chat.send"],
      { message: "hello", idempotencyKey: "run-1", sessionKey: "main" },
    ],
    ["sessions.create", sessionsHandlers["sessions.create"], { key: "main" }],
  ])(
    "fails closed in the %s handler before creating a session",
    async (method, handler, params) => {
      const opts = createOptions(method, params);

      await handler(opts);

      expect(resolveFlowGoNewSessionRouteMock).toHaveBeenCalledTimes(1);
      expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("rebind"),
      });
    },
  );
});
