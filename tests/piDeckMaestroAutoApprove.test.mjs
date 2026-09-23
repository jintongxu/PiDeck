import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const extensionPath = "resources/extensions/pi-deck-maestro-auto-approve.ts";

function createHarness(choice) {
  const handlers = new Map();
  let customCalls = 0;
  const ui = {
    select: async () => choice,
    custom: async () => {
      customCalls += 1;
      return "native-custom-result";
    },
    setWidget: () => {},
  };
  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const output = ts.transpileModule(readFileSync(extensionPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: extensionPath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
    console,
    Reflect,
    Promise,
  }, { filename: extensionPath });
  module.exports.default(pi);
  const ctx = { mode: "rpc", ui };
  return {
    ctx,
    handlers,
    customCalls: () => customCalls,
  };
}

async function installBridge(harness) {
  await harness.handlers.get("session_start")[0]({}, harness.ctx);
}

async function choosePlanAction(harness) {
  const toolCallHandlers = harness.handlers.get("tool_call");
  await toolCallHandlers.at(-1)({ toolName: "plan-confirm" }, harness.ctx);
}

test("Plan approval stays in one upstream plan-confirm execution", async () => {
  const harness = createHarness("Execute / 执行");
  await installBridge(harness);
  await choosePlanAction(harness);

  const decision = await harness.ctx.ui.custom(() => undefined);
  assert.equal(decision.action, "execute");
  assert.equal(decision.execution.backend, "standalone");
  assert.equal(decision.execution.context, "current");
  assert.equal(harness.customCalls(), 0, "PiDeck must not enter a second approval flow");
});

test("Plan discussion and exit decisions are returned to upstream custom UI", async () => {
  for (const [choice, action] of [
    ["Continue discussion / 继续讨论", "continue"],
    ["Exit Plan mode / 退出计划模式", "exit-plan"],
  ]) {
    const harness = createHarness(choice);
    await installBridge(harness);
    await choosePlanAction(harness);
    const decision = await harness.ctx.ui.custom(() => undefined);
    assert.equal(decision.action, action);
    assert.equal(harness.customCalls(), 0);
  }
});

test("Plan adapter falls back to the native custom UI outside its decision window", async () => {
  const harness = createHarness("Execute / 执行");
  await installBridge(harness);
  const nativeResult = await harness.ctx.ui.custom(() => undefined);
  assert.equal(nativeResult, "native-custom-result");
  assert.equal(harness.customCalls(), 1);
});
