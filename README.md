# pi-session-titler

Auto-generate short, readable display names for [pi](https://github.com/earendil-works/pi) coding-agent sessions.

When you send the first prompt of an unnamed session, pi-session-titler generates a concise title through a side-channel model call (it never enters the agent loop or the session history) and applies it with `setSessionName()`. The title shows up in the footer, `/resume`, and `pi -r` — no more squinting at truncated first messages.

```
修复登录模块的严重 bug          →  修复登录模块
Help me debug why the CI fails  →  Fix CI pipeline
```

## How it works

- **Triggers on the first prompt** of an unnamed session, in parallel with your task
- **Structured output, not prompt hope**: the title is requested through a forced `submit_title` tool call mapped to provider-native structured output (OpenAI strict JSON schema, Anthropic tool use, Google responseSchema, …) across all pi-ai adapters; plain-text generation with aggressive normalization is the automatic fallback
- **Manual names always win**: anything set via `/name`, `--name`, or the resume picker is never overwritten
- **Session-switch safe**: results are validated against session identity, request token, and current name before writing — a late result can never name the wrong session
- **Failure is silent and bounded**: transient errors (network, 5xx, 429) retry naturally on your next message; deterministic ones stop after 2 attempts per session
- **CJK-aware**: the length budget is display width (CJK/fullwidth count double), so titles survive terminal truncation

See [docs/design.md](docs/design.md) for the full specification, including the analysis of codex's auto-naming that informed this design.

## Install

```bash
pi install npm:pi-session-titler        # from npm (once published)
pi install git:github.com/M1racleShih/pi-session-titler   # from GitHub
```

Try it once without installing:

```bash
pi -e npm:pi-session-titler
```

## Configuration

Priority: CLI flag > environment variable > default.

| Flag | Environment variable | Default | Description |
|---|---|---|---|
| `--title-model <spec>` | `PI_TITLE_MODEL` | current session model | Title model as `provider/model-id` or bare model id (resolved against the current provider) |
| `--title-max-chars <n>` | `PI_TITLE_MAX_CHARS` | `36` | Title budget in **display width** (CJK counts double) |
| `--title-off` | `PI_TITLE_OFF=1` | off | Disable auto naming |

Examples:

```bash
# persist a cheaper title model
export PI_TITLE_MODEL=openai/gpt-5-mini

# one-off run with a specific model and budget
pi --title-model google/gemini-2.5-flash --title-max-chars 24
```

Notes:

- **Privacy**: by default the title request goes to the *current session's* model and provider — your prompt is never sent anywhere new. Only an explicit `--title-model`/`PI_TITLE_MODEL` can direct it elsewhere.
- A mistyped `--title-model` surfaces as HTTP 4xx, counts toward the 2-attempt deterministic cap for that session, and is otherwise silent — check the model id if titles stop appearing.
- Flags are per-launch; use the environment variables for persistent configuration. `pi config` can also disable the extension entirely.

## Development

```bash
npm install
npm test        # vitest
npm run typecheck
```

Layout: `src/title.ts` holds the pure functions (width, normalization, prompt building, failure classification), `src/engine.ts` the dependency-injected generation flow with all race protection, `src/auto-session-name.ts` the extension wiring.

## Security

Pi packages run with full system access and extensions execute arbitrary code — review the source before installing (this applies to any pi package, including this one). This extension makes exactly one kind of outbound call: the title request through your configured provider.

## License

[MIT](LICENSE)
