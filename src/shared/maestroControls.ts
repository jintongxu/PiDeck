/**
 * Private stdio prompt markers used only for PiDeck-to-pi-maestro-flow controls.
 * They are intercepted by the extension before Pi creates a user message or LLM turn.
 */
export const PIDECK_MAESTRO_PLAN_ENTER = "__pideck_maestro_plan_enter__";
export const PIDECK_MAESTRO_PLAN_EXIT = "__pideck_maestro_plan_exit__";
