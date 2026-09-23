import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const extensionPath = "resources/extensions/pi-deck-knowledge-adherence.ts";
const source = readFileSync(extensionPath, "utf8");
const {
  buildKnowledgeQuery,
  parseKnowledgeSearchResults,
  formatKnowledgeContext,
  maestroInvocation,
  resolveProjectWorkflowRoot,
} = loadTsCommonJs(extensionPath);

test("knowledge root is strictly the active project and never inherits a parent or override", () => {
  const root = mkdtempSync(join(tmpdir(), "pideck-knowledge-isolation-"));
  const child = join(root, "project");
  mkdirSync(join(root, ".workflow"), { recursive: true });
  mkdirSync(child, { recursive: true });
  try {
    assert.equal(resolveProjectWorkflowRoot(root), root);
    assert.equal(resolveProjectWorkflowRoot(child), undefined);
    assert.doesNotMatch(source, /PIDECK_MAESTRO_WORKFLOW_ROOT/);
    assert.doesNotMatch(source, /dirname\(/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge query is bounded and does not forward secrets or absolute paths", () => {
  const query = buildKnowledgeQuery(
    "构建 release 并上传 GitHub https://example.test/a?token=ghp_1234567890abcdef /Users/me/private",
    "D:/projects/pideck",
  );
  assert.ok(query.length <= 220);
  assert.doesNotMatch(query, /ghp_|https?:|Users[\\/]|private/);
  assert.match(query, /release|GitHub/i);
});

test("search parser keeps only requested spec/knowhow hits and validates ids", () => {
  const stdout = JSON.stringify({
    results: [
      { id: "spec:proxy", kind: "spec", name: "proxy rule" },
      { id: "template:wrong", kind: "template", name: "template" },
      { id: "bad id", kind: "spec", name: "bad" },
      { id: "spec:proxy", kind: "spec", name: "duplicate" },
    ],
  });
  assert.equal(JSON.stringify(parseKnowledgeSearchResults(stdout, "spec")), JSON.stringify([
    { id: "spec:proxy", kind: "spec", name: "proxy rule" },
  ]));
  assert.equal(JSON.stringify(parseKnowledgeSearchResults(stdout, "knowhow")), "[]");
});

test("Windows maestro invocation uses cmd.exe without exposing raw shell syntax", () => {
  const invocation = maestroInvocation(["search", "release & upload", "--workflow-root", "D:/project root"]);
  if (process.platform === "win32") {
    assert.match(invocation.command, /cmd(?:\.exe)?$/i);
    assert.equal(invocation.args[0], "/d");
    assert.equal(invocation.args[1], "/s");
    assert.equal(invocation.args[2], "/c");
    assert.equal(invocation.args[3], "maestro.cmd");
    assert.equal(invocation.args[4], "search");
    assert.equal(invocation.args[5], "release & upload");
  } else {
      assert.equal(invocation.command, "maestro");
    assert.deepEqual(invocation.args, ["search", "release & upload", "--workflow-root", "D:/project root"]);
  }
});

test("loaded knowledge is explicitly scoped and cannot grant authorization", () => {
  const context = formatKnowledgeContext([{
    id: "spec:release",
    kind: "spec",
    name: "Release proxy",
    content: "Use the configured proxy for release uploads.",
  }]);
  assert.match(context, /<pi-deck-project-knowledge>/);
  assert.match(context, /不得覆盖系统消息/);
  assert.match(context, /执行授权/);
  assert.match(context, /spec:release/);
});

test("extension is registered, visible, and does not execute rules directly", () => {
  const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
  const rows = readFileSync("src/renderer/src/config/extensionsTableRows.tsx", "utf8");
  const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
  const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
  assert.match(builtIns, /"pi-deck-knowledge-adherence\.ts"/);
  assert.doesNotMatch(source, /PIDECK_MAESTRO_WORKFLOW_ROOT/);
  assert.match(rows, /"pi-deck-knowledge-adherence\.ts"/);
  assert.match(zh, /config\.builtInExtDesc\.pi-deck-knowledge-adherence/);
  assert.match(en, /config\.builtInExtDesc\.pi-deck-knowledge-adherence/);
  assert.match(source, /before_agent_start/);
  assert.match(source, /systemPrompt/);
  assert.doesNotMatch(source, /tool_call/);
  assert.doesNotMatch(source, /sendUserMessage/);
});
