import { describe, expect, it } from "vitest";
import { normalizePrice, normalizePriceFieldsDeep } from "./price.js";

describe("normalizePrice", () => {
  it("converts ¥Nxx placeholders to ¥N00+/晚", () => {
    expect(normalizePrice("¥5xx")).toBe("¥500+/晚");
    expect(normalizePrice("¥10xx")).toBe("¥1000+/晚");
    expect(normalizePrice("¥9xx")).toBe("¥900+/晚");
  });

  it("leaves concrete prices unchanged", () => {
    expect(normalizePrice("¥888")).toBe("¥888");
    expect(normalizePrice("¥500")).toBe("¥500");
    expect(normalizePrice("¥1099/晚")).toBe("¥1099/晚");
  });

  it("leaves non-price strings unchanged", () => {
    expect(normalizePrice("")).toBe("");
    expect(normalizePrice("¥abc")).toBe("¥abc");
    expect(normalizePrice("free")).toBe("free");
  });
});

describe("normalizePriceFieldsDeep", () => {
  it("rewrites known price fields anywhere in the tree", () => {
    const input = {
      data: {
        itemList: [
          { name: "酒店A", price: "¥5xx", displayPrice: "¥500" },
          { name: "酒店B", price: "¥12xx", totalPrice: "¥9xx" },
        ],
      },
    };
    const out = normalizePriceFieldsDeep(input) as typeof input;
    expect(out.data.itemList[0].price).toBe("¥500+/晚");
    expect(out.data.itemList[0].displayPrice).toBe("¥500");
    expect(out.data.itemList[1].price).toBe("¥1200+/晚");
    expect(out.data.itemList[1].totalPrice).toBe("¥900+/晚");
  });

  it("ignores fields not in the allowed list", () => {
    const input = { otherField: "¥5xx" };
    const out = normalizePriceFieldsDeep(input) as typeof input;
    expect(out.otherField).toBe("¥5xx");
  });

  it("preserves primitives and arrays of primitives", () => {
    expect(normalizePriceFieldsDeep(42)).toBe(42);
    expect(normalizePriceFieldsDeep("¥5xx")).toBe("¥5xx");
    expect(normalizePriceFieldsDeep([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
