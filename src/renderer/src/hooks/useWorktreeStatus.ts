import { useEffect, useState } from "react";
import type { Project } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { normalizeWorktreeStatus, worktreeStatusKey, type WorktreeStatus } from "../utils/worktreeStatus";

/**
 * Poll read-only Git summaries for each enabled root project.
 * The sequence guard prevents a slower snapshot from overwriting a newer one
 * after the project catalog or a worktree changes.
 */
export function useWorktreeStatus(projects: readonly Project[]): Readonly<Record<string, WorktreeStatus>> {
  const [statusesByPath, setStatusesByPath] = useState<Record<string, WorktreeStatus>>({});

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    const scopedProjects = projects.filter((project) => project.worktreeEnabled && !project.missing);

    const poll = async () => {
      const request = ++sequence;
      const snapshots = await Promise.all(scopedProjects.map(async (project) => {
        try {
          const statuses = await desktopApi.git.worktreeStatus(project.id);
          return statuses.map((status) => [
            worktreeStatusKey(status.path),
            normalizeWorktreeStatus(status),
          ] as const);
        } catch {
          return [] as const;
        }
      }));
      if (!disposed && request === sequence) {
        setStatusesByPath(Object.fromEntries(snapshots.flat()));
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 12_000);
    return () => {
      disposed = true;
      sequence += 1;
      window.clearInterval(timer);
    };
  }, [projects]);

  return statusesByPath;
}
