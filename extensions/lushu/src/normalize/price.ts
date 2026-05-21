const NXX_RE = /^¥(\d+)xx$/;

export function normalizePrice(input: string): string {
  const m = NXX_RE.exec(input);
  if (!m) {
    return input;
  }
  return `¥${m[1]}00+/晚`;
}

const PRICE_FIELDS = new Set(["price", "displayPrice", "priceText", "totalPrice", "minPrice"]);

export function normalizePriceFieldsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePriceFieldsDeep);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && PRICE_FIELDS.has(k)) {
        out[k] = normalizePrice(v);
      } else {
        out[k] = normalizePriceFieldsDeep(v);
      }
    }
    return out;
  }
  return value;
}
