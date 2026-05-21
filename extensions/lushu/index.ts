import { definePluginEntry } from "./api.js";
import { buildLushuGuidance } from "./src/prompt.js";
import { createFetchImagesTool } from "./src/tools/fetch-images.js";
import { createGetLushuSpawnPromptTool } from "./src/tools/get-lushu-spawn-prompt.js";
import { createQueryFlyaiTool } from "./src/tools/query-flyai.js";
import { createRenderIconsTool } from "./src/tools/render-icons.js";
import { createRenderMapBlockTool } from "./src/tools/render-map-block.js";
import { createValidateLushuTool } from "./src/tools/validate-lushu.js";

type PluginConfig = {
  enabled?: boolean;
};

export default definePluginEntry({
  id: "lushu",
  name: "Lushu",
  description:
    "Lushu plugin — 路书生成器(纯 plugin 化)。提供 fetch_images / query_flyai / render_map_block / render_icons / validate_lushu / get_lushu_spawn_prompt 6 个工具,通过 before_prompt_build hook 注入触发规则与流程指引,替代原 lushu skill。",
  register(api) {
    const cfg = (api.pluginConfig as PluginConfig) ?? {};
    if (cfg.enabled === false) {
      return;
    }

    api.registerTool(createFetchImagesTool, { name: "fetch_images" });
    api.registerTool(createQueryFlyaiTool, { name: "query_flyai" });
    api.registerTool(createRenderMapBlockTool, { name: "render_map_block" });
    api.registerTool(createRenderIconsTool, { name: "render_icons" });
    api.registerTool(createValidateLushuTool, { name: "validate_lushu" });
    api.registerTool(createGetLushuSpawnPromptTool, { name: "get_lushu_spawn_prompt" });

    // Inject lushu trigger rules + main workflow into system prompt every turn.
    // Parallels extensions/skill-discovery/index.ts:before_prompt_build.
    // Counter-examples in the guidance are critical — without them Agents
    // start lushu_* in plan stage (the stash 45a571c35d踩坑).
    api.on("before_prompt_build", async () => {
      return {
        prependSystemContext: buildLushuGuidance(),
      };
    });
  },
});
