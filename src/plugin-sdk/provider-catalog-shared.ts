// Shared provider catalog helpers for provider plugins.
//
// Keep provider-owned exports out of this subpath so plugin loaders can import it
// without recursing through provider-specific facades.

import { normalizeStaticProviderModelId } from "../agents/model-ref-shared.js";
import { findNormalizedProviderKey } from "../agents/provider-id.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderRequestCapabilities } from "./provider-http.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";

export type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";

export {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "../plugins/provider-catalog.js";

export type ConfiguredProviderCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "document">;
};

function normalizeConfiguredCatalogModelInput(
  input: unknown,
): ConfiguredProviderCatalogEntry["input"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is "text" | "image" | "document" =>
      item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredProviderModels(
  config: OpenClawConfig | undefined,
  providerId: string,
): ModelDefinitionConfig[] {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const providerKey = findNormalizedProviderKey(providers, providerId);
  if (!providerKey) {
    return [];
  }
  const providerConfig = providers[providerKey];
  if (!providerConfig || typeof providerConfig !== "object") {
    return [];
  }
  return Array.isArray(providerConfig.models) ? providerConfig.models : [];
}

export function readConfiguredProviderCatalogEntries(params: {
  config?: OpenClawConfig;
  providerId: string;
  publishedProviderId?: string;
}): ConfiguredProviderCatalogEntry[] {
  const provider = params.publishedProviderId ?? params.providerId;
  const models = resolveConfiguredProviderModels(params.config, params.providerId);
  const entries: ConfiguredProviderCatalogEntry[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) {
      continue;
    }
    const name = (typeof model.name === "string" ? model.name : id).trim() || id;
    const contextWindow =
      typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : undefined;
    const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
    const input = normalizeConfiguredCatalogModelInput(model.input);
    entries.push({
      provider,
      id,
      name,
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(input ? { input } : {}),
    });
  }
  return entries;
}

function withStreamingUsageCompat(provider: ModelProviderConfig): ModelProviderConfig {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (model.compat?.supportsUsageInStreaming !== undefined) {
      return model;
    }
    changed = true;
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    };
  });

  return changed ? { ...provider, models } : provider;
}

export function supportsNativeStreamingUsageCompat(params: {
  providerId: string;
  baseUrl: string | undefined;
}): boolean {
  return resolveProviderRequestCapabilities({
    provider: params.providerId,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    capability: "llm",
    transport: "stream",
  }).supportsNativeStreamingUsageCompat;
}

export function applyProviderNativeStreamingUsageCompat(params: {
  providerId: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  return supportsNativeStreamingUsageCompat({
    providerId: params.providerId,
    baseUrl: params.providerConfig.baseUrl,
  })
    ? withStreamingUsageCompat(params.providerConfig)
    : params.providerConfig;
}

// Minimal manifest-catalog builder ported from upstream commits
// 4a195b37d5 / fd484cf472. Unlike upstream we do not depend on
// src/model-catalog/normalize.ts — we validate inline. Re-sync with
// upstream when celia takes the full model-catalog subsystem.

type ManifestCatalogTieredCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  range: readonly [number] | readonly [number, number];
};

type ManifestCatalogCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tieredPricing?: readonly ManifestCatalogTieredCost[];
};

type ManifestCatalogModel = {
  id: string;
  name?: string;
  api?: ModelDefinitionConfig["api"];
  baseUrl?: string;
  reasoning?: boolean;
  input?: ReadonlyArray<"text" | "image" | "document">;
  cost?: ManifestCatalogCost;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: ModelDefinitionConfig["compat"];
};

type ManifestCatalogProvider = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  headers?: Record<string, string>;
  models?: readonly ManifestCatalogModel[];
};

function cloneManifestCatalogTieredCost(
  tier: ManifestCatalogTieredCost,
): NonNullable<ModelDefinitionConfig["cost"]["tieredPricing"]>[number] {
  return {
    input: tier.input ?? 0,
    output: tier.output ?? 0,
    cacheRead: tier.cacheRead ?? 0,
    cacheWrite: tier.cacheWrite ?? 0,
    range: tier.range.length === 1 ? [tier.range[0]] : [tier.range[0], tier.range[1]],
  };
}

function cloneManifestCatalogCost(cost: ManifestCatalogCost): ModelDefinitionConfig["cost"] {
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tieredPricing
      ? { tieredPricing: cost.tieredPricing.map(cloneManifestCatalogTieredCost) }
      : {}),
  };
}

function buildManifestCatalogModelInput(
  model: ManifestCatalogModel,
): ModelDefinitionConfig["input"] {
  if (model.input?.includes("document")) {
    throw new Error(
      `Manifest modelCatalog row ${model.id} uses unsupported runtime input document`,
    );
  }
  return model.input?.filter((item): item is "text" | "image" => item !== "document") ?? ["text"];
}

function buildManifestCatalogModel(
  providerId: string,
  model: ManifestCatalogModel,
): ModelDefinitionConfig {
  if (model.contextWindow === undefined) {
    throw new Error(`Manifest modelCatalog row ${model.id} is missing contextWindow`);
  }
  if (model.maxTokens === undefined) {
    throw new Error(`Manifest modelCatalog row ${model.id} is missing maxTokens`);
  }
  const id = normalizeStaticProviderModelId(providerId, model.id);
  return {
    id,
    name: model.name ?? id,
    ...(model.api ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    reasoning: model.reasoning ?? false,
    input: buildManifestCatalogModelInput(model),
    cost: cloneManifestCatalogCost(model.cost ?? {}),
    contextWindow: model.contextWindow,
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  };
}

export function buildManifestModelProviderConfig(params: {
  providerId: string;
  catalog: unknown;
}): ModelProviderConfig {
  if (!params.catalog || typeof params.catalog !== "object") {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}`);
  }
  const catalog = params.catalog as ManifestCatalogProvider;
  if (!catalog.baseUrl) {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}.baseUrl`);
  }
  if (!Array.isArray(catalog.models)) {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}.models`);
  }
  return {
    baseUrl: catalog.baseUrl,
    ...(catalog.api ? { api: catalog.api } : {}),
    ...(catalog.headers ? { headers: { ...catalog.headers } } : {}),
    models: catalog.models.map((model) => buildManifestCatalogModel(params.providerId, model)),
  };
}
