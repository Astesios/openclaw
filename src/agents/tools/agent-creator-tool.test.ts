import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentWithService: vi.fn(),
  loadAgentCreatorCatalog: vi.fn(),
}));

vi.mock("../../gateway/server-methods/agent-create-service.js", () => ({
  createAgentWithService: (...args: unknown[]) => mocks.createAgentWithService(...args),
}));

vi.mock("../agent-creator-catalog.js", () => ({
  loadAgentCreatorCatalog: (...args: unknown[]) => mocks.loadAgentCreatorCatalog(...args),
}));

import { createAgentCreatorTool } from "./agent-creator-tool.js";

const draft = {
  action: "prepare",
  name: "旅行助手",
  description: "整理行程并提醒关键节点",
  skill_keys: ["weather"],
  avatar_profile_id: "cat",
  emoji: "🧭",
  agents_md: "# AGENTS",
  soul_md: "# SOUL",
  user_md: "# USER",
  tools_md: "# TOOLS",
};

beforeEach(() => {
  mocks.createAgentWithService.mockReset();
  mocks.loadAgentCreatorCatalog.mockReset().mockResolvedValue({
    cfg: {},
    availableSkills: [{ skillKey: "weather", source: "bundled", baseDir: "/skills/weather" }],
    avatars: [{ id: "cat", name: "猫猫", file: "cat.png", description: "亲近" }],
    assetsDir: "/avatars",
  });
});

describe("agent_creator card lifecycle", () => {
  it("returns a public card id across prepare and create without exposing confirmation id", async () => {
    mocks.createAgentWithService.mockResolvedValue({
      agentId: "travel-helper",
      name: "旅行助手",
      workspace: "/agents/travel-helper",
      skills: ["weather"],
      avatarProfileId: "cat",
    });

    const prepareTool = createAgentCreatorTool({
      workspaceDir: "/workspace",
      sessionKey: "agent:main:test-card-lifecycle",
      runId: "prepare-run",
      senderIsOwner: true,
    });
    const prepared = await prepareTool.execute("prepare-call", draft);
    const preparedDetails = prepared.details as {
      confirmation_id: string;
      card: Record<string, unknown>;
    };

    expect(preparedDetails.card).toMatchObject({
      type: "agent_creation_card",
      phase: "suggest",
      name: "旅行助手",
      description: "整理行程并提醒关键节点",
      skillKeys: ["weather"],
      avatarProfileId: "cat",
      emoji: "🧭",
    });
    expect(preparedDetails.card.cardId).toMatch(/^agent-creation-/);
    expect(preparedDetails.card).not.toHaveProperty("confirmation_id");

    const createTool = createAgentCreatorTool({
      workspaceDir: "/workspace",
      sessionKey: "agent:main:test-card-lifecycle",
      runId: "create-run",
      senderIsOwner: true,
    });
    const created = await createTool.execute("create-call", {
      action: "create",
      confirmation_id: preparedDetails.confirmation_id,
    });
    const createdDetails = created.details as { card: Record<string, unknown> };

    expect(createdDetails.card).toMatchObject({
      type: "agent_creation_card",
      phase: "created",
      cardId: preparedDetails.card.cardId,
      agentId: "travel-helper",
      name: "旅行助手",
      skillKeys: ["weather"],
      avatarProfileId: "cat",
    });
    expect(createdDetails.card).not.toHaveProperty("confirmation_id");
  });

  it("reuses the public card id when a draft is prepared again in the same session", async () => {
    const firstTool = createAgentCreatorTool({
      workspaceDir: "/workspace",
      sessionKey: "agent:main:test-card-reprepare",
      runId: "first-prepare-run",
      senderIsOwner: true,
    });
    const first = await firstTool.execute("first-prepare-call", draft);
    const firstDetails = first.details as {
      confirmation_id: string;
      card: { cardId: string };
    };

    const secondTool = createAgentCreatorTool({
      workspaceDir: "/workspace",
      sessionKey: "agent:main:test-card-reprepare",
      runId: "second-prepare-run",
      senderIsOwner: true,
    });
    const second = await secondTool.execute("second-prepare-call", {
      ...draft,
      description: "更新后的旅行助手草案",
    });
    const secondDetails = second.details as {
      confirmation_id: string;
      card: { cardId: string; description: string };
    };

    expect(secondDetails.confirmation_id).not.toBe(firstDetails.confirmation_id);
    expect(secondDetails.card.cardId).toBe(firstDetails.card.cardId);
    expect(secondDetails.card.description).toBe("更新后的旅行助手草案");
  });
});
