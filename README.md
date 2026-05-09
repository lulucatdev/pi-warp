# pi-warp

**Warp terminal integration for [Pi](https://pi.dev)** — real-time tab status, animated spinners, and rich session notifications.

When you run Pi inside [Warp](https://www.warp.dev), this extension sends structured lifecycle events so Warp can display the agent's status directly in its sidebar tab:

| Status | Tab indicator | Meaning |
|---|---|---|
| InProgress | ● spinner | Agent is thinking or executing tools |
| Success | ✓ checkmark | Agent turn completed |
| Blocked | ! exclamation | Agent needs user input (future) |

It also updates the terminal title with an animated braille spinner while the agent is working, matching the behavior of Codex CLI and Claude Code.

## Install

```bash
# From npm (recommended)
pi install npm:@capyup/pi-warp

# Or from git
pi install git:github.com/capyup/pi-warp
```

That's it — the extension auto-activates when Pi detects a Warp terminal (`TERM_PROGRAM=WarpTerminal`). In non-Warp terminals it does nothing.

## How It Works

### Two-Layer Protocol

Modern terminals like Warp integrate with CLI agents through two complementary mechanisms:

#### Layer 1: OSC 0 — Dynamic Terminal Title

Standard escape sequence (`\x1b]0;title\x07`) that updates the window/tab title. Pi-warp sets:

- **Working:** `⠋ π session — project` (animated braille spinner)
- **Ready:** `π session — project` (static, no spinner)

Most terminals display this in their tab bar as a basic activity indicator.

#### Layer 2: OSC 777 — Structured JSON Events (`warp://cli-agent`)

Warp defines a private protocol where CLI agents send structured notifications via OSC 777:

```
ESC ] 777 ; notify ; warp://cli-agent ; {"v":1,"agent":"pi","event":"stop",...} BEL
```

This gives Warp fine-grained session state: who's running, what they're doing, when they're blocked, and when they're done.

### Events Emitted

| Pi lifecycle event | Warp event | Status transition |
|---|---|---|
| `session_start` | `session_start` | Initialize tracking |
| `message_start` (user) | `prompt_submit` | → InProgress |
| `tool_result` | `tool_complete` | → InProgress |
| `agent_end` | `stop` | → Success ✓ |
| `agent_end` + 300ms | `idle_prompt` | (no change) |

### Event Payload (v1 Schema)

```jsonc
{
  "v": 1,                              // Protocol version
  "agent": "pi",                       // CLIAgent identifier
  "event": "prompt_submit",            // Event type
  "session_id": "a1b2c3d4-...",        // Stable per-session UUID
  "cwd": "/Users/you/project",         // Working directory
  "project": "project",                // Project folder name
  "query": "fix the failing tests",    // User's prompt (truncated)
  "response": "Done! All tests pass.", // Agent's reply (truncated)
  "tool_name": "bash",                 // Last tool used
  "tool_input": {"command": "npm test"},// Tool arguments preview
  "plugin_version": "0.1.0"            // Extension version
}
```

## Research Background

### How Does Warp Know What CLI Agents Are Doing?

We reverse-engineered Warp's open-source codebase ([warpdotdev/Warp](https://github.com/warpdotdev/Warp)) and cross-referenced it with Codex CLI ([openai/codex](https://github.com/openai/codex)) and Claude Code to understand the full integration story. Here's what we found.

#### Warp's Architecture

Warp maintains a `CLIAgentSessionsModel` — a per-tab state machine that tracks:

```
CLIAgentSessionStatus:
  InProgress  →  the agent is working
  Success     →  the agent's turn is done
  Blocked     →  the agent needs user input
```

It detects CLI agents by matching the command against known prefixes (`claude`, `codex`, `gemini`, `pi`, `amp`, etc.) and subscribes to their PTY output for event signals.

#### How Codex CLI Integrates

Codex uses **two mechanisms** (neither of which is the structured JSON protocol):

1. **OSC 0 terminal title** — Rich dynamic titles like `⠋ codex - project | Working` that Warp reads as a fallback tab label
2. **OSC 9 plain-text notifications** — Simple text like `"Agent turn complete"` that Warp's `CodexSessionHandler` parses into a Stop event

Codex does *not* send OSC 777 JSON events. Its Warp integration is lower-fidelity — all OSC 9 notifications are treated as "success/stop" since there's no way to distinguish event types from plain text.

#### How Claude Code Integrates

Claude Code uses the **full OSC 777 `warp://cli-agent` protocol** with structured JSON events. This is the gold standard — Warp gets precise `prompt_submit`, `tool_complete`, `stop`, `permission_request`, etc. events with rich metadata.

Warp uses `DefaultSessionListener` for Claude Code (and also for Pi, Gemini, OpenCode, Auggie), which expects structured JSON events via OSC 777.

#### What Pi Was Missing

| Capability | Codex | Claude Code | Pi (before) | Pi (with pi-warp) |
|---|---|---|---|---|
| OSC 0 dynamic title with spinner | ✅ rich | ✅ | ❌ static | ✅ |
| OSC 777 `session_start` | ❌ | ✅ | ❌ | ✅ |
| OSC 777 `prompt_submit` | ❌ | ✅ | ❌ | ✅ |
| OSC 777 `tool_complete` | ❌ | ✅ | ❌ | ✅ |
| OSC 777 `stop` (success) | ❌ | ✅ | ❌ | ✅ |
| OSC 777 `idle_prompt` | ❌ | ✅ | ❌ | ✅ |
| Warp tab status display | ⚠️ stop only | ✅ full | ❌ none | ✅ full |

Pi had `CLIAgent::Pi` registered in Warp's codebase (with a brand color and `DefaultSessionListener`), but since Pi never sent any events, the handler had nothing to process.

#### Why an Extension Works

Pi's extension API provides all the necessary hooks:

- `session_start` / `session_shutdown` → session lifecycle
- `agent_start` / `agent_end` → turn lifecycle
- `message_start` → capture user prompts
- `tool_result` → tool completion events
- `ctx.ui.setTitle()` → terminal title control
- `process.stdout.write()` → raw escape sequence output

This makes it possible to implement the full `warp://cli-agent` protocol as a pure extension, without any changes to Pi's core.

### Source References

- **Warp event protocol:** [`app/src/terminal/cli_agent_sessions/event/`](https://github.com/warpdotdev/Warp/tree/main/app/src/terminal/cli_agent_sessions/event)
- **Warp CLI agent enum:** [`app/src/terminal/cli_agent.rs`](https://github.com/warpdotdev/Warp/blob/main/app/src/terminal/cli_agent.rs)
- **Warp session handler:** [`app/src/terminal/cli_agent_sessions/listener/mod.rs`](https://github.com/warpdotdev/Warp/blob/main/app/src/terminal/cli_agent_sessions/listener/mod.rs)
- **Codex terminal title:** [`codex-rs/tui/src/terminal_title.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/terminal_title.rs)
- **Codex status surfaces:** [`codex-rs/tui/src/chatwidget/status_surfaces.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/status_surfaces.rs)

## Development

```bash
# Install dev dependencies
npm install

# Run tests
npx vitest run

# Test locally without installing
pi -e ./extensions/warp-integration.ts
```

## Future Work

- **`permission_request` / `question_asked` events:** Pi's extension API doesn't currently expose a "waiting for user approval" hook. When Pi adds this, the extension can emit `permission_request` to show the Blocked status in Warp's tab.
- **`WARP_CLI_AGENT_PROTOCOL_VERSION` negotiation:** Warp exports this env var on the PTY. Future versions could use it to negotiate payload format.

## License

MIT
