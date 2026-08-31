import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const resolveFlowGoNewSessionRouteMock = vi.hoisted(() => vi.fn());
const resolveFlowGoCallerMock = vi.hoisted(() => vi.fn());
const authorizeFlowGoOwnedSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../flowgo-device-routing.js", () => ({
  authorizeFlowGoOwnedSession: authorizeFlowGoOwnedSessionMock,
  resolveFlowGoCaller: resolveFlowGoCallerMock,
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
    resolveFlowGoCallerMock.mockResolvedValue({ kind: "unchanged" });
    authorizeFlowGoOwnedSessionMock.mockResolvedValue({
      kind: "allowed",
      deviceId: "flowgo-1",
    });
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

  it.each([
    ["sessions.get", sessionsHandlers["sessions.get"], { key: "agent:main:other" }],
    ["chat.history", chatHandlers["chat.history"], { sessionKey: "agent:main:other" }],
    [
      "chat.message.get",
      chatHandlers["chat.message.get"],
      { sessionKey: "agent:main:other", messageId: "message-1" },
    ],
  ])(
    "rejects a FlowGo read through %s when the persisted owner differs",
    async (method, handler, params) => {
      resolveFlowGoCallerMock.mockResolvedValue({ kind: "flowgo", deviceId: "flowgo-1" });
      authorizeFlowGoOwnedSessionMock.mockResolvedValue({
        kind: "error",
        message: "FlowGo session belongs to a different device",
      });
      const opts = createOptions(method, params);

      await handler(opts);

      expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "FlowGo session belongs to a different device",
      });
    },
  );

  it("rejects a FlowGo child session whose parent is not owned by the device", async () => {
    resolveFlowGoCallerMock.mockResolvedValue({ kind: "flowgo", deviceId: "flowgo-1" });
    authorizeFlowGoOwnedSessionMock.mockResolvedValue({
      kind: "error",
      message: "FlowGo session belongs to a different device",
    });
    const opts = createOptions("sessions.create", {
      key: "main",
      parentSessionKey: "agent:main:other",
    });

    await sessionsHandlers["sessions.create"](opts);

    expect(resolveFlowGoNewSessionRouteMock).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "FlowGo session belongs to a different device",
    });
  });
});
