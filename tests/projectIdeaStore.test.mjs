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
		const idea = await store.create({
			projectId: "project-1",
			title: "Extract the provider adapter",
			body: "Do this after the current bug fix.",
			tags: ["architecture", "architecture", ""],
			sourceSessionId: "session-1",
			sourceMessageId: "message-1",
			sourceKind: "selection",
		}, 1_000);
		assert.equal(idea.status, "inbox");
		assert.deepEqual(Array.from(idea.tags), ["architecture"]);
		assert.equal(idea.sourceSessionId, "session-1");
		assert.equal(idea.sourceMessageId, "message-1");
		assert.equal(idea.sourceKind, "selection");

		const planned = await store.update(idea.id, { status: "planned", title: "Extract adapter" }, 2_000);
		assert.equal(planned.status, "planned");
		assert.equal(planned.completedAt, undefined);

		const done = await store.update(idea.id, { status: "done" }, 3_000);
		assert.equal(done.completedAt, 3_000);
		assert.equal((await store.list("project-1")).length, 1);

		const reloaded = new ProjectIdeaStore(path);
		await reloaded.load();
		const reloadedIdea = (await reloaded.list("project-1"))[0];
		assert.equal(reloadedIdea.title, "Extract adapter");
		assert.equal(reloadedIdea.sourceSessionId, "session-1");
		assert.equal(reloadedIdea.sourceMessageId, "message-1");
		assert.equal(reloadedIdea.sourceKind, "selection");
		assert.equal(await reloaded.deleteByProjectIds(["project-1", "worktree-1"]), 1);
		assert.equal((await reloaded.list()).length, 0);
		assert.match(await readFile(path, "utf8"), /\"ideas\": \[\]/);
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
		assert.deepEqual(Array.from((await store.list("p")).map((idea) => idea.id)), ["ok"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
