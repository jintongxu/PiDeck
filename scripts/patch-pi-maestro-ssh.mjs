#!/usr/bin/env node
/** Adapt pi-maestro-flow SSH UI to PiDeck's RPC input/select protocol. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const packageCandidates = [
  process.env.PIDECK_PI_MAESTRO_FLOW_PATH,
  process.env.PI_MAESTRO_FLOW_PATH,
  process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "pi-maestro-flow") : undefined,
  process.env.PI_AGENT_DIR ? join(process.env.PI_AGENT_DIR, "npm", "node_modules", "pi-maestro-flow") : undefined,
  join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-maestro-flow"),
].filter((value) => typeof value === "string").map((value) => resolve(value));

function resolveExtensionPath() {
  for (const packageDir of [...new Set(packageCandidates)]) {
    const path = join(packageDir, "src", "ssh-manager", "extension.ts");
    if (existsSync(path)) return path;
  }
  return undefined;
}

const extensionPath = resolveExtensionPath();
if (!extensionPath) {
  console.log("[patch-pi-maestro-ssh] pi-maestro-flow not installed; skipped");
  process.exit(0);
}

const original = readFileSync(extensionPath, "utf8");
const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
let source = original.replaceAll("\r\n", "\n");
let changed = false;

const rpcManager = `async function runRpcManager(
  ctx: ExtensionContext,
  store: EncryptedSshStore,
  bindings: ManagerBindings,
): Promise<void> {
  const hosts = store.getHosts();
  if (hosts.length === 0) {
    ctx.ui.notify("No SSH servers configured. Open /ssh in a native Pi terminal to add one.", "warning");
    return;
  }
  const selectedId = bindings.selectedId();
  const rows = hosts.map((host) =>
    host.label + (selectedId === host.id ? " (current)" : "") + " · " + host.user + "@" + formatSshAddress(host.host, host.port) + " · " + host.shell + " · id=" + host.id,
  );
  const answer = await ctx.ui.select("[pideck-ssh-hosts] Select SSH server", rows);
  const index = answer === undefined ? -1 : rows.indexOf(answer);
  if (index < 0) return;
  bindings.select(hosts[index]);
}`;

const rpcStart = source.indexOf("async function runRpcManager(");
const ensureStart = source.indexOf("function ensureUnlocked(");
const unlockImplStart = source.indexOf("async function unlockSshManager(");
if (rpcStart >= 0 && ensureStart > rpcStart) {
  const currentRpc = source.slice(rpcStart, ensureStart).trimEnd();
  if (currentRpc !== rpcManager) {
    source = source.slice(0, rpcStart) + rpcManager + "\n\n" + source.slice(ensureStart);
    changed = true;
  }
} else if (ensureStart >= 0) {
  source = source.slice(0, ensureStart) + rpcManager + "\n\n" + source.slice(ensureStart);
  changed = true;
} else if (unlockImplStart < 0) {
  throw new Error("ensureUnlocked anchor not found in pi-maestro-flow SSH manager");
}

// Multiple UI requests can arrive while the first password dialog is open. Normalize
// any previously patched wrapper, then keep one shared decrypt promise for all callers.
const unlockImplementation = "async function unlockSshManager(ctx: ExtensionContext, store: EncryptedSshStore): Promise<boolean> {";
const ensureSignature = "async function ensureUnlocked(ctx: ExtensionContext, store: EncryptedSshStore): Promise<boolean> {";
const normalizedEnsureStart = source.indexOf("function ensureUnlocked(");
const normalizedUnlockStart = source.indexOf(unlockImplementation);
const unlockPromiseDeclaration = source.indexOf("let sshUnlockPromise: Promise<boolean> | undefined;");
const unlockWrapper = `let sshUnlockPromise: Promise<boolean> | undefined;

function ensureUnlocked(ctx: ExtensionContext, store: EncryptedSshStore): Promise<boolean> {
  if (sshUnlockPromise) return sshUnlockPromise;
  const promise = unlockSshManager(ctx, store);
  sshUnlockPromise = promise;
  void promise.then(
    () => { if (sshUnlockPromise === promise) sshUnlockPromise = undefined; },
    () => { if (sshUnlockPromise === promise) sshUnlockPromise = undefined; },
  );
  return promise;
}

`;
if (normalizedUnlockStart >= 0) {
  const cleanupStart = normalizedEnsureStart >= 0 && normalizedEnsureStart < normalizedUnlockStart
    ? normalizedEnsureStart
    : unlockPromiseDeclaration >= 0 && unlockPromiseDeclaration < normalizedUnlockStart
      ? unlockPromiseDeclaration
      : -1;
  if (cleanupStart >= 0) {
    source = source.slice(0, cleanupStart) + unlockWrapper + source.slice(normalizedUnlockStart);
    changed = true;
  } else if (normalizedEnsureStart < 0) {
    source = source.slice(0, normalizedUnlockStart) + unlockWrapper + source.slice(normalizedUnlockStart);
    changed = true;
  }
} else if (source.includes(ensureSignature)) {
  source = source.replace(ensureSignature, unlockWrapper + unlockImplementation);
  changed = true;
} else {
  throw new Error("ensureUnlocked implementation anchor not found in pi-maestro-flow SSH manager");
}

// RPC needs the standard select dialog; native Pi retains the full TUI manager.
if (!source.includes("await runRpcManager(ctx, store, bindings);")) {
  const runRpcAnchor = `  if (!await ensureUnlocked(ctx, store)) return;\n  monitor.reconcile();\n  let query = "";`;
  const runRpcReplacement = `  if (!await ensureUnlocked(ctx, store)) return;\n  monitor.reconcile();\n  if (ctx.mode === "rpc") {\n    await runRpcManager(ctx, store, bindings);\n    return;\n  }\n  let query = "";`;
  if (!source.includes(runRpcAnchor)) throw new Error("runManager anchor not found in pi-maestro-flow SSH manager");
  source = source.replace(runRpcAnchor, runRpcReplacement);
  changed = true;
}

const secretPattern = /function showSecretInput\([\s\S]*?\n}\n\nfunction showManagerOverlay/;
const secretReplacement = `function showSecretInput(
  ctx: ExtensionContext,
  title: string,
  prompt: string,
): Promise<string | undefined> {
  if (ctx.mode === "rpc") {
    return ctx.ui.input("[pideck-secret] [pideck-ssh-secret] " + title, prompt);
  }
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new MaskedSecretInput({
    title,
    prompt,
    theme: theme as SshManagerTheme,
    requestRender: () => tui.requestRender(),
    done,
  }), { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "50%" } });
}

function showManagerOverlay`;
if (!source.includes("[pideck-ssh-secret]") || !source.match(secretPattern)?.[0].includes("ctx.mode === \"rpc\"")) {
  if (!secretPattern.test(source)) throw new Error("showSecretInput anchor not found in pi-maestro-flow SSH manager");
  source = source.replace(secretPattern, secretReplacement);
  changed = true;
}

const oldInputSource = 'if (event.source !== "interactive" || (event.images?.length ?? 0) > 0) return;';
const newInputSource = 'if (event.source !== "interactive" && event.source !== "rpc" || (event.images?.length ?? 0) > 0) return;';
if (source.includes(oldInputSource)) {
  source = source.replace(oldInputSource, newInputSource);
  changed = true;
}

if (!source.includes("const isPiDeckControl = input === \"__pideck_ssh_control__\"")) {
  const inputAnchor = `    const input = event.text.trim();\n    const isLegacyPicker = input.toLowerCase() === "#ssh";\n    const canonicalMatch = /^#ssh:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(input);\n    if (!isLegacyPicker && !canonicalMatch) return;\n    activeContext = ctx;`;
  const inputReplacement = `    const input = event.text.trim();\n    const isPiDeckControl = input === "__pideck_ssh_control__";\n    const isLegacyPicker = input.toLowerCase() === "#ssh";\n    const canonicalMatch = /^#ssh:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(input);\n    if (!isPiDeckControl && !isLegacyPicker && !canonicalMatch) return;\n    activeContext = ctx;\n\n    if (isPiDeckControl) {\n      if (!await ensureUnlocked(ctx, store)) return { action: "handled" as const };\n      monitor.reconcile();\n      await runRpcManager(ctx, store, {\n        selectedId: () => selected?.id,\n        select: (host) => selectHost(host, ctx),\n        clear: () => clearSelection(ctx),\n        invalidate: (hostId) => gatewayPool.invalidateHost(hostId),\n        invalidateAll: () => gatewayPool.close(),\n      });\n      return { action: "handled" as const };\n    }`;
  if (!source.includes(inputAnchor)) throw new Error("input anchor not found in pi-maestro-flow SSH manager");
  source = source.replace(inputAnchor, inputReplacement);
  changed = true;
}

if (source === original.replaceAll("\r\n", "\n")) changed = false;
if (!changed) {
  console.log(`[patch-pi-maestro-ssh] already patched: ${extensionPath}`);
  process.exit(0);
}
writeFileSync(extensionPath, source.replaceAll("\n", lineEnding), "utf8");
console.log(`[patch-pi-maestro-ssh] patched: ${extensionPath}`);
