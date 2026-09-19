import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  normalizeSidebarSessionOrder,
  reorderSidebarSessionIds,
  reorderStableIds,
  sidebarSessionOrderIndex,
} = loadTsCommonJs("src/shared/sidebarSessionOrder.ts");
const toLocalArray = (value) => Array.from(value);

test("侧栏会话顺序清洗非法值、空值和重复 id", () => {
  assert.deepEqual(
    toLocalArray(normalizeSidebarSessionOrder(["a", "", " a ", 1, null, "b"])),
    ["a", "b"],
  );
  assert.deepEqual(toLocalArray(normalizeSidebarSessionOrder(undefined)), []);
});

test("拖动预览支持目标前后插入，其余 id 实时让位", () => {
  assert.deepEqual(toLocalArray(reorderStableIds(["a", "b", "c"], "c", "b", "before")), ["a", "c", "b"]);
  assert.deepEqual(toLocalArray(reorderStableIds(["a", "b", "c"], "a", "b", "after")), ["b", "a", "c"]);
});

test("侧栏会话拖动把源会话移动到目标会话之前", () => {
  assert.deepEqual(
    toLocalArray(reorderSidebarSessionIds(["a", "b", "c"], "c", "a")),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    toLocalArray(reorderSidebarSessionIds(["a", "b", "c"], "a", "c")),
    ["b", "a", "c"],
  );
  assert.deepEqual(toLocalArray(reorderSidebarSessionIds(["a", "b"], "a", "a")), ["a", "b"]);
});

test("未知会话顺序排在已保存会话之后", () => {
  assert.equal(sidebarSessionOrderIndex(["a", "b"], "b"), 1);
  assert.equal(sidebarSessionOrderIndex(["a", "b"], "new"), Number.MAX_SAFE_INTEGER);
  assert.equal(sidebarSessionOrderIndex(["a", "b"], undefined), Number.MAX_SAFE_INTEGER);
});

test("活动与聊天使用独立顺序并可由设置字段接线", () => {
  const settings = readFileSync("src/shared/types/settings.ts", "utf8");
  const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
  const sidebar = readFileSync("src/renderer/src/components/sidebar/AppSidebar.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  assert.match(settings, /sidebarSessionOrder\?:/);
  assert.match(settings, /active\?: string\[\]/);
  assert.match(settings, /chat\?: string\[\]/);
  assert.match(store, /normalizeSidebarSessionOrder\(parsed\.sidebarSessionOrder\?\.active\)/);
  assert.match(store, /normalizeSidebarSessionOrder\(parsed\.sidebarSessionOrder\?\.chat\)/);
  assert.match(sidebar, /settingsSidebarSessionOrder/);
  assert.match(sidebar, /desktopApi\.settings\.update\(\{ sidebarSessionOrder \}\)/);
  assert.match(controller, /reorderSidebarSessions/);
  assert.match(controller, /startSessionDrag/);
});

test("聊天与活动树分别声明自己的排序分段", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const activeTree = readFileSync("src/renderer/src/components/sidebar/ActiveSessionsTree.tsx", "utf8");
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  assert.match(projectTree, /orderScope="chat"/);
  assert.match(projectTree, /props\.controller\.drag\.order \?\? visibleRootIds/);
  assert.match(projectTree, /style=\{\{ order: previewRank\.get\(project\.id\)/);
  assert.match(projectTree, /workspaceProjects\.map\(renderProject\)/);
  assert.match(projectTree, /props\.actions\.projects\.reorder\(finalOrder\)/);
  assert.match(projectTree, /event\.clientY < rect\.top \+ rect\.height \/ 2/);
  assert.match(activeTree, /sidebarSessionOrder\("active"\)/);
  assert.match(activeTree, /sidebarSessionBaseOrder\("active"\)/);
  assert.match(activeTree, /style=\{\{ order: sessionId \? activePreviewRank\.get\(sessionId\)/);
  assert.match(activeTree, /controller\.setSessionDropTarget\("active", sessionId, position\)/);
  assert.match(sessionTree, /orderScope\?: SidebarSessionOrderScope/);
  assert.match(sessionTree, /sidebarSessionBaseOrder\(props\.orderScope\)/);
  assert.match(sessionTree, /style=\{childOrderStyle\(child\)\}/);
  assert.match(sessionTree, /dropSidebarSession\(scope, source, sessionId, position\)/);
  assert.match(activeTree, /dropSidebarSession\("active", source, sessionId, position\)/);
  assert.match(sessionTree, /event\.clientY < rect\.top \+ rect\.height \/ 2/);
  assert.match(controller, /order: reorderSidebarSessionIds\(current\.order, current\.sourceProjectId, projectId, position\)/);
  assert.match(controller, /order: reorderSidebarSessionIds\(current\.order, current\.sourceSessionId, sessionId, position\)/);
  assert.match(controller, /drag\.scope === scope && drag\.order/);
});
