import type { GitWorktreeStatus } from "../../../shared/types/git";

export type WorktreeStatus = GitWorktreeStatus & { clean: boolean };

/** Add renderer-only derived state to the shared Git worktree status contract. */
export function normalizeWorktreeStatus(value: GitWorktreeStatus): WorktreeStatus {
  const { staged, modified, untracked, conflicted } = value.counts;
  return {
    ...value,
    changed: value.changed ?? staged + modified + untracked + conflicted,
    clean: !value.unavailable && staged === 0 && modified === 0 && untracked === 0 && conflicted === 0 && (value.ahead ?? 0) === 0 && (value.behind ?? 0) === 0,
  };
}

export function worktreeStatusKey(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  // Windows paths are case-insensitive; preserve case on POSIX so two valid
  // case-sensitive worktrees cannot accidentally share a status row.
  const isWindowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}
