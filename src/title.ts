/**
 * Pure helpers for pi-session-titler.
 *
 * This module must stay free of runtime imports so it is trivially unit-testable.
 * It intentionally has no dependency on the pi runtime or pi-ai.
 */

import { PROMPT_MAX_BYTES, TITLE_TOOL_NAME, titleInstructions } from "./constants.ts";

// ---------------------------------------------------------------------------
// Display width
// ---------------------------------------------------------------------------

/**
 * Code point ranges that render two cells wide in terminals (East Asian
 * Wide/Fullwidth plus the common emoji planes). Coarse by design — it only
 * needs to match how pi's footer/picker truncate, which is display width.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f], // Hangul Jamo
	[0x2e80, 0x303e], // CJK radicals / Kangxi / CJK symbols
	[0x3041, 0x33ff], // Hiragana .. CJK compatibility
	[0x3400, 0x4dbf], // CJK extension A
	[0x4e00, 0x9fff], // CJK unified ideographs
	[0xa000, 0xa4cf], // Yi
	[0xa960, 0xa97f], // Hangul Jamo extended-A
	[0xac00, 0xd7a3], // Hangul syllables
	[0xf900, 0xfaff], // CJK compatibility ideographs
	[0xfe10, 0xfe19], // vertical forms
	[0xfe30, 0xfe52], // CJK compatibility forms
	[0xfe54, 0xfe66],
	[0xfe68, 0xfe6b],
	[0xff00, 0xff60], // fullwidth forms
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f], // emoji (misc symbols .. emoticons)
	[0x1f680, 0x1f6ff], // transport/map
	[0x1f900, 0x1f9ff], // supplemental symbols
	[0x1fa70, 0x1faff],
	[0x20000, 0x2fffd], // CJK extension B..
	[0x30000, 0x3fffd],
];

function isCombining(cp: number): boolean {
	// \p{M} covers Mn/Me/Mc. Treated as zero width so combining sequences stay
	// attached to their base character during truncation.
	return /[\p{M}\p{Cf}]/u.test(String.fromCodePoint(cp));
}

function codePointWidth(cp: number): number {
	if (isCombining(cp)) return 0;
	for (const [lo, hi] of WIDE_RANGES) {
		if (cp >= lo && cp <= hi) return 2;
	}
	return 1;
}

/** Total display width of a string. Iterates code points (never splits surrogates). */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += codePointWidth(ch.codePointAt(0)!);
	}
	return width;
}

/**
 * Truncate to a display-width budget without splitting surrogate pairs or
 * detaching zero-width combining marks from their base character.
 */
export function truncateByWidth(text: string, maxWidth: number): string {
	let out = "";
	let width = 0;
	for (const ch of text) {
		const cw = codePointWidth(ch.codePointAt(0)!);
		if (width + cw > maxWidth) break;
		out += ch;
		width += cw;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Title normalization
// ---------------------------------------------------------------------------

const WRAPPING_QUOTES = new Set(['"', "'", "`", "“", "”", "‘", "’", "«", "»"]);
const TRAILING_PUNCTUATION = /[.?!！。？]+$/;

/**
 * Normalize a raw model output into a session title.
 *
 * Order (design doc §3.5): first non-empty line → strip prefixes → strip
 * wrapping quotes → collapse whitespace → strip trailing punctuation →
 * empty means failure → truncate to display width.
 *
 * Returns `undefined` when nothing usable survives.
 */
export function normalizeTitle(raw: unknown, maxChars: number): string | undefined {
	if (typeof raw !== "string") return undefined;

	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;

	// Strip repeatable prefixes: markdown headings and "标题:"/"Title:" labels.
	let line = firstLine;
	for (;;) {
		const stripped = line
			.replace(/^#{1,6}\s+/, "")
			.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, "")
			.trim();
		if (stripped === line) break;
		line = stripped;
	}

	// Strip wrapping quotes from either end (curly quotes included).
	while (line.length > 0) {
		const first = line[0]!;
		const last = line[line.length - 1]!;
		if (!WRAPPING_QUOTES.has(first) && !WRAPPING_QUOTES.has(last)) break;
		if (WRAPPING_QUOTES.has(first)) line = line.slice(1);
		if (line.length > 0 && WRAPPING_QUOTES.has(line[line.length - 1]!)) {
			line = line.slice(0, -1);
		}
	}

	line = line.replace(/\s+/g, " ").trim();
	line = line.replace(TRAILING_PUNCTUATION, "");

	if (!line) return undefined;

	const truncated = truncateByWidth(line, maxChars);
	return truncated.length > 0 ? truncated : undefined;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Truncate by UTF-8 bytes without splitting a multi-byte character. */
export function truncateToBytes(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	let out = "";
	let bytes = 0;
	for (const ch of text) {
		const b = byteLength(ch);
		if (bytes + b > maxBytes) break;
		out += ch;
		bytes += b;
	}
	return out;
}

/**
 * Build the single user message for the title request:
 * `<instructions>\n\n用户请求：\n<first prompt truncated to PROMPT_MAX_BYTES>`.
 *
 * The 960-byte cap applies to the user message only; instructions are
 * additional (deliberate deviation from codex, see design doc §3.4).
 */
export function buildTitlePrompt(userPrompt: string, maxChars: number): string {
	const prefix = `${titleInstructions(maxChars)}\n\n用户请求：\n`;
	const remaining = Math.max(0, PROMPT_MAX_BYTES);
	const truncated = truncateToBytes(userPrompt.trim(), remaining);
	return `${prefix}${truncated}`;
}

// ---------------------------------------------------------------------------
// Forced tool choice (structured path A)
// ---------------------------------------------------------------------------

/**
 * Provider-specific forced-toolChoice value so the model must emit a
 * `submit_title` tool call. Shapes verified against pi-ai 0.85.1 adapters
 * (design doc §3.3). Unknown APIs degrade to `"auto"`.
 */
export function forcedToolChoice(api: string): unknown {
	switch (api) {
		case "openai-completions":
			return { type: "function", function: { name: TITLE_TOOL_NAME } };
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return { type: "function", name: TITLE_TOOL_NAME };
		case "anthropic-messages":
		case "bedrock-converse-stream":
			return { type: "tool", name: TITLE_TOOL_NAME };
		case "google-generative-ai":
		case "google-vertex":
		case "mistral-conversations":
			// Google does not support naming a tool; with a single tool "any"
			// is equivalent.
			return "any";
		case "pi-messages":
			return "required";
		default:
			return "auto";
	}
}

// ---------------------------------------------------------------------------
// Failure classification (design doc §3.1)
// ---------------------------------------------------------------------------

export type FailureKind = "structural" | "deterministic" | "transient";

const STRUCTURAL_PATTERN =
	/tool[ _-]?choice|function calling|tool use|tools?\s+(are\s+)?not supported|unsupported.*tool|does not support.*tool/i;
const TRANSIENT_PATTERN =
	/\b(429|5\d\d|rate.?limit|too many requests|overloaded|timeout|timed out|econn|enotfound|ehostunreach|network|fetch failed|socket|aborted|cancel)/i;
const DETERMINISTIC_PATTERN =
	/\b40[013]|404|405|422|unknown provider|not configured|no api key|api key|unauthorized|forbidden|invalid|not found|does not exist/i;

/** Classify an error message string (used for both thrown errors and in-band `stopReason:"error"` messages). */
export function classifyErrorMessage(message: string): FailureKind {
	if (STRUCTURAL_PATTERN.test(message)) return "structural";
	if (TRANSIENT_PATTERN.test(message)) return "transient";
	if (DETERMINISTIC_PATTERN.test(message)) return "deterministic";
	return "transient"; // unrecognized → transient per design (fail-open on retries)
}

/** Classify a thrown error. Timeouts and aborts are always transient. */
export function classifyThrownError(error: unknown): FailureKind {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.name === "TimeoutError") return "transient";
		return classifyErrorMessage(error.message);
	}
	return "transient";
}
