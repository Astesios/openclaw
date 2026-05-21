#!/usr/bin/env node

/**
 * 路书配图搜索脚本
 *
 * 用法：
 *   node fetch-images.mjs --keywords "赛里木湖,果子沟大桥,伊宁夜市" --city "伊犁" --output ./images.json
 *   node fetch-images.mjs --keywords "瓷房子,五大道,意式风情街" --city "天津"
 *
 * 参数：
 *   --keywords   逗号分隔的景点/地点关键词列表（必填）
 *   --city       城市名，用于辅助搜索（可选）
 *   --output     输出 JSON 文件路径（默认输出到 stdout）
 *   --per-page   每个关键词搜索的图片数量（默认 3）
 */

const PEXELS_KEY = "jSYNMJ1NowLDkI6psrYmQffTumg8IqBsHYZiuaFhMgVuPNKbbvJNTIl7";
const UNSPLASH_KEY = "8jqfctkfwPvXs-CHL5n1Pgu-Usb3nSt8oVbJS5mfgjA";

// 简易中文 → 英文景点映射（常见旅行目的地）
const CN_EN_MAP = {
  赛里木湖: "Sayram Lake",
  果子沟: "Guozigou Valley",
  那拉提: "Nalati Grassland",
  巴音布鲁克: "Bayanbulak",
  独库公路: "Duku Highway Xinjiang",
  喀纳斯: "Kanas Lake",
  天山: "Tianshan Mountains",
  瓷房子: "Porcelain House Tianjin",
  五大道: "Five Great Avenues Tianjin",
  意式风情街: "Italian Style Town Tianjin",
  天津之眼: "Tianjin Eye Ferris Wheel",
  解放桥: "Jiefang Bridge Tianjin",
  西湖: "West Lake Hangzhou",
  外滩: "The Bund Shanghai",
  故宫: "Forbidden City Beijing",
  长城: "Great Wall China",
  兵马俑: "Terracotta Warriors",
  布达拉宫: "Potala Palace",
  洱海: "Erhai Lake Dali",
  丽江古城: "Lijiang Old Town",
  张家界: "Zhangjiajie",
  黄山: "Huangshan Mountain",
  九寨沟: "Jiuzhaigou Valley",
  鼓浪屿: "Gulangyu Island",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { keywords: "", city: "", output: "", perPage: 3 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keywords" && args[i + 1]) result.keywords = args[++i];
    else if (args[i] === "--city" && args[i + 1]) result.city = args[++i];
    else if (args[i] === "--output" && args[i + 1]) result.output = args[++i];
    else if (args[i] === "--per-page" && args[i + 1]) result.perPage = parseInt(args[++i], 10);
  }
  return result;
}

function translateToEnglish(keyword, city) {
  // 先查映射表
  for (const [cn, en] of Object.entries(CN_EN_MAP)) {
    if (keyword.includes(cn)) return en;
  }
  // 没查到就拼 "keyword city China"
  return `${keyword} ${city || ""} China`.trim();
}

async function searchPexels(query, perPage) {
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orientation", "landscape");

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: PEXELS_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.photos || []).map((p) => ({
      url: p.src.large,
      photographer: p.photographer,
      source: "pexels",
      alt: p.alt || query,
    }));
  } catch {
    return [];
  }
}

async function searchUnsplash(query, perPage) {
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orientation", "landscape");

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r) => ({
      url: r.urls.regular,
      photographer: r.user.name,
      source: "unsplash",
      alt: r.alt_description || query,
    }));
  } catch {
    return [];
  }
}

async function searchForKeyword(keyword, city, perPage) {
  // 1. Pexels 中文搜索
  let results = await searchPexels(`${keyword} ${city || ""}`.trim(), perPage);
  if (results.length > 0) return { keyword, query: `${keyword} ${city}`, results };

  // 2. Pexels 英文搜索
  const enQuery = translateToEnglish(keyword, city);
  results = await searchPexels(enQuery, perPage);
  if (results.length > 0) return { keyword, query: enQuery, results };

  // 3. Unsplash 英文兜底
  results = await searchUnsplash(enQuery, perPage);
  if (results.length > 0) return { keyword, query: enQuery, results };

  // 4. 全部无结果
  return { keyword, query: enQuery, results: [] };
}

async function main() {
  const { keywords, city, output, perPage } = parseArgs();

  if (!keywords) {
    console.error(
      '用法: node fetch-images.mjs --keywords "景点1,景点2" --city "城市名" [--output path.json]',
    );
    process.exit(1);
  }

  const keywordList = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  // 封面图：用城市名搜索
  const coverSearch = city
    ? await searchForKeyword(`${city} landscape`, "", perPage)
    : { keyword: "cover", query: "", results: [] };

  // 并行搜索所有景点
  const spotResults = await Promise.all(keywordList.map((k) => searchForKeyword(k, city, perPage)));

  const result = {
    city,
    searchedAt: new Date().toISOString(),
    cover: {
      keyword: city ? `${city} landscape` : "cover",
      // 取第一张作为推荐封面
      recommended: coverSearch.results[0] || null,
      all: coverSearch.results,
    },
    spots: spotResults.map((r) => ({
      keyword: r.keyword,
      query: r.query,
      recommended: r.results[0] || null,
      all: r.results,
    })),
  };

  const json = JSON.stringify(result, null, 2);

  if (output) {
    const fs = await import("fs");
    fs.writeFileSync(output, json, "utf-8");
    console.log(`✅ 搜索完成，已保存到 ${output}`);
    console.log(`   封面: ${result.cover.recommended ? result.cover.recommended.url : "无结果"}`);
    for (const s of result.spots) {
      console.log(
        `   ${s.keyword}: ${s.recommended ? s.recommended.url : "⚠️ 无结果，将使用占位色块"}`,
      );
    }
  } else {
    console.log(json);
  }
}

main();
