import { definePluginEntry } from "./api.js";
import { runAutoDiscover } from "./src/auto-discover.js";
import { setBroadcaster, setBroadcastEnabled } from "./src/broadcaster.js";
import { buildSkillDiscoveryGuidance } from "./src/prompt.js";
import { createFindSkillTool, createInstallSkillTool, createVerifySkillTool } from "./src/tool.js";

type PluginConfig = {
  enabled?: boolean;
  autoInstall?: boolean;
  broadcastEvents?: boolean;
};

export default definePluginEntry({
  id: "skill-discovery",
  name: "Skill Discovery",
  description:
    "Detects capability gaps and runs the skill lifecycle (find → verify → install → update) " +
    "against ClawHub, broadcasting lifecycle events for visual clients.",
  register(api) {
    const cfg = (api.pluginConfig as PluginConfig) ?? {};
    if (cfg.enabled === false) {
      return;
    }
    setBroadcastEnabled(cfg.broadcastEvents !== false);

    // Warm-up gateway method: first invocation caches `context.broadcast` so
    // tool handlers (which don't get a context) can use it via the shared
    // module-level helper. Clients (or the openclaw runtime itself) can poke
    // this once on startup. It's idempotent and side-effect-free apart from
    // the cache.
    api.registerGatewayMethod("skill_discovery.bind_broadcaster", async ({ context, respond }) => {
      setBroadcaster(context.broadcast);
      respond(true, { bound: true });
    });

    // End-to-end smoke test method: broadcasts the full 5-stage lifecycle
    // without needing a model. Connect a WS client, call this, and verify all
    // five `plugin.skill.lifecycle.*` events arrive in order.
    api.registerGatewayMethod("skill_discovery.test_lifecycle", async ({ context, respond }) => {
      setBroadcaster(context.broadcast);
      const skill = "azure-ielts-coach";
      const query = "雅思口语备考";
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const { broadcastLifecycle } = await import("./src/broadcaster.js");
      broadcastLifecycle({ stage: "discover.started", query });
      await sleep(300);
      broadcastLifecycle({ stage: "discover.found", query, data: { count: 1, top: [skill] } });
      await sleep(300);
      broadcastLifecycle({ stage: "verify.passed", skill });
      await sleep(300);
      broadcastLifecycle({ stage: "install.started", skill, displayName: "Azure 发音教练" });
      await sleep(500);
      broadcastLifecycle({
        stage: "install.complete",
        skill,
        displayName: "Azure 发音教练",
        data: { version: "1.0.0", targetDir: `workspace/skills/${skill}` },
      });
      respond(true, { emitted: 5 });
    });

    api.registerTool((ctx) => createFindSkillTool({ api, ctx }), { name: "find_skill" });
    api.registerTool((ctx) => createVerifySkillTool({ api, ctx }), { name: "verify_skill" });
    api.registerTool((ctx) => createInstallSkillTool({ api, ctx }), { name: "install_skill" });

    // Before each turn:
    //   1. Static guidance goes in `prependSystemContext` (cacheable).
    //   2. A deterministic rule-based judge runs over the latest user
    //      message. If it flags a capability request, we hit ClawHub
    //      ourselves and inject the top matches as `prependContext`.
    //      The agent (regardless of persona) sees concrete skill candidates
    //      and only has to pick + call install_skill — it doesn't have to
    //      decide whether to search.
    api.on("before_prompt_build", async (event) => {
      if (cfg.enabled === false) {
        return undefined;
      }
      // event.prompt 是本回合新发的用户消息；event.messages 是历史(不含本回合)。
      // 历史里可能已经被前几轮的 <skill_market_autoaudit> 块污染，单看历史会
      // 让 judge 永远循环命中旧 domain。优先用 prompt。
      const auto = await runAutoDiscover({
        prompt: event.prompt,
        messages: event.messages,
      });
      return {
        prependSystemContext: buildSkillDiscoveryGuidance(),
        ...(auto.prependContext ? { prependContext: auto.prependContext } : {}),
      };
    });
  },
});
