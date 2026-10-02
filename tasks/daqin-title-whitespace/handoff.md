# Handoff — Trim generated titles after punctuation removal and width truncation

Issue: #1 "Trim generated titles after punctuation removal and width truncation"
Run: f7c507c4-9e80-4849-b6d3-f0fd1efa16b9
Baseline / integration baseline: 23e1d655112e56d93ab537e2b6998934a954a091

## Problem

`normalizeTitle` could return a title with invisible trailing whitespace:

- `normalizeTitle("Fix login bug", 4)` returned `"Fix "` — width truncation ended on the space.
- `normalizeTitle("Fix .", 36)` returned `"Fix "` — trailing-punctuation removal left the space before the period.

## Fix (src/title.ts)

- After trailing-punctuation removal, the result is trimmed.
- The truncated result is trimmed before it is returned.
- Trimming only shrinks the string, so the returned title stays within the supplied display-width budget. All other normalization (first non-empty line, prefix stripping, quote stripping, internal whitespace collapse, internal punctuation, CJK-aware width truncation) is unchanged; unusable output still returns `undefined`.

## Tests (tests/title.test.ts)

Four regression tests added (52 → 56 total):

- Trailing whitespace exposed by punctuation removal (`"Fix ."`, `"修复 。"`, `"Fix   ."`).
- Trailing whitespace exposed by width truncation (`"Fix login bug"` at budget 4).
- CJK display-width boundary (`"修复 登录"` at budget 5 → `"修复"`).
- Invariant check: returned titles are trimmed, nonempty, and within the width budget.

Acceptance cases verified directly:

| Case | Result |
| --- | --- |
| `normalizeTitle("Fix login bug", 4)` | `"Fix"` |
| `normalizeTitle("Fix .", 36)` | `"Fix"` |
| `normalizeTitle("修复 登录", 5)` | `"修复"` |

## Check evidence (run at the source checkout above)

- `npm test` — pass: 2 files, 56 tests (40 in tests/title.test.ts, 16 in tests/engine.test.ts).
- `npm run typecheck` — pass (`tsc --noEmit`, no errors).
- `git diff --check` — pass (exit 0, no whitespace errors).

## Changed files

- `src/title.ts` — trim after punctuation removal and after width truncation.
- `tests/title.test.ts` — regression tests described above.
- `README.md` — unchanged (behavior change is a bug fix; documented behavior is unaffected).

## Remaining steps (not performed by this run)

No commit, push, or PR was created per task limits. The controller should commit
this change on `codex/issue-1-trim-generated-titles` from baseline
23e1d655112e56d93ab537e2b6998934a954a091 and open the Draft PR to `main`
including the immutable requirements/check records in this task package. Human
acceptance and merge are still required.
