import { describe, expect, it } from "vitest";
import {
	buildTitlePrompt,
	classifyErrorMessage,
	classifyThrownError,
	displayWidth,
	forcedToolChoice,
	normalizeTitle,
	truncateByWidth,
	truncateToBytes,
} from "../src/title.ts";
import { DEFAULT_TITLE_MAX_CHARS, PROMPT_MAX_BYTES, TITLE_TOOL_NAME } from "../src/constants.ts";

describe("displayWidth", () => {
	it("counts ASCII as 1", () => {
		expect(displayWidth("Fix login bug")).toBe(13);
	});

	it("counts CJK as 2", () => {
		expect(displayWidth("修复登录")).toBe(8);
	});

	it("counts emoji (surrogate pairs) as wide single units", () => {
		expect(displayWidth("🚀")).toBe(2);
		expect(displayWidth("go 🚀 now")).toBe(9); // 3 + 2 + 4
	});

	it("counts combining marks as zero width", () => {
		expect(displayWidth("e\u0301")).toBe(1); // e + combining acute
	});

	it("counts fullwidth punctuation as 2", () => {
		expect(displayWidth("！")).toBe(2);
		expect(displayWidth("。")).toBe(2);
	});
});

describe("truncateByWidth", () => {
	it("truncates by display width, not characters", () => {
		expect(truncateByWidth("修复登录模块的严重问题", 10)).toBe("修复登录模"); // width 10 = 5 CJK chars
		expect(displayWidth("修复登录模")).toBe(10);
	});

	it("never splits a surrogate pair", () => {
		const out = truncateByWidth("ab🚀cd", 3); // a(1) b(1) 🚀(2>3-2? no: 2+2=4>3) → stop before 🚀
		expect(out).toBe("ab");
		expect(truncateByWidth("a🚀b", 3)).toBe("a🚀");
	});

	it("keeps trailing combining marks attached", () => {
		const base = "中中中中"; // width 8
		const withMark = "中中中中\u0301"; // width 8, mark 0
		expect(truncateByWidth(withMark, 8)).toBe(withMark);
	});

	it("returns empty when the first character exceeds the budget", () => {
		expect(truncateByWidth("中", 1)).toBe("");
		expect(truncateByWidth("abc", 0)).toBe("");
	});
});

describe("normalizeTitle", () => {
	it("keeps a clean title", () => {
		expect(normalizeTitle("Fix login bug", 36)).toBe("Fix login bug");
	});

	it("takes the first non-empty line of multiline output", () => {
		expect(normalizeTitle("\n\n  修复登录模块  \n其余解释内容", 36)).toBe("修复登录模块");
	});

	it("strips markdown heading prefixes", () => {
		expect(normalizeTitle("## Fix login bug", 36)).toBe("Fix login bug");
	});

	it("strips 标题：/Title: prefixes (repeatedly)", () => {
		expect(normalizeTitle("标题：修复登录模块", 36)).toBe("修复登录模块");
		expect(normalizeTitle("Title: Fix login bug", 36)).toBe("Fix login bug");
		expect(normalizeTitle("标题: Fix login", 36)).toBe("Fix login");
	});

	it("strips wrapping quotes including curly quotes", () => {
		expect(normalizeTitle('"Fix login bug"', 36)).toBe("Fix login bug");
		expect(normalizeTitle("“修复登录模块”", 36)).toBe("修复登录模块");
		expect(normalizeTitle("'Fix login'", 36)).toBe("Fix login");
		expect(normalizeTitle("`Fix login`", 36)).toBe("Fix login");
	});

	it("collapses internal whitespace", () => {
		expect(normalizeTitle("Fix   login\t\tbug", 36)).toBe("Fix login bug");
	});

	it("strips trailing punctuation (ASCII and CJK)", () => {
		expect(normalizeTitle("Fix login bug.", 36)).toBe("Fix login bug");
		expect(normalizeTitle("修复登录模块。", 36)).toBe("修复登录模块");
		expect(normalizeTitle("Fix login?!", 36)).toBe("Fix login");
	});

	it("keeps internal punctuation", () => {
		expect(normalizeTitle("Fix PROJ-1234 crash", 36)).toBe("Fix PROJ-1234 crash");
	});

	it("returns undefined for non-strings", () => {
		expect(normalizeTitle(undefined, 36)).toBeUndefined();
		expect(normalizeTitle(42, 36)).toBeUndefined();
	});

	it("returns undefined when nothing survives cleaning", () => {
		expect(normalizeTitle("", 36)).toBeUndefined();
		expect(normalizeTitle("   \n  \t ", 36)).toBeUndefined();
		expect(normalizeTitle('".?!"', 36)).toBeUndefined();
	});

	it("truncates to the display-width budget (CJK ≈ half the characters)", () => {
		// 36 width budget → 18 CJK chars
		const long = "一二三四五六七八九十一二三四五六七八九";
		expect(normalizeTitle(long, 36)).toBe("一二三四五六七八九十一二三四五六七八");
	});

	it("uses the default budget of 36 when maxChars is default", () => {
		const long = "a".repeat(50);
		expect(normalizeTitle(long, DEFAULT_TITLE_MAX_CHARS)).toBe("a".repeat(36));
	});
});

describe("buildTitlePrompt", () => {
	it("contains instructions and the user request", () => {
		const prompt = buildTitlePrompt("fix the login bug", 36);
		expect(prompt).toContain("用户请求：");
		expect(prompt).toContain("fix the login bug");
		expect(prompt).toContain("只输出标题本身");
	});

	it("caps only the user message at PROMPT_MAX_BYTES", () => {
		const userPart = "修".repeat(2000); // 3 bytes each → 6000 bytes
		const prompt = buildTitlePrompt(userPart, 36);
		const userSection = prompt.slice(prompt.indexOf("用户请求："));
		expect(Buffer.byteLength(userSection, "utf8")).toBeLessThanOrEqual(PROMPT_MAX_BYTES + Buffer.byteLength("用户请求：\n", "utf8"));
		// instructions are additive: total exceeds the user-part cap
		expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(PROMPT_MAX_BYTES);
	});

	it("never splits a multibyte character when truncating", () => {
		const prompt = buildTitlePrompt("修".repeat(400), 36);
		const userSection = prompt.slice(prompt.indexOf("用户请求：\n") + "用户请求：\n".length);
		expect(userSection.length % 1).toBe(0); // no lone surrogates/bytes; each char intact
		expect(Buffer.byteLength(userSection, "utf8") % 3).toBe(0); // all chars complete (3 bytes each)
	});
});

describe("truncateToBytes", () => {
	it("passes through short strings", () => {
		expect(truncateToBytes("abc", 100)).toBe("abc");
	});

	it("truncates by bytes without splitting multibyte chars", () => {
		expect(truncateToBytes("修修修", 7)).toBe("修修"); // 3+3=6 ≤ 7, +3=9 > 7
		expect(truncateToBytes("修修修", 2)).toBe("");
	});
});

describe("forcedToolChoice", () => {
	it("maps each known api to its provider shape", () => {
		expect(forcedToolChoice("openai-completions")).toEqual({
			type: "function",
			function: { name: TITLE_TOOL_NAME },
		});
		expect(forcedToolChoice("openai-responses")).toEqual({ type: "function", name: TITLE_TOOL_NAME });
		expect(forcedToolChoice("azure-openai-responses")).toEqual({ type: "function", name: TITLE_TOOL_NAME });
		expect(forcedToolChoice("openai-codex-responses")).toEqual({ type: "function", name: TITLE_TOOL_NAME });
		expect(forcedToolChoice("anthropic-messages")).toEqual({ type: "tool", name: TITLE_TOOL_NAME });
		expect(forcedToolChoice("bedrock-converse-stream")).toEqual({ type: "tool", name: TITLE_TOOL_NAME });
		expect(forcedToolChoice("google-generative-ai")).toBe("any");
		expect(forcedToolChoice("google-vertex")).toBe("any");
		expect(forcedToolChoice("mistral-conversations")).toBe("any");
		expect(forcedToolChoice("pi-messages")).toBe("required");
	});

	it("falls back to auto for unknown apis", () => {
		expect(forcedToolChoice("something-custom")).toBe("auto");
	});
});

describe("classifyErrorMessage", () => {
	it("classifies toolChoice rejections as structural", () => {
		expect(classifyErrorMessage("tool_choice is not supported by this model")).toBe("structural");
		expect(classifyErrorMessage("Function calling not supported")).toBe("structural");
	});

	it("classifies throttling/server/network as transient", () => {
		expect(classifyErrorMessage("429 rate limit exceeded")).toBe("transient");
		expect(classifyErrorMessage("500 internal server error")).toBe("transient");
		expect(classifyErrorMessage("503 overloaded")).toBe("transient");
		expect(classifyErrorMessage("fetch failed: ECONNRESET")).toBe("transient");
		expect(classifyErrorMessage("Request timed out")).toBe("transient");
	});

	it("classifies config errors as deterministic", () => {
		expect(classifyErrorMessage("404 model not found: no-such-model")).toBe("deterministic");
		expect(classifyErrorMessage("401 unauthorized: invalid api key")).toBe("deterministic");
		expect(classifyErrorMessage("Unknown provider: foo")).toBe("deterministic");
	});

	it("treats 429 as transient even though it is 4xx", () => {
		expect(classifyErrorMessage("HTTP 429")).toBe("transient");
	});

	it("treats unrecognized messages as transient", () => {
		expect(classifyErrorMessage("something completely unforeseen")).toBe("transient");
	});
});

describe("classifyThrownError", () => {
	it("classifies AbortError/TimeoutError as transient regardless of message", () => {
		const abort = new Error("The operation was aborted");
		abort.name = "AbortError";
		expect(classifyThrownError(abort)).toBe("transient");
		const timeout = new Error("TimeoutError: signal timed out");
		timeout.name = "TimeoutError";
		expect(classifyThrownError(timeout)).toBe("transient");
	});

	it("classifies ModelsError-style provider errors from their message", () => {
		const err = new Error("Unknown provider: nope");
		err.name = "ModelsError";
		expect(classifyThrownError(err)).toBe("deterministic");
	});

	it("treats non-errors as transient", () => {
		expect(classifyThrownError("just a string")).toBe("transient");
		expect(classifyThrownError(undefined)).toBe("transient");
	});
});
