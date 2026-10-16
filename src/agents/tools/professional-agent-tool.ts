import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const ProfessionalAgentToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("offer"),
      Type.Literal("propose"),
      Type.Literal("decline"),
    ]),
    template_id: Type.Optional(Type.String()),
    original_request: Type.Optional(Type.String()),
    offer_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export function createProfessionalAgentTool(options: { agentSessionKey?: string }): AnyAgentTool {
  return {
    name: "professional_agent",
    label: "Professional Agent",
    description:
      "Check, offer, propose, or decline a professional-agent handoff. This tool cannot create an agent; creation requires the user's native confirmation-card action.",
    parameters: ProfessionalAgentToolSchema,
    execute: async (_toolCallId, input) => {
      const params = input as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const parentSessionKey = options.agentSessionKey?.trim();
      if (!parentSessionKey) {
        throw new Error("professional_agent requires an active parent session");
      }
      if (action === "status") {
        const templateId = readStringParam(params, "template_id", { required: true });
        return jsonResult(
          await callGatewayTool(
            "agents.provision.status",
            {},
            {
              templateId,
              parentSessionKey,
            },
          ),
        );
      }
      if (action === "offer") {
        const templateId = readStringParam(params, "template_id", { required: true });
        const originalRequest = readStringParam(params, "original_request", { required: true });
        return jsonResult(
          await callGatewayTool(
            "agents.provision.propose",
            {},
            {
              mode: "offer",
              templateId,
              parentSessionKey,
              originalRequest,
            },
          ),
        );
      }
      const offerId = readStringParam(params, "offer_id", { required: true });
      if (action === "propose") {
        return jsonResult(
          await callGatewayTool(
            "agents.provision.propose",
            {},
            {
              mode: "proposal",
              offerId,
              parentSessionKey,
            },
          ),
        );
      }
      if (action === "decline") {
        return jsonResult(await callGatewayTool("agents.provision.dismiss", {}, { offerId }));
      }
      throw new Error(`unsupported professional_agent action: ${action}`);
    },
  };
}
