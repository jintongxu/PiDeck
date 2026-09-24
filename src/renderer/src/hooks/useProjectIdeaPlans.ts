import { useCallback, useEffect, useRef, useState } from "react";
import { useSetAtom, useStore } from "jotai";
import type { ChatMessage, ProjectIdeaRefinement, SessionRuntimeEvent } from "../../../shared/types";
import {
	removeSessionStateAtom,
	sessionMessageCacheBySessionIdAtomFamily,
} from "../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { buildProjectIdeaBrainstormSummaryPrompt, parseProjectIdeaRefinement } from "../utils/projectIdeaRefinement";

type SummaryRequest = {
	requestId: number;
	sessionId: string;
	baselineAssistantIds: ReadonlySet<string>;
	onCompleted?: (refinement: ProjectIdeaRefinement) => void;
	onError?: (error: string) => void;
};

type WaitResult<T> =
	| { kind: "ready"; value: T }
	| { kind: "error"; error: string };

type WaitPredicate<T> = (
	messages: readonly ChatMessage[],
	runtime: { status?: string } | undefined,
) => WaitResult<T> | undefined;

function isCompletedAssistantMessage(message: { role: string; text: string; stopReason?: string }): boolean {
	return message.role === "assistant" &&
		Boolean(message.text.trim()) &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error" &&
		message.stopReason !== "pending" &&
		message.stopReason !== "toolUse" &&
		message.stopReason !== "length";
}

function isSummaryAssistantTerminal(message: { role: string; text: string; stopReason?: string }): boolean {
	return message.role === "assistant" &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error" &&
		message.stopReason !== "pending" &&
		message.stopReason !== "toolUse" &&
		(Boolean(message.text.trim()) || message.stopReason === "stop" || message.stopReason === "length");
}

function hasCompletedAssistantTurn(messages: readonly { role: string; text: string; stopReason?: string }[]): boolean {
	let lastUserIndex = -1;
	let lastAssistantIndex = -1;
	let lastAssistant: (typeof messages)[number] | undefined;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role === "user") lastUserIndex = index;
		if (message.role === "assistant") {
			lastAssistantIndex = index;
			lastAssistant = message;
		}
	}
	return Boolean(
		lastAssistant &&
		lastAssistantIndex > lastUserIndex &&
		isCompletedAssistantMessage(lastAssistant),
	);
}

function isCancelledError(error: unknown): boolean {
	return error instanceof Error && error.message === "PROJECT_IDEA_PLANS_CANCELLED";
}

/**
 * Waits on Jotai's per-session message/runtime atoms rather than polling or a
 * fixed timeout. This keeps anonymous --no-session replies observable even when
 * the React component never renders the transient session.
 */
function waitForSessionCondition<T>(
	store: ReturnType<typeof useStore>,
	sessionId: string,
	predicate: WaitPredicate<T>,
	cancelRef: { current: (() => void) | null },
): Promise<T> {
	const messagesAtom = sessionMessageCacheBySessionIdAtomFamily(sessionId);
	const runtimeAtom = sessionRuntimeBySessionIdAtomFamily(sessionId);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let unsubscribeMessages: () => void = () => undefined;
		let unsubscribeRuntime: () => void = () => undefined;
		let unsubscribeRuntimeEvent: () => void = () => undefined;

		const cleanup = () => {
			unsubscribeMessages();
			unsubscribeRuntime();
			unsubscribeRuntimeEvent();
			if (cancelRef.current === cancel) cancelRef.current = null;
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const finishResult = (result: WaitResult<T> | undefined) => {
			if (!result) return;
			if (result.kind === "ready") finish(() => resolve(result.value));
			else finish(() => reject(new Error(result.error)));
		};
		const check = () => finishResult(predicate(
			store.get(messagesAtom)?.messages ?? [],
			store.get(runtimeAtom),
		));
		const checkRuntimeEvent = (event: SessionRuntimeEvent) => {
			if (event.sessionId !== sessionId) return;
			const runtime = store.get(runtimeAtom);
			if (runtime && runtime.runtimeGeneration !== event.runtimeGeneration) return;
			if (event.kind === "detach") {
				finishResult(predicate(store.get(messagesAtom)?.messages ?? [], { status: "detached" }));
				return;
			}
			if (!event.payload || typeof event.payload !== "object") return;
			const payload = event.payload as { status?: unknown };
			if (typeof payload.status !== "string") return;
			const terminal = payload.status === "error" || payload.status === "closed" || payload.status === "detached";
			if (runtime && runtime.agentId !== event.agentId && !terminal) return;
			finishResult(predicate(store.get(messagesAtom)?.messages ?? [], { status: payload.status }));
		};
		const cancel = () => finish(() => reject(new Error("PROJECT_IDEA_PLANS_CANCELLED")));

		cancelRef.current = cancel;
		unsubscribeMessages = store.sub(messagesAtom, check);
		unsubscribeRuntime = store.sub(runtimeAtom, check);
		unsubscribeRuntimeEvent = desktopApi.sessions.onRuntimeEvent(checkRuntimeEvent);
		check();
	});
}

/**
 * Summarizes a completed multi-turn brainstorm in a disposable, no-tools Pi runtime.
 * The internal JSON prompt and response never enter the user's visible brainstorm session.
 */
export function useProjectIdeaPlans() {
	const store = useStore();
	const removeSessionState = useSetAtom(removeSessionStateAtom);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [summary, setSummary] = useState<ProjectIdeaRefinement | null>(null);
	const requestRef = useRef(0);
	const requestStateRef = useRef<SummaryRequest | null>(null);
	const activeSummarySessionIdRef = useRef<string | null>(null);
	const pendingWaitCancelRef = useRef<(() => void) | null>(null);
	const mountedRef = useRef(true);

	const cleanupSummarySession = useCallback(async (id: string) => {
		const live = store.get(sessionRuntimeBySessionIdAtomFamily(id));
		if (live?.agentId) {
			await desktopApi.sessions.stopRuntime({
				sessionId: id,
				agentId: live.agentId,
				runtimeGeneration: live.runtimeGeneration,
			}).catch(() => undefined);
		}
		removeSessionState(id);
		if (activeSummarySessionIdRef.current === id) activeSummarySessionIdRef.current = null;
	}, [removeSessionState, store]);

	const finishSummary = useCallback((request: SummaryRequest, text: string) => {
		if (!mountedRef.current || requestStateRef.current?.requestId !== request.requestId) return;
		requestStateRef.current = null;
		try {
			const parsed = parseProjectIdeaRefinement(text);
			setSummary(parsed);
			setError(null);
			setRunning(false);
			request.onCompleted?.(parsed);
			void cleanupSummarySession(request.sessionId);
		} catch {
			setError("PROJECT_IDEA_PLANS_RESPONSE_INVALID");
			setRunning(false);
			request.onError?.("PROJECT_IDEA_PLANS_RESPONSE_INVALID");
			void cleanupSummarySession(request.sessionId);
		}
	}, [cleanupSummarySession]);

	const summarize = useCallback(async (input: {
		projectId: string;
		sourceSessionId: string;
		title: string;
		body: string;
		model?: { provider: string; modelId: string };
		thinkingLevel?: string;
		onCompleted?: (refinement: ProjectIdeaRefinement) => void;
		onError?: (error: string) => void;
	}): Promise<boolean> => {
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		pendingWaitCancelRef.current?.();
		pendingWaitCancelRef.current = null;
		requestStateRef.current = null;
		const previousSummarySessionId = activeSummarySessionIdRef.current;
		if (previousSummarySessionId) void cleanupSummarySession(previousSummarySessionId);
		activeSummarySessionIdRef.current = null;
		setError(null);
		setSummary(null);
		setRunning(true);
		let createdSummarySessionId: string | null = null;
		try {
			// First consult persisted history; only then subscribe to live events. This avoids
			// waiting forever when the final assistant snapshot arrived before the click.
			let messages = [...(store.get(sessionMessageCacheBySessionIdAtomFamily(input.sourceSessionId))?.messages ?? [])];
			let sourceReadFailed = false;
			try {
				const diskMessages = await desktopApi.sessions.readRecordMessages(input.sourceSessionId);
				const cachedLast = messages.at(-1)?.timestamp ?? 0;
				const diskLast = diskMessages.at(-1)?.timestamp ?? 0;
				if (diskMessages.length > messages.length || (diskMessages.length === messages.length && diskLast > cachedLast)) {
					messages = diskMessages;
				}
			} catch {
				// Anonymous/source runtimes have no JSONL; the live cache remains authoritative.
				sourceReadFailed = true;
			}
			if (requestRef.current !== requestId || !mountedRef.current) return false;
			if (sourceReadFailed && messages.length === 0 && !store.get(sessionRuntimeBySessionIdAtomFamily(input.sourceSessionId))) {
				throw new Error("PROJECT_IDEA_PLANS_SOURCE_SESSION_UNAVAILABLE");
			}
			// 归纳只消费已完成讨论；若来源仍在生成或等待 Ask 回答，立即反馈而不是
			// 静默订阅并无限等待。用户完成当前回合后可再次点击归纳。
			if (!hasCompletedAssistantTurn(messages)) {
				const sourceRuntime = store.get(sessionRuntimeBySessionIdAtomFamily(input.sourceSessionId));
				if (sourceRuntime?.status === "starting" || sourceRuntime?.status === "running") {
					throw new Error("PROJECT_IDEA_PLANS_SOURCE_SESSION_BUSY");
				}
				if (sourceRuntime?.status === "error" || sourceRuntime?.status === "closed" || sourceRuntime?.status === "detached") {
					throw new Error("PROJECT_IDEA_PLANS_SOURCE_SESSION_UNAVAILABLE");
				}
				throw new Error("PROJECT_IDEA_PLANS_SOURCE_SESSION_EMPTY");
			}
			if (requestRef.current !== requestId || !mountedRef.current) return false;
			const transcript = messages
				.filter((message) => message.role === "user" || message.role === "assistant")
				.map((message) => `${message.role}: ${message.text}`)
				.join("\n\n");
			if (!transcript.trim()) throw new Error("PROJECT_IDEA_PLANS_SOURCE_SESSION_EMPTY");

			const { session: summarySession } = await desktopApi.sessions.createAnonymous({
				projectId: input.projectId,
				title: "Project idea summary",
				backend: "pi",
				noTools: true,
				...(input.model ? { model: input.model } : {}),
				...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
			});
			createdSummarySessionId = summarySession.id;
			if (requestRef.current !== requestId || !mountedRef.current) {
				await cleanupSummarySession(summarySession.id);
				return false;
			}
			activeSummarySessionIdRef.current = summarySession.id;
			const baselineAssistantIds = new Set((store.get(sessionMessageCacheBySessionIdAtomFamily(summarySession.id))?.messages ?? [])
				.filter((message) => message.role === "assistant")
				.map((message) => message.id));
			const request: SummaryRequest = {
				requestId,
				sessionId: summarySession.id,
				baselineAssistantIds,
				onCompleted: input.onCompleted,
				onError: input.onError,
			};
			requestStateRef.current = request;

			const response = await desktopApi.sessions.sendPrompt({
				sessionId: summarySession.id,
				requestId: crypto.randomUUID(),
				message: buildProjectIdeaBrainstormSummaryPrompt(input.title, input.body, transcript),
			});
			if (!response.accepted) throw new Error(response.error);
			if (requestRef.current !== requestId || !mountedRef.current || requestStateRef.current?.requestId !== requestId) {
				await cleanupSummarySession(summarySession.id);
				return false;
			}

			let summaryTurnStarted = store.get(sessionRuntimeBySessionIdAtomFamily(summarySession.id))?.status === "running";
			const result = await waitForSessionCondition(store, summarySession.id, (currentMessages, runtime) => {
				// A length-limited response is still terminal. Feed its text into the strict
				// JSON parser so complete JSON succeeds and truncated JSON reports invalid,
				// instead of waiting forever after the runtime has already settled.
				const assistantMessage = [...currentMessages]
					.reverse()
					.find((message) => isSummaryAssistantTerminal(message) && !baselineAssistantIds.has(message.id));
				if (assistantMessage?.text.trim()) return { kind: "ready", value: assistantMessage.text };
				if (assistantMessage) return { kind: "error", error: "PROJECT_IDEA_PLANS_RESPONSE_INVALID" };
				if (runtime?.status === "running") summaryTurnStarted = true;
				if (summaryTurnStarted && runtime?.status === "idle") {
					return { kind: "error", error: "PROJECT_IDEA_PLANS_RESPONSE_INVALID" };
				}
				if (runtime?.status === "error" || runtime?.status === "closed" || runtime?.status === "detached") {
					return { kind: "error", error: "PROJECT_IDEA_PLANS_RUNTIME_TERMINATED" };
				}
				return undefined;
			}, pendingWaitCancelRef);
			if (requestRef.current !== requestId || !mountedRef.current) {
				await cleanupSummarySession(summarySession.id);
				return false;
			}
			finishSummary(request, result);
			return true;
		} catch (reason) {
			if (requestStateRef.current?.requestId === requestId) requestStateRef.current = null;
			if (createdSummarySessionId) await cleanupSummarySession(createdSummarySessionId);
			if (requestRef.current === requestId && mountedRef.current && !isCancelledError(reason)) {
				setRunning(false);
				const message = reason instanceof Error ? reason.message : String(reason);
				setError(message);
				input.onError?.(message);
			}
			return false;
		}
	}, [cleanupSummarySession, finishSummary, store]);

	const cancel = useCallback(() => {
		requestRef.current += 1;
		pendingWaitCancelRef.current?.();
		pendingWaitCancelRef.current = null;
		const id = activeSummarySessionIdRef.current ?? requestStateRef.current?.sessionId;
		requestStateRef.current = null;
		setError(null);
		setSummary(null);
		setRunning(false);
		if (id) void cleanupSummarySession(id);
	}, [cleanupSummarySession]);

	useEffect(() => () => {
		mountedRef.current = false;
		requestRef.current += 1;
		pendingWaitCancelRef.current?.();
		pendingWaitCancelRef.current = null;
		requestStateRef.current = null;
		const id = activeSummarySessionIdRef.current;
		if (id) void cleanupSummarySession(id);
	}, [cleanupSummarySession]);

	return { summarize, cancel, running, error, summary };
}
