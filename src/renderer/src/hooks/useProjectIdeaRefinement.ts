import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import type { ProjectIdeaRefinement } from "../../../shared/types";
import {
	removeSessionStateAtom,
	sessionMessageCacheBySessionIdAtomFamily,
	sessionRecordsAtom,
} from "../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { effectiveAgentBackendAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";
import { buildAskContextBlock } from "../utils/askPanelContext";
import { parseProjectIdeaRefinement } from "../utils/projectIdeaRefinement";

const RUNTIME_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 120_000;

type RequestState = {
	requestId: number;
	sessionId: string;
	targetKey: string;
	sent: boolean;
	baselineAssistantIds: ReadonlySet<string>;
};

/** Runs one non-persistent Pi query and returns its structured project-idea clarification. */
export function useProjectIdeaRefinement() {
	const store = useStore();
	const backend = useAtomValue(effectiveAgentBackendAtom);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ProjectIdeaRefinement | null>(null);
	const [resultTargetKey, setResultTargetKey] = useState<string | null>(null);
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId ?? ""));
	const cache = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(sessionId ?? ""));
	const removeSessionState = useSetAtom(removeSessionStateAtom);
	const requestRef = useRef(0);
	const mountedRef = useRef(true);
	const activeSessionRef = useRef<string | null>(null);
	const requestStateRef = useRef<RequestState | null>(null);
	const responseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearResponseTimer = useCallback(() => {
		if (responseTimerRef.current) clearTimeout(responseTimerRef.current);
		responseTimerRef.current = null;
	}, []);

	const cleanup = useCallback(async (id: string) => {
		const liveRuntime = store.get(sessionRuntimeBySessionIdAtomFamily(id));
		if (liveRuntime?.agentId) {
			await desktopApi.sessions.stopRuntime({
				sessionId: id,
				agentId: liveRuntime.agentId,
				runtimeGeneration: liveRuntime.runtimeGeneration,
			}).catch(() => undefined);
		}
		removeSessionState(id);
		if (activeSessionRef.current === id) activeSessionRef.current = null;
		if (mountedRef.current) setSessionId((current) => current === id ? null : current);
	}, [removeSessionState, store]);

	useEffect(() => {
		if (!sessionId || !running) return;
		const request = requestStateRef.current;
		if (!request || request.sessionId !== sessionId || !request.sent) return;
		const assistantText = [...(cache?.messages ?? [])]
			.reverse()
			.find((message) => message.role === "assistant" && !request.baselineAssistantIds.has(message.id) && message.text.trim())?.text;
		const busy = runtime?.status === "starting" || runtime?.status === "running" || Boolean(runtime?.state?.isStreaming);
		if (!assistantText || busy) return;
		clearResponseTimer();
		requestStateRef.current = null;
		try {
			setResult(parseProjectIdeaRefinement(assistantText));
			setResultTargetKey(request.targetKey);
			setRunning(false);
			void cleanup(sessionId);
		} catch {
			setError("PROJECT_IDEA_REFINEMENT_RESPONSE_INVALID");
			setRunning(false);
			void cleanup(sessionId);
		}
	}, [cache?.messages, cleanup, clearResponseTimer, running, runtime?.state?.isStreaming, runtime?.status, sessionId]);

	const refine = useCallback(async (input: {
		projectId: string;
		prompt: string;
		targetKey: string;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
	}): Promise<boolean> => {
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		clearResponseTimer();
		setError(null);
		setResult(null);
		setResultTargetKey(null);
		setRunning(true);
		let createdSessionId: string | null = null;
		try {
			const { session } = await desktopApi.sessions.createAnonymous({
				projectId: input.projectId,
				title: "Project idea refinement",
				backend,
				...(input.model ? { model: input.model } : {}),
				...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
			});
			createdSessionId = session.id;
			if (!mountedRef.current || requestRef.current !== requestId) {
				await cleanup(session.id);
				return false;
			}
			activeSessionRef.current = session.id;
			store.set(sessionRecordsAtom, {
				...store.get(sessionRecordsAtom),
				[session.id]: session,
			});
			setSessionId(session.id);
			const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (!mountedRef.current || requestRef.current !== requestId) {
					await cleanup(session.id);
					return false;
				}
				const live = store.get(sessionRuntimeBySessionIdAtomFamily(session.id));
				if (live?.status === "idle" || live?.status === "running") break;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			const live = store.get(sessionRuntimeBySessionIdAtomFamily(session.id));
			if (!live || (live.status !== "idle" && live.status !== "running")) throw new Error("PROJECT_IDEA_REFINEMENT_RUNTIME_TIMEOUT");
			const messages = store.get(sessionMessageCacheBySessionIdAtomFamily(session.id))?.messages ?? [];
			requestStateRef.current = {
				requestId,
				sessionId: session.id,
				targetKey: input.targetKey,
				sent: false,
				baselineAssistantIds: new Set(messages.filter((message) => message.role === "assistant").map((message) => message.id)),
			};
			const response = await desktopApi.sessions.sendPrompt({
				sessionId: session.id,
				requestId: crypto.randomUUID(),
				message: input.prompt,
			});
			if (!response.accepted) throw new Error(response.error);
			requestStateRef.current = { ...requestStateRef.current, sent: true };
			responseTimerRef.current = setTimeout(() => {
				if (requestRef.current !== requestId || !mountedRef.current) return;
				requestStateRef.current = null;
				setRunning(false);
				setError("PROJECT_IDEA_REFINEMENT_TIMEOUT");
				void cleanup(session.id);
			}, RESPONSE_TIMEOUT_MS);
			return true;
		} catch (reason) {
			if (createdSessionId) await cleanup(createdSessionId);
			if (requestRef.current === requestId && mountedRef.current) {
				setRunning(false);
				setError(reason instanceof Error ? reason.message : String(reason));
			}
			return false;
		}
	}, [backend, cleanup, clearResponseTimer, store]);

	const cancel = useCallback(() => {
		requestRef.current += 1;
		clearResponseTimer();
		requestStateRef.current = null;
		setResultTargetKey(null);
		const id = activeSessionRef.current;
		setRunning(false);
		if (id) void cleanup(id);
	}, [cleanup, clearResponseTimer]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			requestRef.current += 1;
			clearResponseTimer();
			requestStateRef.current = null;
			const id = activeSessionRef.current;
			if (id) void cleanup(id);
		};
	}, [cleanup, clearResponseTimer]);

	return { refine, cancel, running, error, result, resultTargetKey, contextBuilder: buildAskContextBlock };
}
