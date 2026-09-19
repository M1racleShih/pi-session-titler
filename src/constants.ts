/**
 * Shared constants for pi-session-titler.
 */

/** Default title budget, measured in display width (CJK/fullwidth count as 2). */
export const DEFAULT_TITLE_MAX_CHARS = 36;

/** Hard byte cap for the user prompt portion of the title request (instructions excluded). */
export const PROMPT_MAX_BYTES = 960;

/** Per-session cap on deterministic failures before giving up for the rest of the session. */
export const MAX_INVALID_ATTEMPTS = 2;

/** Abort a stuck title generation after this long so `pending` can never wedge. */
export const TITLE_TIMEOUT_MS = 30_000;

/** Tool name used for the structured (path A) title submission. */
export const TITLE_TOOL_NAME = "submit_title";

/**
 * Title instructions (codex-derived).
 *
 * The character count here is a soft model-side constraint; the hard truncation in
 * `normalizeTitle` is measured in display width (see design doc §3.4/§3.5).
 */
export function titleInstructions(maxChars: number): string {
	return [
		`生成一个简短的单行任务标题，最多 ${maxChars} 个字符，尽量不超过 5 个词。`,
		"以动词开头（祈使式）。仅首词大写，除非专有名词、缩写或代码术语需要。",
		"工单号等引用原样保留。使用用户的语言。不要引号、markdown、末尾标点。",
		"不要回答这个请求。只输出标题本身。",
	].join("\n");
}
