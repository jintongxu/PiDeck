import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createRuntimeHarness() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set("agent-1", {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			createdAt: 1,
		},
		process: {
			client: {
				request: async () => ({ success: true, data: {} }),
			},
		},
	});
	return manager;
}

test("agent_end keeps the logical turn closed while runtime bookkeeping continues", async () => {
	const manager = createRuntimeHarness();

	manager.handlePiEvent("agent-1", { type: "agent_start" });
	assert.equal((await manager.getRuntimeState("agent-1")).isTurnActive, true);

	manager.handlePiEvent("agent-1", { type: "agent_end", messages: [] });
	assert.equal(manager.agents.get("agent-1")?.tab.status, "running");
	assert.equal(
		(await manager.getRuntimeState("agent-1")).isTurnActive,
		false,
		"a later compaction/idle check must not reopen the completed answer turn",
	);
});

test("abort-shaped agent_end skips the error diagnostic and emits an abort notice", () => {
	const manager = createRuntimeHarness();
	let diagnostics = 0;
	let abortNotices = 0;
	manager.addDetailedErrorMessage = () => { diagnostics += 1; };
	manager.notifyAgentAborted = () => { abortNotices += 1; };

	manager.handlePiEvent("agent-1", {
		type: "agent_end",
		stopReason: "error",
		errorMessage: "This operation was aborted",
		messages: [],
	});

	assert.equal(diagnostics, 0, "an abort must not become diagnostic.requestFailed");
	assert.equal(abortNotices, 1, "an abort must notify through the notification path");
});

test("genuine agent_end errors still create the error diagnostic", () => {
	const manager = createRuntimeHarness();
	let diagnostics = 0;
	let abortNotices = 0;
	manager.addDetailedErrorMessage = () => { diagnostics += 1; };
	manager.notifyAgentAborted = () => { abortNotices += 1; };

	manager.handlePiEvent("agent-1", {
		type: "agent_end",
		stopReason: "error",
		errorMessage: "Provider returned HTTP 500",
		messages: [],
	});

	assert.equal(diagnostics, 1);
	assert.equal(abortNotices, 0);
});
