import { ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { MainBranchSyncService } from "../git/MainBranchSyncService";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { GitMainSyncSnapshot } from "../../shared/types/gitSync";

export type GitMainSyncIpcDeps = {
  sync: MainBranchSyncService;
  projectStore: ProjectStore;
  settingsStore: SettingsStore;
  getMainWindow: () => BrowserWindow | null;
};

/** Registers the safe main-branch sync IPC surface; renderer paths are never accepted. */
export function registerGitMainSyncIpc({ sync, projectStore, settingsStore, getMainWindow }: GitMainSyncIpcDeps): void {
  const requireProjectId = (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new Error("Invalid project id");
    if (!projectStore.get(value)) throw new Error(`Project not found: ${value}`);
    return value;
  };
  const publish = (snapshot: GitMainSyncSnapshot) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(ipcChannels.gitMainSyncChanged, snapshot);
    return snapshot;
  };
  ipcMain.handle(ipcChannels.gitMainSyncStatus, async (_event, projectId: unknown) => sync.getSnapshot(requireProjectId(projectId)));
  ipcMain.handle(ipcChannels.gitMainSyncNow, async (_event, projectId: unknown) => {
    const id = requireProjectId(projectId);
    const snapshot = await sync.syncOne(id, "manual", { syncWorktrees: settingsStore.get().gitAutoSyncWorktrees === true });
    return publish(snapshot);
  });
}
