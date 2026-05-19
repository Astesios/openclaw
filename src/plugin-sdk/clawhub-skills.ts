// Real plugin-sdk surface for ClawHub skill discovery + install. Lives here
// because OpenClaw's runtime alias generator (`src/plugin-sdk/root-alias.cjs`)
// resolves `openclaw/plugin-sdk/<name>` to `dist/plugin-sdk/<name>.js`, which
// is built from this source file. The `packages/plugin-sdk/src/clawhub-skills.ts`
// barrel re-exports from here so plugin authors can `import from
// "openclaw/plugin-sdk/clawhub-skills"` cleanly.
export * from "../agents/skills-clawhub.js";
// Lower-level ClawHub helpers that the agent layer doesn't re-export.
export { fetchClawHubSkillDetail, resolveClawHubBaseUrl } from "../infra/clawhub.js";
export type { ClawHubSkillDetail } from "../infra/clawhub.js";
