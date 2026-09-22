import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const settings = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");

test("embedded config save commits outer settings draft before config data", () => {
  assert.match(config, /onBeforeSaveCurrent\?: \(\) => Promise<boolean>/);
  assert.match(config, /if \(onBeforeSaveCurrent && !\(await onBeforeSaveCurrent\(\)\)\) return;/);
  assert.match(config, /await handleSaveCurrent\(\);/);
  assert.match(settings, /onBeforeSaveCurrent=\{\(\) => saveAll\(\{ silent: true \}\)\}/);
  assert.match(settings, /const saveAll = async \(options\?: \{ silent\?: boolean \}\)/);
  assert.match(settings, /props\.onChange\(patch, options\)/);
  assert.match(settings, /saveAll\(\{ silent: configPaneState\.hasDirty \}\)/);

  const preSaveIndex = config.indexOf("await onBeforeSaveCurrent()");
  const configSaveIndex = config.indexOf("await handleSaveCurrent()", preSaveIndex);
  assert.ok(preSaveIndex >= 0, "embedded save must invoke outer settings save");
  assert.ok(configSaveIndex > preSaveIndex, "outer settings save must happen before config save");
});
