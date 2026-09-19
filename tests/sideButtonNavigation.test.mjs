import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
  });
  return module.exports;
}

test("this device maps left/back button 4 to turn start and right/forward button 3 to turn end", () => {
  const { resolveSideButtonJump } = compileModule(
    "src/renderer/src/components/session/timeline/sideButtonNavigation.ts",
  );

  assert.equal(
    JSON.stringify(resolveSideButtonJump(4, "start-1", "end-1")),
    JSON.stringify({ messageId: "start-1", alignment: "top" }),
  );
  assert.equal(
    JSON.stringify(resolveSideButtonJump(3, "start-1", "end-1")),
    JSON.stringify({ messageId: "end-1", alignment: "bottom" }),
  );
});

test("side mouse buttons do not navigate without a valid target", () => {
  const { resolveSideButtonJump } = compileModule(
    "src/renderer/src/components/session/timeline/sideButtonNavigation.ts",
  );

  assert.equal(resolveSideButtonJump(1, "start-1", "end-1"), null);
  assert.equal(resolveSideButtonJump(4, undefined, "end-1"), null);
  assert.equal(resolveSideButtonJump(3, "start-1", undefined), null);
});

test("timeline jump alignment places the answer tail at the viewport bottom", () => {
  const { resolveTimelineJumpScrollTop } = compileModule(
    "src/renderer/src/hooks/useSessionTimelineController.ts",
    {
      react: {},
      jotai: { atom: (value) => ({ _mockInit: value }) },
      "jotai/utils": {},
      "../atoms": {},
      "../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
      "../desktopApi": {},
      "./timeline/autoExpandThreshold": {
        TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120,
        resolveAutoExpandThreshold: (height) => Math.max(120, Math.round(height * 0.4)),
      },
      "./timeline/scrollHistoryPolicy": {},
      "../components/session/timeline/turnRenderWindow": {
        TIMELINE_MOUNTED_TURN_LIMIT: 3,
        TIMELINE_SCROLLED_TURN_LIMIT: 3,
        TIMELINE_WINDOW_EXPAND_STEP: 3,
      },
      "../components/session/timeline/jumpWindowPolicy": compileModule(
        "src/renderer/src/components/session/timeline/jumpWindowPolicy.ts",
        { "./turnRenderWindow": { TIMELINE_WINDOW_EXPAND_STEP: 3 } },
      ),
      "./timeline/browsePin": compileModule(
        "src/renderer/src/hooks/timeline/browsePin.ts",
      ),
    },
  );

  assert.equal(resolveTimelineJumpScrollTop(120, 80, 400, "top"), 120);
  assert.equal(resolveTimelineJumpScrollTop(120, 80, 200, "center"), 60);
  assert.equal(resolveTimelineJumpScrollTop(120, 80, 400, "bottom"), 0);
  assert.equal(resolveTimelineJumpScrollTop(600, 250, 400, "bottom"), 450);
  assert.equal(resolveTimelineJumpScrollTop(600, 250, 400, "bottom", 300), 300);
  const controllerSource = readFileSync(
    "src/renderer/src/hooks/useSessionTimelineController.ts",
    "utf8",
  );
  assert.doesNotMatch(controllerSource, /JUMP_ANCHOR|jumpCorrection|const track = \(\) => \{|timeline\.scrollTop \+ drift/);
  assert.match(controllerSource, /锚点跳转只有一个写入者/);
  const jumpPositioner = controllerSource.match(
    /const scrollJumpTargetIntoView = useCallback\([\s\S]*?\n  \}, \[markProgrammaticScroll\]\);/,
  )?.[0] ?? "";
  assert.equal((jumpPositioner.match(/api\.restoreAt\(scrollTop\)/g) ?? []).length, 1);
  assert.doesNotMatch(jumpPositioner, /requestAnimationFrame|setTimeout|drift|correctedTop/);
  assert.match(controllerSource, /!skipBrowsePinRef\.current && !programmaticScrollRef\.current/);
  assert.match(controllerSource, /目标已稳定：清掉请求并执行唯一一次原子定位/);
  assert.match(controllerSource, /if \(index >= 0 && !existing\)/);
  assert.match(controllerSource, /data-local-anchor/);
  assert.match(controllerSource, /anchorName = alignment === "bottom" \? "answer-end" : "question"/);
  assert.match(controllerSource, /data-final-answer/);
  assert.match(controllerSource, /article\.user-turn\[data-message-id/);
  assert.match(controllerSource, /const rect = element\.getBoundingClientRect\(\);/);
  assert.match(controllerSource, /const targetTop = rect\.top - timelineRect\.top \+ timeline\.scrollTop;/);
  assert.doesNotMatch(controllerSource, /getTimelineDocumentOffset|offsetParent/);
  assert.match(controllerSource, /findTimelineJumpTarget\(timeline, messageId, alignment\)/);
  assert.match(controllerSource, /First jump must be applied after the browsing-mode DOM commit but before paint/);
  assert.match(controllerSource, /useLayoutEffect\(\(\) => \{[\s\S]*?pendingJump/);
  assert.match(controllerSource, /programmaticScrollClearTimerRef/);
  assert.match(controllerSource, /programmaticScrollUntilRef\.current = 0;\s*programmaticScrollRef\.current = false;/);
  assert.match(controllerSource, /无论目标当前是否已挂载，都挂起到下一次 React commit 后再测量/);

  const timelineCss = readFileSync(
    "src/renderer/src/styles/timeline.css",
    "utf8",
  );
  const messageEnter = timelineCss.match(/@keyframes message-enter \{[\s\S]*?\n\}/)?.[0] ?? "";
  const topEnter = timelineCss.match(/@keyframes top-enter \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(messageEnter, /opacity: 0/);
  assert.match(topEnter, /opacity: 0/);
  assert.doesNotMatch(messageEnter, /transform:/);
  assert.doesNotMatch(topEnter, /transform:/);
});

test("TurnRow handles browser thumb clicks through the shared jump mapping", () => {
  const source = readFileSync(
    "src/renderer/src/components/session/turn/TurnRow.tsx",
    "utf8",
  );
  assert.match(source, /onMouseDown=\{preventSideButtonNavigation\}/);
  assert.match(source, /onMouseUp=\{handleSideButtonMouseUp\}/);
  assert.match(source, /onAuxClick=\{preventSideButtonNavigation\}/);
  assert.doesNotMatch(source, /sideButtonHandledRef|handleSideButtonMouseDown|handleSideButtonAuxClick/);
  const jumpCalls = source.match(/props\.onJumpToMessage\?\.\(jump\.messageId, jump\.alignment\)/g) ?? [];
  assert.equal(jumpCalls.length, 1, "one physical side-button press must have one jump commit path");
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /resolveSideButtonJump\(/);
  const surfaceSource = readFileSync(
    "src/renderer/src/components/session/SurfaceComponents.tsx",
    "utf8",
  );
  assert.match(surfaceSource, /data-local-anchor=\{`question:\$\{message\.id\}`\}/);
  assert.match(source, /data-run-id=\{run\.id\}/);
  assert.match(source, /data-local-anchor=\{`answer-end:\$\{run\.id\}`\}/);
  assert.match(source, /prev\.onJumpToMessage === next\.onJumpToMessage/);
});
