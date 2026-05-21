import { describe, expect, it } from "vitest";
import { stripInsecureUrlFieldsDeep } from "./url.js";

describe("stripInsecureUrlFieldsDeep", () => {
  it("removes non-https jumpUrl/detailUrl/bookUrl/url fields", () => {
    const input = {
      data: {
        itemList: [
          { name: "A", jumpUrl: "http://example.com/a", detailUrl: "https://example.com/a" },
          { name: "B", bookUrl: "ftp://example.com", url: "https://example.com/b" },
        ],
      },
    };
    const out = stripInsecureUrlFieldsDeep(input) as {
      data: { itemList: Array<Record<string, unknown>> };
    };
    expect(out.data.itemList[0]).toEqual({ name: "A", detailUrl: "https://example.com/a" });
    expect(out.data.itemList[1]).toEqual({ name: "B", url: "https://example.com/b" });
  });

  it("keeps https URLs", () => {
    const input = { jumpUrl: "https://safe.example.com/path?x=1" };
    expect(stripInsecureUrlFieldsDeep(input)).toEqual(input);
  });

  it("does not touch unrelated string fields", () => {
    const input = { title: "http://not-a-url-field.example", name: "x" };
    expect(stripInsecureUrlFieldsDeep(input)).toEqual(input);
  });

  it("preserves primitives and arrays of primitives", () => {
    expect(stripInsecureUrlFieldsDeep(null)).toBe(null);
    expect(stripInsecureUrlFieldsDeep("http://x.com")).toBe("http://x.com");
    expect(stripInsecureUrlFieldsDeep([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
