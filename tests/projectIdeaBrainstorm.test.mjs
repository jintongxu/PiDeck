import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modal = readFileSync("src/renderer/src/components/projectIdeas/ProjectIdeasModal.tsx", "utf8");
const plansHook = readFileSync("src/renderer/src/hooks/useProjectIdeaPlans.ts", "utf8");
const types = readFileSync("src/shared/types/projectIdea.ts", "utf8");
const store = readFileSync("src/main/projects/ProjectIdeaStore.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");

test("project ideas expose a persisted brainstorm kind with a legacy implementation fallback", () => {
  assert.match(types, /export type ProjectIdeaKind = "implementation" \| "brainstorm"/);
  assert.match(types, /kind: ProjectIdeaKind/);
  assert.match(store, /kind: isKind\(candidate\.kind\) \? candidate\.kind : "implementation"/);
  assert.match(store, /const kind = isKind\(input\.kind\) \? input\.kind : "implementation"/);
});

test("brainstorm ideas summarize privately and reuse one idea for implementation", () => {
  assert.match(modal, /selected\.kind === "brainstorm"/);
  assert.match(modal, /formatProjectIdeaForDiscussion/);
  assert.match(modal, /selectedCanExtractPlans = selected\?\.kind === "brainstorm"/);
  assert.match(modal, /kind: "implementation"/);
  assert.match(modal, /selectedIdRef\.current !== sourceIdeaId/);
  assert.match(modal, /plans\.cancel\(\)/);
  assert.match(modal, /disabled=\{executionInFlight \|\| plans\.running \|\| startingPlansSource\}/);
  assert.match(plansHook, /Waits on Jotai's per-session message\/runtime atoms/);
  assert.match(plansHook, /PROJECT_IDEA_PLANS_SOURCE_SESSION_UNAVAILABLE/);
  assert.match(plansHook, /disposable, no-tools Pi runtime/);
  assert.match(plansHook, /noTools: true/);
  assert.match(plansHook, /pendingWaitCancelRef/);
  assert.match(plansHook, /store\.sub\(messagesAtom, check\)/);
  assert.match(plansHook, /onRuntimeEvent\(checkRuntimeEvent\)/);
  assert.doesNotMatch(plansHook, /setTimeout/);
  assert.doesNotMatch(plansHook, /SUMMARY_TIMEOUT_MS/);
  assert.match(plansHook, /cleanupSummarySession\(request\.sessionId\)/);
  assert.match(plansHook, /store\.get\(sessionMessageCacheBySessionIdAtomFamily\(summarySession\.id\)\)/);
  assert.doesNotMatch(modal, /ProjectIdeaPlansPanel/);
  assert.match(modal, /derivedFromIdeaId/);
  assert.match(modal, /buildProjectIdeaHierarchy\(ideas, filter\)/);
  assert.match(modal, /<ProjectIdeaTree/);
  assert.match(modal, /derivedFromIdeaId: parentDraft\.id/);
  assert.match(modal, /linkedSessionIds = Array\.from\(new Set\(\[\.\.\.snapshot\.linkedSessionIds, targetSessionId\]\)\)/);
  assert.match(modal, /kind: "implementation"/);
  assert.match(modal, /selected\.kind === "brainstorm"/);
  assert.doesNotMatch(app, /autoSessionTitle: true/);
});
