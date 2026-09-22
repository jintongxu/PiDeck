/** Pi thinking levels accepted by the project-idea refinement setting. */
export const PROJECT_IDEA_REFINEMENT_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ProjectIdeaRefinementThinkingLevel = typeof PROJECT_IDEA_REFINEMENT_THINKING_LEVELS[number];

/** Empty/unknown persisted values keep the provider/model default behavior. */
export function normalizeProjectIdeaRefinementThinkingLevel(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = value.trim();
	return (PROJECT_IDEA_REFINEMENT_THINKING_LEVELS as readonly string[]).includes(normalized)
		? normalized
		: "";
}
