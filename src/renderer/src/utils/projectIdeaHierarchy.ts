import type { ProjectIdea, ProjectIdeaStatus } from "../../../shared/types/projectIdea";

/** A project idea with its visible descendants arranged as a tree. */
export type ProjectIdeaTreeNode = {
	idea: ProjectIdea;
	children: ProjectIdeaTreeNode[];
	/** True when this node is retained only to provide context for a matching descendant. */
	contextOnly: boolean;
};

export type ProjectIdeaHierarchyFilter = "all" | "active" | ProjectIdeaStatus;

function compareIdeas(a: { idea: ProjectIdea; index: number }, b: { idea: ProjectIdea; index: number }): number {
	const updated = b.idea.updatedAt - a.idea.updatedAt;
	if (updated !== 0) return updated;
	const created = b.idea.createdAt - a.idea.createdAt;
	if (created !== 0) return created;
	const id = a.idea.id.localeCompare(b.idea.id);
	return id !== 0 ? id : a.index - b.index;
}

/**
 * Builds a filtered, cycle-safe hierarchy from project-scoped ideas.
 * Parent links are honoured only for an existing idea in the same project.
 */
export function buildProjectIdeaHierarchy(
	ideas: readonly ProjectIdea[],
	filter: ProjectIdeaHierarchyFilter = "active",
): ProjectIdeaTreeNode[] {
	const entries = ideas.map((idea, index) => ({ idea, index }));
	const byId = new Map<string, { idea: ProjectIdea; index: number }>();
	for (const entry of entries) {
		if (!byId.has(entry.idea.id)) byId.set(entry.idea.id, entry);
	}

	const uniqueEntries = entries.filter((entry) => byId.get(entry.idea.id)?.index === entry.index);
	const parentId = new Map<string, string | undefined>();
	for (const entry of uniqueEntries) {
		const parent = entry.idea.derivedFromIdeaId;
		const candidate = parent ? byId.get(parent) : undefined;
		parentId.set(
			entry.idea.id,
			candidate && candidate.idea.projectId === entry.idea.projectId && candidate.idea.id !== entry.idea.id
				? candidate.idea.id
				: undefined,
		);
	}

	// Mark every member of a parent cycle. Each marked idea becomes a root by
	// breaking only its incoming edge; descendants can still attach normally.
	const cycleMembers = new Set<string>();
	for (const entry of uniqueEntries) {
		const path: string[] = [];
		const positions = new Map<string, number>();
		let current: string | undefined = entry.idea.id;
		while (current) {
			const seenAt = positions.get(current);
			if (seenAt !== undefined) {
				for (const id of path.slice(seenAt)) cycleMembers.add(id);
				break;
			}
			positions.set(current, path.length);
			path.push(current);
			current = parentId.get(current);
		}
	}
	for (const id of cycleMembers) parentId.set(id, undefined);

	const matching = (idea: ProjectIdea): boolean => filter === "all"
		? true
		: filter === "active"
			? idea.status !== "done"
			: idea.status === filter;
	const included = new Set<string>();
	const contextOnly = new Set<string>();
	const includeChain = (id: string): void => {
		if (included.has(id)) return;
		included.add(id);
		const parent = parentId.get(id);
		if (parent) {
			includeChain(parent);
			contextOnly.add(parent);
		}
	};
	for (const entry of uniqueEntries) if (matching(entry.idea)) includeChain(entry.idea.id);

	const nodes = new Map<string, ProjectIdeaTreeNode>();
	for (const entry of uniqueEntries) {
		if (included.has(entry.idea.id)) nodes.set(entry.idea.id, { idea: entry.idea, children: [], contextOnly: contextOnly.has(entry.idea.id) && !matching(entry.idea) });
	}
	const roots: { idea: ProjectIdea; index: number }[] = [];
	for (const entry of uniqueEntries) {
		if (!included.has(entry.idea.id)) continue;
		const parent = parentId.get(entry.idea.id);
		const parentNode = parent ? nodes.get(parent) : undefined;
		if (parentNode) parentNode.children.push(nodes.get(entry.idea.id)!);
		else roots.push(entry);
	}
	for (const node of nodes.values()) node.children.sort((a, b) => compareIdeas({ idea: a.idea, index: byId.get(a.idea.id)!.index }, { idea: b.idea, index: byId.get(b.idea.id)!.index }));
	roots.sort(compareIdeas);
	return roots.map((entry) => nodes.get(entry.idea.id)!);
}
