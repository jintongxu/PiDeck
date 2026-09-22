import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const mainCopy = readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8");

test("provider/request errors trigger a deduplicated system notification", () => {
  assert.match(agentManager, /private readonly notifiedErrorAgents = new Set<string>\(\);/);
  assert.match(agentManager, /this\.notifiedErrorAgents\.delete\(agentId\);/);
  assert.match(agentManager, /this\.notifyAgentError\(agentId\);/);
  assert.match(agentManager, /private notifyAgentError\(agentId: string\): void/);
  assert.match(agentManager, /if \(this\.notifiedErrorAgents\.has\(agentId\)\) return;/);
  assert.match(agentManager, /this\.notifiedErrorAgents\.add\(agentId\);/);
  assert.match(mainCopy, /"mainNotification\.sessionError":/);
});
