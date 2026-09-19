/**
 * pi-session-titler — auto-name pi sessions.
 *
 * Fires on the first user prompt of an unnamed session, generates a short
 * title through a side-channel `modelRegistry.complete()` call (never enters
 * the agent loop or session history), and applies it via `setSessionName()`.
 * Manual names always win; failures are silent.
 *
 * See docs/design.md for the full behavior specification.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_TITLE_MAX_CHARS, MAX_INVALID_ATTEMPTS, TITLE_TIMEOUT_MS, TITLE_TOOL_NAME } from "./constants.ts";
import { ensureState, runTitleGeneration, type SessionState } from "./engine.ts";
import { forcedToolChoice } from "./title.ts";

/** submit_title tool: provider-native structured output where supported. */
const SUBMIT_TITLE_TOOL = {
	name: TITLE_TOOL_NAME,
	description: "提交生成的会话标题（一个简短的单行标题字符串）",
	parameters: Type.Object({ title: Type.String() }, { additionalProperties: false }),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
} as const;

/** Per-session engine state. session_start clears this for memory only. */
const sessionStates = new Map<string, SessionState>();

function envFlag(name: string): boolean {
	const value = process.env[name];
	return !!value && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveMaxChars(pi: ExtensionAPI): number {
	const flagValue = pi.getFlag("title-max-chars");
	const source = typeof flagValue === "string" && flagValue.trim() ? flagValue : process.env.PI_TITLE_MAX_CHARS;
	const parsed = source ? Number.parseInt(source, 10) : NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TITLE_MAX_CHARS;
}

export default function autoSessionName(pi: ExtensionAPI): void {
	pi.registerFlag("title-model", {
		type: "string",
		description: "Model for title generation as provider/model-id (default: current session model)",
	});
	pi.registerFlag("title-max-chars", {
		type: "string",
		description: `Title budget in display width, CJK counts double (default: ${DEFAULT_TITLE_MAX_CHARS})`,
	});
	pi.registerFlag("title-off", {
		type: "boolean",
		default: false,
		description: "Disable automatic session naming",
	});

	// Memory reclamation only — correctness never depends on this (design §3.2).
	pi.on("session_start", () => {
		sessionStates.clear();
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Handler must stay synchronous: this event blocks the agent loop.
		if (pi.getFlag("title-off") === true || envFlag("PI_TITLE_OFF")) return;

		const existingName = pi.getSessionName();
		if (existingName && existingName.trim()) return; // manual (or prior) name wins

		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !ctx.model) return;

		const prompt = (event.prompt ?? "").trim();
		if (!prompt) return;

		const st = ensureState(sessionStates, sid);
		if (st.pending) return;
		if (st.invalidAttempts >= MAX_INVALID_ATTEMPTS) return;

		// Resolve the title model: explicit flag/env spec, else the current model.
		let model: unknown = ctx.model;
		let api: string = ctx.model.api;
		const spec = (() => {
			const flagValue = pi.getFlag("title-model");
			return typeof flagValue === "string" && flagValue.trim() ? flagValue.trim() : process.env.PI_TITLE_MODEL?.trim();
		})();
		if (spec) {
			const slash = spec.indexOf("/");
			const provider = slash > 0 ? spec.slice(0, slash) : ctx.model.provider;
			const modelId = slash > 0 ? spec.slice(slash + 1) : spec;
			const found = ctx.modelRegistry.find(provider, modelId);
			if (found) {
				model = found;
				api = found.api;
			}
			// Unresolvable spec falls back to the current model; a genuinely bad
			// model id surfaces later as a deterministic 4xx and stops retrying.
		}

		const token = ++st.genToken;
		st.pending = true;

		const maxChars = resolveMaxChars(pi);
		void runTitleGeneration(
			{
				complete: (m, context, options) =>
					ctx.modelRegistry.complete(m as never, context as never, options as never),
				getSessionName: () => pi.getSessionName(),
				setSessionName: (name) => pi.setSessionName(name),
				getSessionId: () => ctx.sessionManager.getSessionId(),
			},
			{
				prompt,
				model,
				sid,
				state: st,
				token,
				maxChars,
				tool: SUBMIT_TITLE_TOOL,
				forcedChoice: forcedToolChoice(api),
				timeoutMs: TITLE_TIMEOUT_MS,
			},
		).catch(() => {
			// Belt over the engine's own finally: never wedge pending, never
			// surface an unhandled rejection.
			if (st.genToken === token) st.pending = false;
		});
	});
}
