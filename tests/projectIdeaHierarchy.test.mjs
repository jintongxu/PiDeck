import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/utils/projectIdeaHierarchy.ts", "utf8");
	const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports }, { filename: "projectIdeaHierarchy.ts" });
	return module.exports;
}
const { buildProjectIdeaHierarchy } = loadModule();
const idea = (id, parent, updatedAt, status = "planned", projectId = "p") => ({ id, projectId, title: id, body: "", kind: "implementation", status, tags: [], linkedSessionIds: [], createdAt: updatedAt - 1, updatedAt, ...(parent === undefined ? {} : { derivedFromIdeaId: parent }) });
const ids = (nodes) => JSON.parse(JSON.stringify(nodes.map((node) => [node.idea.id, ids(node.children)])));

test("builds roots and arbitrarily deep parent/child trees", () => {
	const tree = buildProjectIdeaHierarchy([idea("root", undefined, 1), idea("child", "root", 2), idea("grandchild", "child", 3)]);
	assert.deepEqual(ids(tree), [["root", [["child", [["grandchild", []]]]]]]);
});

test("all filter preserves hierarchy across every status for aggregate overviews", () => {
	const tree = buildProjectIdeaHierarchy([idea("root", undefined, 1, "done"), idea("child", "root", 2, "doing"), idea("grandchild", "child", 3, "inbox")], "all");
	assert.deepEqual(ids(tree), [["root", [["child", [["grandchild", []]]]]]]);
	assert.equal(tree[0].contextOnly, false);
});

test("keeps matching descendants and marks nonmatching ancestors as context-only", () => {
	const tree = buildProjectIdeaHierarchy([idea("root", undefined, 1, "done"), idea("child", "root", 2, "doing")], "active");
	assert.equal(tree[0].idea.id, "root");
	assert.equal(tree[0].contextOnly, true);
	assert.equal(tree[0].children[0].idea.id, "child");
});

test("orphan and cross-project parents become roots", () => {
	const tree = buildProjectIdeaHierarchy([idea("orphan", "missing", 2), idea("other", "parent", 3, "planned", "q"), idea("parent", undefined, 1)]);
	assert.deepEqual(JSON.parse(JSON.stringify(tree.map((node) => node.idea.id))), ["other", "orphan", "parent"]);
});

test("self references and cycles are safe roots without duplication", () => {
	const tree = buildProjectIdeaHierarchy([idea("a", "a", 1), idea("b", "c", 3), idea("c", "b", 2)]);
	assert.deepEqual(JSON.parse(JSON.stringify(tree.map((node) => node.idea.id))), ["b", "c", "a"]);
	assert.equal(tree.flatMap((node) => [node, ...node.children]).length, 3);
});

test("sorts each sibling group by updatedAt, then createdAt/id", () => {
	const tree = buildProjectIdeaHierarchy([idea("a", undefined, 5), idea("z", undefined, 5), idea("b", undefined, 9), idea("child-old", "b", 1), idea("child-new", "b", 4)]);
	assert.deepEqual(JSON.parse(JSON.stringify(tree.map((node) => node.idea.id))), ["b", "a", "z"]);
	assert.deepEqual(JSON.parse(JSON.stringify(tree[0].children.map((node) => node.idea.id))), ["child-new", "child-old"]);
});
