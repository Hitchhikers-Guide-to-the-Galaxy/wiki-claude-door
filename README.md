# wiki-claude-door

One question to a model, for the API handlers of federated wiki farm plugins. Shared by [wiki-plugin-audionote](https://github.com/Hitchhikers-Guide-to-the-Galaxy/wiki-plugin-audionote) (the Voice Tool's summarise) and wiki-plugin-plan (the Plan Tool's Do Next Phase and Revise Plan), so the two carry one door rather than two copies. It was factored out of audionote's `api/handlers.js` in Phase 4 of the Plan Tool Plan.

A caller names a model, not how the farm reaches it. A bare `claude-…` goes to the Claude API where the farm holds a key and to the Claude Code CLI (`claude -p`, as whoever is logged in on the farm's machine, a Claude Max account) where it does not; `claude-cli:claude-…` always takes the CLI; `ollama:name` asks an Ollama model whose URL may be a DNS-SD name. The door runs wherever the handler runs: on a laptop the CLI's own login, on a headless farm a token file handed to the CLI as `CLAUDE_CODE_OAUTH_TOKEN`.

```js
import { ask, door, fill, defaultModel } from '@fortyfoxes/wiki-claude-door'

const out = await ask(defaultModel(), fill('Summarise {{title}}.', { title }), {
  system: 'Write plain markdown.',
  timeoutMs: 7 * 60 * 1000,
  allowTools: false, // the default: every CLI tool disallowed
})
// { markdown, model, stop, usage, ms }
```

- `ask(model, content, { system, timeoutMs, allowTools })`: the answer, or an Error with a `status` and `unreachable` set when another model might do.
- `door(model)`: the route a model takes on this farm, e.g. `claude-cli:claude-opus-5-5`.
- `fill(template, values)`: `{{name}}` filled from values; a transcript the template never names is appended.
- `defaultModel(fallback)`: the farm's choice, else `fallback` (default `claude-opus-5-5`). Also `fallbackModel()`, `isModelId()`, `MODEL_ID`, and `discover` (DNS-SD, also at `@fortyfoxes/wiki-claude-door/discover`).

## Settings

Read when a question is asked. Each `CLAUDE_DOOR_*` name falls back to the `AUDIONOTE_*` name the Voice Tool always read, so a farm configured for audionote keeps working.

| Setting | Fallback | Meaning |
|---|---|---|
| CLAUDE_DOOR_MODEL | AUDIONOTE_SUMMARY_MODEL | the default model |
| CLAUDE_DOOR_FALLBACK_MODEL | AUDIONOTE_FALLBACK_MODEL | tried when the first cannot be reached |
| CLAUDE_DOOR_OLLAMA_URL | AUDIONOTE_OLLAMA_URL | a URL or `dnssd:` spec, default http://127.0.0.1:11434 |
| CLAUDE_DOOR_OLLAMA_FALLBACK | AUDIONOTE_OLLAMA_FALLBACK | the URL when DNS-SD fails |
| CLAUDE_DOOR_TOKEN_FILE | AUDIONOTE_CLAUDE_TOKEN_FILE | the CLI token, default ~/.config/voice/claude-token |
| CLAUDE_DOOR_BIN | AUDIONOTE_CLAUDE_BIN | the claude executable |
| CLAUDE_DOOR_KEY_FILE | | the API key file, default ~/.config/voice/anthropic-key |
| CLAUDE_DOOR_SCOPE_MEMORY | | the CLI's own memory cap: unset means 1G under a systemd unit on Linux and none elsewhere; a size such as 800M means always; off means never |
| CLAUDE_DOOR_SYSTEMD_RUN | | the systemd-run executable |

`ANTHROPIC_API_KEY`, when set, is the API key.

## The CLI's own scope

Since 0.1.1, on a farm run by systemd (the Pi5), `claude -p` starts through `systemd-run --user --scope` with its own `MemoryMax` and `MemorySwapMax=0`. Without that, the CLI was a child of the wiki farm and counted against the farm's own memory cap. A farm close to its cap plus a CLI of a few hundred MB meant the kernel killed the whole farm for being out of memory (OOM), not just the one question. In its own scope, a CLI that grows too big is killed alone, and the question fails with a 502 that says so.

## Status

0.1.1, ESM, Node 22.12 or later (CommonJS callers `require()` it). Installed beside its callers as `"@fortyfoxes/wiki-claude-door": "file:../wiki-claude-door"`; Phase 6 of the Plan Tool Plan publishes it to npm, after which the callers depend on the published version.

`npm test` runs the tests: filling, routing, settings, DNS-SD parsing, and the CLI road against a stand-in `claude`.

MIT, David Bovill.
