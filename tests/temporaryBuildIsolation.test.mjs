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
});

test("temporary packaged builds never register the formal pideck protocol", () => {
  assert.match(mainSource, /if \(app\.isPackaged && !isDevBuild\) \{\s*app\.setAsDefaultProtocolClient\("pideck"\);/);
  assert.match(builderDevConfig, /protocols: \[\]/);
});

test("temporary windows builds are visibly labeled", () => {
  assert.match(mainSource, /isDevBuild \? "PiDeck-Dev"/);
  assert.match(mainSource, /isDevBuild \? "PiDeck-Dev" : "PiDeck"/);
});
