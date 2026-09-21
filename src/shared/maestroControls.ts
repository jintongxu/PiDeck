/** Private RPC markers used by PiDeck's Composer without creating visible user messages. */
export const PIDECK_MAESTRO_PLAN_ENTER = "__pideck_maestro_plan_enter__";
export const PIDECK_MAESTRO_PLAN_EXIT = "__pideck_maestro_plan_exit__";

/**
 * Translate PiDeck controls directly to pi-maestro-flow's registered `/plan` command.
 * Executing the command through Pi's normal prompt entry is deterministic; asking a
 * second extension to enqueue another user message can leave the original Plan turn
 * active and never run the queued `/plan exit` command.
 */
export function resolveMaestroPlanControlCommand(message: string): string | null {
	const trimmed = message.trim();
	if (trimmed === PIDECK_MAESTRO_PLAN_EXIT) return "/plan exit";
	if (trimmed === PIDECK_MAESTRO_PLAN_ENTER) return "/plan";
	if (trimmed.startsWith(`${PIDECK_MAESTRO_PLAN_ENTER}\n`)) {
		const prompt = trimmed.slice(PIDECK_MAESTRO_PLAN_ENTER.length).trim();
		return prompt ? `/plan ${prompt}` : "/plan";
	}
	return null;
}
