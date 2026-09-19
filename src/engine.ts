/**
 * Core title-generation engine with injected dependencies.
 *
 * All session identity (sid / state entry / token) is captured per request and
 * never re-read through resettable module state — correctness does not depend
 * on `session_start` cleanup (design doc §3.2).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildTitlePrompt, classifyErrorMessage, classifyThrownError, normalizeTitle } from "./title.ts";
import { TITLE_TOOL_NAME, TITLE_TIMEOUT_MS } from "./constants.ts";

/** Per-session state. Keyed by sessionId in the extension entry. */
export interface SessionState {
	pending: boolean;
	/** Monotonic per-entry request token; only the current holder may write or clear. */
	genToken: number;
	invalidAttempts: number;
	noStructured: boolean;
}

export function ensureState(map: Map<string, SessionState>, sid: string): SessionState {
	let state = map.get(sid);
	if (!state) {
		state = { pending: false, genToken: 0, invalidAttempts: 0, noStructured: false };
		map.set(sid, state);
	}
	return state;
}

export interface CompleteContext {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
}

export interface CompleteOptions {
	toolChoice?: unknown;
	signal?: AbortSignal;
}

export interface TitleEngineDeps {
	complete(model: unknown, context: CompleteContext, options?: CompleteOptions): Promise<AssistantMessage>;
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
	getSessionId(): string | undefined;
}

export interface TitleEngineOptions {
	prompt: string;
	model: unknown;
	sid: string;
	state: SessionState;
	token: number;
	maxChars: number;
	/** Structured tool definition; omit to skip path A entirely. */
	tool?: unknown;
	/** Provider-specific forced toolChoice for path A. */
	forcedChoice?: unknown;
	timeoutMs?: number;
}

interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Extract the title string from a `submit_title` tool call, if present and well-formed. */
function pickTitleCall(message: AssistantMessage): string | null {
	for (const part of message.content) {
		if (part.type === "toolCall") {
			const call = part as ToolCallPart;
			if (call.name === TITLE_TOOL_NAME && typeof call.arguments?.title === "string") {
				return call.arguments.title;
			}
		}
	}
	return null;
}

/** Plain text of an assistant message (local equivalent of pi-ai `contentText`). */
function messageText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

/** In-band provider failure (`stopReason: "error"`). */
function inBandFailure(message: AssistantMessage): FailureKindOrClean {
	if (message.stopReason === "error") {
		return classifyErrorMessage(message.errorMessage ?? "");
	}
	return "clean";
}

type FailureKindOrClean = "structural" | "deterministic" | "transient" | "clean";

/**
 * Run one title-generation attempt for a session.
 *
 * Flow (design doc §3.1):
 * - Path A (structured): forced tool call. Structural failures set
 *   `noStructured` and fall through to B in the same attempt. Transport
 *   failures abort the attempt without counting (same model/channel would
 *   fail B too). Deterministic failures count toward the per-session cap.
 * - Path B (plain text): normalization-only.
 * - At most one `invalidAttempts++` per attempt.
 * - Write only after triple validation: session identity, token, empty name.
 * - `finally` clears `pending` only if this attempt still owns the entry.
 */
export async function runTitleGeneration(deps: TitleEngineDeps, opts: TitleEngineOptions): Promise<void> {
	const { sid, state: st, token, maxChars } = opts;
	const timeoutMs = opts.timeoutMs ?? TITLE_TIMEOUT_MS;
	const userText = buildTitlePrompt(opts.prompt, maxChars);

	try {
		let title: string | undefined;
		let deterministicFailure = false;

		if (opts.tool && !st.noStructured) {
			try {
				const message = await deps.complete(
					opts.model,
					{ messages: [{ role: "user", content: [{ type: "text", text: userText }] }], tools: [opts.tool] },
					{ toolChoice: opts.forcedChoice, signal: AbortSignal.timeout(timeoutMs) },
				);
				const failure = inBandFailure(message);
				if (failure === "transient") return;
				if (failure === "deterministic") {
					st.invalidAttempts++;
					return;
				}
				if (failure === "structural") {
					st.noStructured = true; // fall through to B below
				} else {
					const rawTitle = pickTitleCall(message);
					if (rawTitle === null) {
						st.noStructured = true; // no/well-formed-missing tool call → structural
					} else {
						title = normalizeTitle(rawTitle, maxChars);
						if (!title) deterministicFailure = true; // model produced garbage via valid schema
					}
				}
			} catch (error) {
				const kind = classifyThrownError(error);
				if (kind === "transient") return;
				if (kind === "deterministic") {
					st.invalidAttempts++;
					return;
				}
				st.noStructured = true; // structural → B
			}
		}

		if (!title && !deterministicFailure) {
			try {
				const message = await deps.complete(
					opts.model,
					{ messages: [{ role: "user", content: [{ type: "text", text: userText }] }] },
					{ signal: AbortSignal.timeout(timeoutMs) },
				);
				const failure = inBandFailure(message);
				if (failure === "transient" || failure === "structural") return; // nothing better to do; no count
				if (failure === "deterministic") {
					deterministicFailure = true;
				} else {
					title = normalizeTitle(messageText(message), maxChars);
				}
			} catch (error) {
				const kind = classifyThrownError(error);
				if (kind === "deterministic") {
					deterministicFailure = true;
				} else {
					return; // transient/unknown: no count
				}
			}
		}

		if (!title || deterministicFailure) {
			st.invalidAttempts++;
			return;
		}

		// Triple validation before writing (design doc §3.1).
		if (deps.getSessionId() !== sid) return; // session switched away
		if (st.genToken !== token) return; // a newer attempt owns this entry
		const existing = deps.getSessionName();
		if (existing && existing.trim()) return; // manual name wins
		deps.setSessionName(title);
	} finally {
		if (st.genToken === token) st.pending = false;
	}
}
