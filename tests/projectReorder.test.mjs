import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const toLocalArray = (value) => Array.from(value);

function makeStore(existingDir) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "pideck-project-order-"));
  const electronStub = {
    app: { getPath: () => dir },
    dialog: {},
  };
  const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
    stubs: { electron: electronStub },
  });
  return { dir, store: new ProjectStore() };
}

test("项目拖动排序只改变根项目，并可从 projects.json 恢复", async () => {
  const { dir, store } = makeStore();
  try {
    await store.load();
    const first = await store.add("C:\\repo\\first");
    const second = await store.add("C:\\repo\\second");
    const child = await store.add("C:\\repo\\second\\feature", second.id, "windows");

    await store.reorder([second.id, child.id, first.id]);
    assert.deepEqual(
      toLocalArray(store.listRoot().filter((project) => project.id !== "builtin-chat").map((project) => project.id)),
      [second.id, first.id],
    );
    assert.equal(store.get(child.id)?.worktreeParentId, second.id);

    const saved = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
    assert.equal(saved.find((project) => project.id === second.id).sortOrder, 0);
    assert.equal(saved.find((project) => project.id === first.id).sortOrder, 1);

    const reloaded = makeStore(dir);
    try {
      await reloaded.store.load();
      assert.deepEqual(
        toLocalArray(reloaded.store.listRoot().filter((project) => project.id !== "builtin-chat").map((project) => project.id)),
        [second.id, first.id],
      );
    } finally {
      rmSync(reloaded.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("项目排序 IPC 拒绝非字符串数组，保留输入边界校验", () => {
  const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
  assert.match(source, /ipcChannels\.projectsReorder/);
  assert.match(source, /!Array\.isArray\(projectIds\)/);
  assert.match(source, /projectIds\.some\(\(id\) => typeof id !== "string"/);
  assert.match(source, /INVALID_PROJECT_ORDER/);
});
