import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const devBuildScript = readFileSync("scripts/dist-win-dev.js", "utf8");
const fastDevScript = readFileSync("scripts/pack-dev.js", "utf8");
const mainSource = readFileSync("src/main/index.ts", "utf8");
const builderDevConfig = readFileSync("scripts/electron-builder-dev.cjs", "utf8");

test("temporary Windows builds inject a distinct identity and output directory", () => {
  for (const source of [devBuildScript, fastDevScript]) {
    assert.match(source, /PIDECK_DEV_BUILD: "1"/);
    assert.match(source, /release-dev/);
  }
  assert.match(builderDevConfig, /productName: "PiDeck-Dev"/);
  assert.match(builderDevConfig, /appId: "com\.ayuayue\.pi-desktop-dev"/);
  assert.match(builderDevConfig, /PiDeck-Dev-\$\{version\}-temporary/);
  assert.match(devBuildScript, /rmSync\(outputDir, \{ recursive: true, force: true \}\)/);
  assert.match(fastDevScript, /rmSync\(path\.join\(root, DEV_OUTPUT_DIR\), \{ recursive: true, force: true \}\)/);
});

test("temporary packaged builds never register the formal pideck protocol", () => {
  assert.match(mainSource, /if \(app\.isPackaged && !isDevBuild\) \{\s*app\.setAsDefaultProtocolClient\("pideck"\);/);
  assert.match(builderDevConfig, /protocols: \[\]/);
});

test("temporary windows builds are visibly labeled and use a distinct data identity", () => {
  assert.match(mainSource, /isDevBuild \? "PiDeck-Dev"/);
  assert.match(mainSource, /isDevBuild \? "PiDeck-Dev" : "PiDeck"/);
  assert.match(mainSource, /DEFAULT_DEV_USER_DATA_NAME/);
  assert.match(readFileSync("src/main/devIsolation.ts", "utf8"), /DEFAULT_DEV_USER_DATA_NAME = "pi-desktop-dev"/);
  assert.match(mainSource, /com\.ayuayue\.pi-desktop-dev/);
  assert.match(mainSource, /isDevBuild = !app\.isPackaged \|\| __PIDECK_DEV_BUILD__/);
});
