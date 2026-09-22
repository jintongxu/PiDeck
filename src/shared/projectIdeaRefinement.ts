/**
 * Normalize the persisted project-idea effort without hard-coding the current
 * catalog. Providers may add a future effort id; capability metadata remains the
 * authority for whether that id can be used with the selected model.
 */
export function normalizeProjectIdeaRefinementThinkingLevel(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = value.trim();
	return normalized.length <= 64 ? normalized : "";
}
