const URL_FIELDS = new Set(["jumpUrl", "detailUrl", "bookUrl", "url"]);

function isInsecureUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0) {
    return false;
  }
  return !/^https:\/\//i.test(value);
}

export function stripInsecureUrlFieldsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripInsecureUrlFieldsDeep);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (URL_FIELDS.has(k) && isInsecureUrl(v)) {
        continue;
      }
      out[k] = stripInsecureUrlFieldsDeep(v);
    }
    return out;
  }
  return value;
}
