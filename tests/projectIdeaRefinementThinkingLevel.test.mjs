import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeProjectIdeaRefinementThinkingLevel } = loadTsCommonJs(
  "src/shared/projectIdeaRefinement.ts",
);

test("project-idea reasoning effort keeps valid and future provider ids", () => {
  assert.equal(normalizeProjectIdeaRefinementThinkingLevel(" high "), "high");
  assert.equal(normalizeProjectIdeaRefinementThinkingLevel("provider-future-tier"), "provider-future-tier");
  assert.equal(normalizeProjectIdeaRefinementThinkingLevel("   "), "");
  assert.equal(normalizeProjectIdeaRefinementThinkingLevel(7), "");
  assert.equal(normalizeProjectIdeaRefinementThinkingLevel("x".repeat(65)), "");
});

test("project-idea reasoning effort is persisted, rendered, and passed to refinement runtime", () => {
  const settings = readFileSync("src/shared/types/settings.ts", "utf8");
  const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
  const config = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
  const ideas = readFileSync("src/renderer/src/components/projectIdeas/ProjectIdeasModal.tsx", "utf8");
  const hook = readFileSync("src/renderer/src/hooks/useProjectIdeaRefinement.ts", "utf8");

  assert.match(settings, /projectIdeaRefinementThinkingLevel: string/);
  assert.match(store, /normalizeProjectIdeaRefinementThinkingLevel\(parsed\.projectIdeaRefinementThinkingLevel\)/);
  assert.match(store, /normalizeProjectIdeaRefinementThinkingLevel\(safePatch\.projectIdeaRefinementThinkingLevel\)/);
  assert.match(config, /settings\.projectIdeaRefinementThinkingLevel/);
  assert.match(config, /onProjectIdeaRefinementThinkingLevelChange/);
  assert.match(config, /selectedIdeaModel\.thinkingLevels\.includes\(projectIdeaRefinementThinkingLevel\)/);
  assert.match(ideas, /refinementThinkingLevel\?: string/);
  assert.match(ideas, /thinkingLevel: refinementThinkingLevel/);
  assert.match(hook, /thinkingLevel\?: string/);
  assert.match(hook, /input\.thinkingLevel \? \{ thinkingLevel: input\.thinkingLevel \} : \{\}/);
});

test("empty project-idea reasoning effort keeps the model default", () => {
  const ideas = readFileSync("src/renderer/src/components/projectIdeas/ProjectIdeasModal.tsx", "utf8");
  const hook = readFileSync("src/renderer/src/hooks/useProjectIdeaRefinement.ts", "utf8");
  assert.match(ideas, /\.\.\.\(refinementThinkingLevel \? \{ thinkingLevel: refinementThinkingLevel \} : \{\}\)/);
  assert.match(hook, /\.\.\.\(input\.thinkingLevel \? \{ thinkingLevel: input\.thinkingLevel \} : \{\}\)/);
});
