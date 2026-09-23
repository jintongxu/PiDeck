import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ProjectIdeaStore } = loadTsCommonJs("src/main/projects/ProjectIdeaStore.ts");

test("ProjectIdeaStore persists the lightweight workflow and cascades by project", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-project-ideas-"));
	const path = join(dir, "project-ideas.json");
	try {
		const store = new ProjectIdeaStore(path);
		await store.load();
		const parent = await store.create({ projectId: "project-1", title: "Source brainstorm" }, 900);
		const idea = await store.create({
			projectId: "project-1",
			title: "Extract the provider adapter",
			body: "Do this after the current bug fix.",
			kind: "brainstorm",
			derivedFromIdeaId: parent.id,
			selectedPlanId: "plan-1",
			tags: ["architecture", "architecture", ""],
			sourceSessionId: "session-1",
			sourceMessageId: "message-1",
			sourceKind: "selection",
		}, 1_000);
		assert.equal(idea.status, "inbox");
		assert.equal(idea.kind, "brainstorm");
		assert.equal(idea.derivedFromIdeaId, parent.id);
		assert.equal(idea.selectedPlanId, "plan-1");
		assert.deepEqual(Array.from(idea.tags), ["architecture"]);
		assert.equal(idea.sourceSessionId, "session-1");
		assert.equal(idea.sourceMessageId, "message-1");
		assert.equal(idea.sourceKind, "selection");

		const refinement = {
			summary: "Extract the adapter",
			problem: "The provider logic is coupled",
			goal: "Isolate provider behavior",
			expectedOutcome: "Smaller modules",
			scope: ["Move provider code"],
			acceptanceCriteria: ["Typecheck passes"],
			openQuestions: [],
			generatedAt: 1_500,
		};
		const clarified = await store.update(idea.id, { refinement }, 1_500);
		assert.equal(clarified.refinement.generatedAt, 1_500);
		const implementation = await store.update(idea.id, { kind: "implementation" }, 1_600);
		assert.equal(implementation.kind, "implementation");
		const cleared = await store.update(idea.id, { refinement: null }, 1_750);
		assert.equal(cleared.refinement, undefined);

		const planned = await store.update(idea.id, { status: "planned", title: "Extract adapter" }, 2_000);
		assert.equal(planned.status, "planned");
		assert.equal(planned.completedAt, undefined);

		const done = await store.update(idea.id, { status: "done" }, 3_000);
		assert.equal(done.completedAt, 3_000);
		assert.equal((await store.list("project-1")).length, 2);

		const reloaded = new ProjectIdeaStore(path);
		await reloaded.load();
		const reloadedIdea = (await reloaded.list("project-1")).find((candidate) => candidate.id === idea.id);
		assert.equal(reloadedIdea.title, "Extract adapter");
		assert.equal(reloadedIdea.kind, "implementation");
		assert.equal(reloadedIdea.sourceSessionId, "session-1");
		assert.equal(reloadedIdea.sourceMessageId, "message-1");
		assert.equal(reloadedIdea.sourceKind, "selection");
		assert.equal(await reloaded.deleteByProjectIds(["project-1", "worktree-1"]), 2);
		assert.equal((await reloaded.list()).length, 0);
		assert.match(await readFile(path, "utf8"), /\"ideas\": \[\]/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ProjectIdeaStore validates parent existence, project ownership, cycles, and deletion behavior", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-project-ideas-parent-"));
	try {
		const store = new ProjectIdeaStore(join(dir, "ideas.json"));
		const parent = await store.create({ projectId: "p1", title: "Parent" });
		const child = await store.create({ projectId: "p1", title: "Child", derivedFromIdeaId: parent.id });
		await assert.rejects(() => store.create({ projectId: "p1", title: "Missing", derivedFromIdeaId: "missing" }), { message: "PROJECT_IDEA_PARENT_NOT_FOUND" });
		const other = await store.create({ projectId: "p2", title: "Other" });
		await assert.rejects(() => store.update(child.id, { derivedFromIdeaId: other.id }), { message: "PROJECT_IDEA_PARENT_PROJECT_MISMATCH" });
		await assert.rejects(() => store.update(parent.id, { derivedFromIdeaId: parent.id }), { message: "PROJECT_IDEA_PARENT_CYCLE" });
		await assert.rejects(() => store.update(parent.id, { derivedFromIdeaId: child.id }), { message: "PROJECT_IDEA_PARENT_CYCLE" });
		assert.equal((await store.get(parent.id))?.derivedFromIdeaId, undefined);
		await store.update(child.id, { derivedFromIdeaId: null });
		assert.equal((await store.get(child.id))?.derivedFromIdeaId, undefined);
		const retainedChild = await store.create({ projectId: "p1", title: "Retained child", derivedFromIdeaId: parent.id });
		await store.delete(parent.id);
		assert.equal((await store.get(retainedChild.id))?.derivedFromIdeaId, parent.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ProjectIdeaStore does not replace a malformed existing file with an empty store", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-project-ideas-corrupt-"));
	const path = join(dir, "project-ideas.json");
	try {
		await writeFile(path, "{not-json", "utf8");
		const store = new ProjectIdeaStore(path);
		await assert.rejects(() => store.load());
		assert.equal((await readFile(path, "utf8")), "{not-json");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ProjectIdeaStore ignores malformed persisted entries and accepts the legacy array shape", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-project-ideas-legacy-"));
	const path = join(dir, "project-ideas.json");
	try {
		await writeFile(path, JSON.stringify([
			{ id: "ok", projectId: "p", title: "Keep", body: "", status: "inbox", tags: [], linkedSessionIds: [], createdAt: 1, updatedAt: 1 },
			{ id: "bad", projectId: "p", title: "", status: "inbox" },
		]), "utf8");
		const store = new ProjectIdeaStore(path);
		const ideas = await store.list("p");
		assert.deepEqual(Array.from(ideas.map((idea) => idea.id)), ["ok"]);
		assert.equal(ideas[0].kind, "implementation");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
