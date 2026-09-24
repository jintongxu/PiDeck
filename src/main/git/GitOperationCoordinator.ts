/** Keyed in-memory mutex for serializing mutating Git operations per repository. */
export class GitOperationCoordinator {
	private readonly locks = new Map<string, Promise<void>>();

	async acquire<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		this.locks.set(key, current);
		await previous;
		try { return await operation(); }
		finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
	}

	/** Try to enter without waiting; false means another operation owns this key. */
	tryAcquire(key: string): (() => void) | null {
		if (this.locks.has(key)) return null;
		let release!: () => void;
		const lock = new Promise<void>((resolve) => { release = resolve; });
		this.locks.set(key, lock);
		return () => { if (this.locks.get(key) === lock) { this.locks.delete(key); release(); } };
	}
}
