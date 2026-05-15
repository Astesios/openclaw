import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createDeepSeekV4OpenAICompatibleThinkingWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

function isOpencodeGoDeepSeekV4Model(model: { id?: unknown; provider?: unknown }): boolean {
  if (model.provider !== "opencode-go") {
    return false;
  }
  const id = typeof model.id === "string" ? model.id.trim().toLowerCase() : "";
  return id === "deepseek-v4-flash" || id === "deepseek-v4-pro";
}

export function createOpencodeGoDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: isOpencodeGoDeepSeekV4Model,
  });
}
