#!/usr/bin/env node
/** Add the private PiDeck Plan/Act control bridge to pi-maestro-flow. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PLAN_ENTER_MARKER = "__pideck_maestro_plan_enter__";
const PLAN_EXIT_MARKER = "__pideck_maestro_plan_exit__";
const packageCandidates = [
  process.env.PIDECK_PI_MAESTRO_FLOW_PATH,
  process.env.PI_MAESTRO_FLOW_PATH,
  process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "pi-maestro-flow") : undefined,
  process.env.PI_AGENT_DIR ? join(process.env.PI_AGENT_DIR, "npm", "node_modules", "pi-maestro-flow") : undefined,
  join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-maestro-flow"),
].filter((value) => typeof value === "string").map((value) => resolve(value));

function resolveExtensionPath() {
  for (const packageDir of [...new Set(packageCandidates)]) {
    const path = join(packageDir, "src", "extension", "index.ts");
    if (existsSync(path)) return path;
  }
  return undefined;
}

const extensionPath = resolveExtensionPath();
if (!extensionPath) {
  console.log("[patch-pi-maestro-plan] pi-maestro-flow not installed; skipped");
  process.exit(0);
}

const original = readFileSync(extensionPath, "utf8");
const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
let source = original.replaceAll("\r\n", "\n");
const marker = `  // PiDeck RPC control: switch Maestro Plan/Act without creating a user prompt.\n  pi.on("input", async (event, ctx) => {\n    if (event.source !== "rpc") return;\n    const input = event.text.trim();\n    if (input === "${PLAN_ENTER_MARKER}" || input.startsWith("${PLAN_ENTER_MARKER}\\n")) {\n      if (!isPlanMode()) await planToggleMode(ctx);\n      const followUp = input.slice("${PLAN_ENTER_MARKER}".length).trim();\n      if (followUp) await ctx.sendUserMessage(followUp);\n      return { action: "handled" as const };\n    }\n    if (input === "${PLAN_EXIT_MARKER}") {\n      await planExitMode(ctx);\n      return { action: "handled" as const };\n    }\n    return;\n  });\n\n`;

if (source.includes(PLAN_ENTER_MARKER) && source.includes(PLAN_EXIT_MARKER)) {
  const normalized = source
    .replace(/(?:if \(!isPlanMode\(\)\) )+await planToggleMode\(ctx\);\n\s*const followUp/u, "if (!isPlanMode()) await planToggleMode(ctx);\n      const followUp")
    .replace("if (followUp) ctx.sendUserMessage(followUp);", "if (followUp) await ctx.sendUserMessage(followUp);");
  if (normalized !== source) {
    writeFileSync(extensionPath, normalized.replaceAll("\n", lineEnding), "utf8");
    console.log(`[patch-pi-maestro-plan] normalized: ${extensionPath}`);
  } else {
    console.log(`[patch-pi-maestro-plan] already patched: ${extensionPath}`);
  }
  process.exit(0);
}

const anchor = `  pi.on("input", (event) => {\n    return goalInput(event);\n  });`;
if (!source.includes(anchor)) {
  throw new Error("goal input anchor not found in pi-maestro-flow extension");
}
source = source.replace(anchor, `${marker}${anchor}`);
writeFileSync(extensionPath, source.replaceAll("\n", lineEnding), "utf8");
console.log(`[patch-pi-maestro-plan] patched: ${extensionPath}`);
