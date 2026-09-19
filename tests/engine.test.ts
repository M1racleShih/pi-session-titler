import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ensureState, runTitleGeneration, type CompleteContext, type SessionState, type TitleEngineDeps } from "../src/engine.ts";

const MODEL = { id: "test-model", provider: "test", api: "openai-completions" };

function assistantMessage(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: parts,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		stopReason,
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as AssistantMessage;
}

function toolCallMessage(title: unknown): AssistantMessage {
	return assistantMessage([
		{ type: "toolCall", id: "call-1", name: "submit_title", arguments: { title } },
	]);
}

function textMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return { ...assistantMessage([{ type: "text", text }], stopReason), errorMessage } as AssistantMessage;
}

interface Harness {
	deps: TitleEngineDeps;
	state: SessionState;
	written: string[];
	currentSid: { value: string };
	currentName: { value: string | undefined };
	completeCalls: Array<{ tools?: unknown[]; toolChoice?: unknown; hasSignal: boolean }>;
	/** Allocate the next token exactly like the extension entry does. */
	bump(): number;
}

function createHarness(impl: (model: unknown, context: CompleteContext, options?: { toolChoice?: unknown; signal?: AbortSignal }) => Promise<AssistantMessage>, sid = "s1"): Harness {
	const state = ensureState(new Map(), sid);
	const written: string[] = [];
	const currentSid = { value: sid };
	const currentName = { value: undefined as string | undefined };
	const completeCalls: Harness["completeCalls"] = [];
	const deps: TitleEngineDeps = {
		complete: async (model, context, options) => {
			completeCalls.push({ tools: context.tools, toolChoice: options?.toolChoice, hasSignal: !!options?.signal });
			return impl(model, context, options);
		},
		getSessionName: () => currentName.value,
		setSessionName: (name) => {
			written.push(name);
			currentName.value = name;
		},
		getSessionId: () => currentSid.value,
	};
	return { deps, state, written, currentSid, currentName, completeCalls, bump: () => ++state.genToken };
}

const TOOL = { name: "submit_title", parameters: {} };
const BASE = { prompt: "修复登录模块的严重 bug", model: MODEL, sid: "s1", maxChars: 36, tool: TOOL, forcedChoice: { type: "function", function: { name: "submit_title" } } };

describe("runTitleGeneration — happy paths", () => {
	it("writes a structured title from path A", async () => {
		const h = createHarness(async (_m, context) => {
			expect(context.tools).toBeDefined();
			return toolCallMessage("修复登录模块");
		});
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.written).toEqual(["修复登录模块"]);
		expect(h.state.pending).toBe(false);
		expect(h.state.noStructured).toBe(false);
		expect(h.completeCalls[0]!.hasSignal).toBe(true);
		expect(h.completeCalls[0]!.toolChoice).toEqual(BASE.forcedChoice);
	});

	it("falls back to path B on plain text when no tool is configured", async () => {
		const h = createHarness(async (_m, context) => {
			expect(context.tools).toBeUndefined();
			return textMessage("“修复登录模块”");
		});
		await runTitleGeneration(h.deps, { ...BASE, tool: undefined, state: h.state, token: h.bump() });
		expect(h.written).toEqual(["修复登录模块"]);
	});
});

describe("runTitleGeneration — A→B degradation", () => {
	it("degrades to B in the same attempt when the model returns no tool call", async () => {
		const h = createHarness(async (_m, context) =>
			context.tools ? textMessage("修复登录模块") : textMessage("  修复登录模块  "),
		);
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.written).toEqual(["修复登录模块"]);
		expect(h.completeCalls).toHaveLength(2);
		expect(h.state.noStructured).toBe(true);
	});

	it("degrades to B on structural toolChoice rejection", async () => {
		let rejectedOnce = false;
		const h = createHarness(async (_m, context) => {
			if (context.tools && !rejectedOnce) {
				rejectedOnce = true;
				throw new Error("tool_choice is not supported with this model");
			}
			return textMessage("修复登录模块");
		});
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.written).toEqual(["修复登录模块"]);
		expect(h.state.noStructured).toBe(true);
	});

	it("skips A entirely on later attempts once noStructured is set", async () => {
		const h = createHarness(async (_m, context) => {
			expect(context.tools).toBeUndefined(); // never called with tools again
			return textMessage("修复登录模块");
		});
		h.state.noStructured = true;
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.completeCalls).toHaveLength(1);
		expect(h.written).toEqual(["修复登录模块"]);
	});

	it("does NOT call B after a transport failure of A", async () => {
		const h = createHarness(async () => {
			throw new Error("fetch failed: ECONNRESET");
		});
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.completeCalls).toHaveLength(1);
		expect(h.written).toEqual([]);
		expect(h.state.invalidAttempts).toBe(0); // transient: uncounted
		expect(h.state.pending).toBe(false);
	});
});

describe("runTitleGeneration — failure accounting", () => {
	it("counts a deterministic 4xx once and writes nothing", async () => {
		const h = createHarness(async () => textMessage("404 model not found", "error", "404 model not found"));
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.written).toEqual([]);
		expect(h.state.invalidAttempts).toBe(1);
	});

	it("counts schema-valid-but-garbage output as deterministic without trying B", async () => {
		const h = createHarness(async () => toolCallMessage("   ")); // normalizes to empty
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.completeCalls).toHaveLength(1);
		expect(h.state.invalidAttempts).toBe(1);
	});

	it("counts at most one invalid attempt per run (A structural + B garbage)", async () => {
		const h = createHarness(async (_m, context) =>
			context.tools ? textMessage("no tool call") : textMessage("..."),
		);
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.state.noStructured).toBe(true);
		expect(h.state.invalidAttempts).toBe(1); // not 2
	});

	it("in-band 429 is transient and uncounted", async () => {
		const h = createHarness(async () => textMessage("rate limited", "error", "429 rate limit"));
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.state.invalidAttempts).toBe(0);
		expect(h.written).toEqual([]);
	});
});

describe("runTitleGeneration — race protection", () => {
	it("discards the result when the session switched away", async () => {
		const h = createHarness(async () => toolCallMessage("修复登录模块"));
		const pending = runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		h.currentSid.value = "s2"; // user switched session before completion
		await pending;
		expect(h.written).toEqual([]);
		expect(h.state.pending).toBe(false);
	});

	it("still writes when the user switched away and back to the same session", async () => {
		const h = createHarness(async () => toolCallMessage("修复登录模块"));
		const pending = runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		h.currentSid.value = "s2";
		await Promise.resolve(); // let the sid change interleave
		h.currentSid.value = "s1"; // back to the original session
		await pending;
		expect(h.written).toEqual(["修复登录模块"]);
	});

	it("never overwrites a manual name set during flight", async () => {
		const h = createHarness(async () => {
			h.currentName.value = "手动名"; // manual /name lands mid-flight
			return toolCallMessage("修复登录模块");
		});
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.written).toEqual([]);
		expect(h.currentName.value).toBe("手动名");
	});

	it("a stale token cannot write or clear pending", async () => {
		const h = createHarness(async () => toolCallMessage("修复登录模块"));
		const stale = runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		// a newer attempt takes over the entry before the stale one finishes
		const fresh = runTitleGeneration(h.deps, { ...BASE, state: h.state, token: 2 });
		await stale;
		await fresh;
		expect(h.written).toEqual(["修复登录模块"]); // exactly one write, from the fresh attempt
		expect(h.state.pending).toBe(false);
	});

	it("state entries are isolated per session id", async () => {
		const map = new Map<string, SessionState>();
		const stA = ensureState(map, "sA");
		const stB = ensureState(map, "sB");
		stA.genToken = 1;
		stB.genToken = 1;
		expect(stA).not.toBe(stB);
		const hA = createHarness(async () => toolCallMessage("A title"), "sA");
		const hB = createHarness(async () => toolCallMessage("B title"), "sB");
		const runA = runTitleGeneration(hA.deps, { ...BASE, sid: "sA", state: stA, token: 1 });
		const runB = runTitleGeneration(hB.deps, { ...BASE, sid: "sB", state: stB, token: 1 });
		await Promise.all([runA, runB]);
		expect(hA.written).toEqual(["A title"]);
		expect(hB.written).toEqual(["B title"]);
		// A's finally cleared only its own entry
		expect(stA.pending).toBe(false);
		expect(stB.pending).toBe(false);
	});
});

describe("runTitleGeneration — clears pending on unexpected throw", () => {
	it("releases pending even if the deps throw outside the guarded paths", async () => {
		const h = createHarness(async () => {
			throw undefined; // non-Error throw
		});
		await runTitleGeneration(h.deps, { ...BASE, state: h.state, token: h.bump() });
		expect(h.state.pending).toBe(false);
	});
});
