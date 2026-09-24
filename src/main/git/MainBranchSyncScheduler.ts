/** Periodic main-branch sync scheduler; single-flight, ordered, and lifecycle-friendly. */

export type MainSyncSchedulerSettings = { intervalMin?: number; enabled?: boolean };

export class MainBranchSyncScheduler {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	constructor(
		private readonly sync: (projectId: string) => Promise<unknown>,
		private readonly listProjectIds: () => string[],
		private readonly getSettings: () => MainSyncSchedulerSettings,
		private readonly log: (message: string, error?: unknown) => void = () => undefined,
	) {}

	/** No catch-up is attempted: a delayed tick is simply skipped while one is running. */
	private intervalMs(): number {
		const raw = Number(this.getSettings().intervalMin ?? 30);
		const minutes = Number.isFinite(raw) ? Math.min(1440, Math.max(5, Math.floor(raw))) : 30;
		return minutes * 60_000;
	}

	start(): void {
		if (this.timer) return;
		if (this.getSettings().enabled === false) return;
		this.timer = setInterval(() => { void this.tick(); }, this.intervalMs());
		// QuitCleanupRegistry must register stop() at the composition root.
	}

	/** Re-read settings without creating duplicate timers (use after settings:update). */
	refresh(): void {
		this.stop();
		this.start();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (const projectId of this.listProjectIds()) {
				try { await this.sync(projectId); }
				catch (error) { this.log(`scheduled sync failed: ${projectId}`, error); }
			}
		} finally { this.running = false; }
	}
}
