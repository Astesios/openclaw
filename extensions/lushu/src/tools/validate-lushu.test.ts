import { describe, expect, it } from "vitest";
import { parseValidatorOutput } from "./validate-lushu.js";

describe("parseValidatorOutput", () => {
  it("buckets ✅ / ❌ / ⚠️ lines correctly", () => {
    const stdout = [
      "=== 验证 /tmp/路书.html ===",
      "✅ 顶部遮罩 + IntersectionObserver 存在",
      "❌ 检测到本地图片路径 images/x.jpg",
      "⚠️ Day1: transit-next=0 / timeline-item=3 — 漏加嫌疑",
      "ℹ️  Day2: transit-next=1 / timeline-item=2",
      "",
    ].join("\n");
    const parsed = parseValidatorOutput(stdout, 1);
    expect(parsed.exit).toBe(1);
    expect(parsed.passes).toEqual(["顶部遮罩 + IntersectionObserver 存在"]);
    expect(parsed.fails).toEqual(["检测到本地图片路径 images/x.jpg"]);
    expect(parsed.warns).toEqual(["Day1: transit-next=0 / timeline-item=3 — 漏加嫌疑"]);
    expect(parsed.rawStdout).toBe(stdout);
  });

  it("returns empty arrays for all-INFO output", () => {
    const stdout = "ℹ️  Day1: transit-next=1 / timeline-item=2\n";
    const parsed = parseValidatorOutput(stdout, 0);
    expect(parsed.exit).toBe(0);
    expect(parsed.passes).toEqual([]);
    expect(parsed.fails).toEqual([]);
    expect(parsed.warns).toEqual([]);
  });

  it("ignores blank lines and section headers", () => {
    const parsed = parseValidatorOutput("=== header ===\n\n\n", 0);
    expect(parsed.passes).toEqual([]);
    expect(parsed.fails).toEqual([]);
    expect(parsed.warns).toEqual([]);
  });
});
