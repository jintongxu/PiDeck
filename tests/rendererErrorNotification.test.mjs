import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const notice = readFileSync("src/renderer/src/utils/notice.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const channels = readFileSync("src/shared/ipc.ts", "utf8");
const settingsZh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const settingsEn = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("error toasts are mirrored to system notifications while preserving the in-app toast", () => {
  assert.match(notice, /if \(kind === "error"\) notifySystemError\(text\);/);
  assert.match(notice, /window\.piDesktop\?\.app\.notifyError\(message\)/);
  assert.match(channels, /appNotifyError: "app:notify-error"/);
  assert.match(preload, /notifyError: \(message: string\) =>/);
  assert.match(preload, /ipcChannels\.appNotifyError, message/);
  assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.appNotifyError/);
  assert.match(systemIpc, /settings\.enableNotifications/);
  assert.match(systemIpc, /Notification\.isSupported\(\)/);
  assert.match(systemIpc, /RENDERER_ERROR_NOTIFICATION_DEDUPE_WINDOW_MS/);
});

test("notification setting explains that errors remain available in-app when disabled", () => {
  assert.match(settingsZh, /settings\.enableNotificationsDesc/);
  assert.match(settingsZh, /报错时发送系统通知/);
  assert.match(settingsEn, /settings\.enableNotificationsDesc/);
  assert.match(settingsEn, /finish responding or fail/);
});
