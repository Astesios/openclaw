#!/usr/bin/env tsx
/**
 * Copy lushu plugin runtime assets (scripts/, assets/icons/) into dist so the
 * compiled plugin can locate them via SCRIPTS_DIR / icons path.
 * tsdown only bundles .ts source; static .mjs/.sh/.svg next to the plugin
 * package root would otherwise be lost.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

const PLUGIN_ID = "lushu";
const srcPluginDir = path.join(context.projectRoot, "extensions", PLUGIN_ID);
const distPluginDir = path.join(context.projectRoot, "dist", "extensions", PLUGIN_ID);

const COPY_SUBPATHS = [
  ["scripts", "scripts"],
  ["assets/icons", "assets/icons"],
  ["assets/references", "assets/references"],
] as const;

function copyDir(src: string, dest: string): number {
  ensureDirectory(dest);
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      fs.copyFileSync(srcPath, destPath);
      const srcStat = fs.statSync(srcPath);
      fs.chmodSync(destPath, srcStat.mode);
      count += 1;
    }
  }
  return count;
}

function run(): void {
  if (!fs.existsSync(srcPluginDir)) {
    console.warn(`${context.prefix} lushu plugin source not found:`, srcPluginDir);
    return;
  }
  if (!fs.existsSync(distPluginDir)) {
    console.warn(
      `${context.prefix} lushu plugin dist not found (tsdown must run first):`,
      distPluginDir,
    );
    return;
  }
  let total = 0;
  for (const [srcRel, destRel] of COPY_SUBPATHS) {
    const src = path.join(srcPluginDir, srcRel);
    const dest = path.join(distPluginDir, destRel);
    if (!fs.existsSync(src)) {
      console.warn(`${context.prefix} skip missing source: ${srcRel}`);
      continue;
    }
    const copied = copyDir(src, dest);
    total += copied;
    logVerboseCopy(context, `Copied ${copied} file(s) from ${srcRel} → ${destRel}`);
  }
  console.log(`${context.prefix} copied ${total} lushu plugin asset file(s)`);
}

run();
