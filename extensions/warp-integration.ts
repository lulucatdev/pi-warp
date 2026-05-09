/**
 * Warp Terminal Integration Extension for Pi
 *
 * Emits OSC 777 structured events using the warp://cli-agent protocol (v1)
 * so the Warp terminal can display real-time session status in its sidebar tab:
 *
 *   ● InProgress  — agent is thinking / executing tools
 *   ✓ Success     — agent turn completed
 *   ! Blocked     — agent needs user input (future, when pi exposes the hook)
 *
 * Also updates the terminal title (OSC 0) with a braille spinner during work,
 * matching the behavior of Codex CLI and Claude Code.
 *
 * Protocol reference:
 *   github.com/warpdotdev/Warp  app/src/terminal/cli_agent_sessions/event/
 *
 * Only activates when TERM_PROGRAM indicates a Warp terminal.
 */

import path from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Constants ──────────────────────────────────────────────────────────────

/** OSC 777 notification title that Warp watches for. */
const WARP_SENTINEL = "warp://cli-agent";

/** Protocol schema version. Warp dispatches to version-specific parsers. */
const PROTOCOL_VERSION = 1;

/**
 * Agent identifier string. Warp resolves this via CLIAgent::command_prefix()
 * to the CLIAgent::Pi variant.
 */
const AGENT_ID = "pi";

/** Extension's own version, reported in session_start for plugin-update UX. */
const PLUGIN_VERSION = "0.1.2";

/** Braille dot-spinner frames — same sequence used by Codex CLI. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Milliseconds between spinner frame advances. */
const SPINNER_INTERVAL_MS = 100;

/** Maximum characters kept from user query / assistant response in events. */
const MAX_TEXT_PREVIEW = 200;

/** How often to re-announce active work so Warp can recover dropped tab state. */
const ACTIVE_HEARTBEAT_INTERVAL_MS = 15_000;

/** Delay that lets Pi's user message event arrive before we send a fallback prompt. */
const FALLBACK_PROMPT_SUBMIT_DELAY_MS = 75;

/** Delay before telling Warp the prompt is idle again after a successful stop. */
const IDLE_PROMPT_DELAY_MS = 300;

/** Query text used when Pi resumes generation without adding a new user message. */
const CONTINUE_QUERY = "Continuing previous turn";

// ─── Environment detection ─────────────────────────────────────────────────

/**
 * Returns `true` when the current terminal is Warp.
 *
 * Warp sets TERM_PROGRAM to "WarpTerminal" and provides
 * WARP_IS_LOCAL_SHELL_SESSION for local sessions.
 */
export function isWarpTerminal(): boolean {
	const tp = process.env.TERM_PROGRAM ?? "";
	return (
		tp === "WarpTerminal" ||
		tp === "Warp" ||
		!!process.env.WARP_IS_LOCAL_SHELL_SESSION
	);
}

// ─── Event types (mirrors Warp's CLIAgentEventType enum) ────────────────────

export type WarpEventType =
	| "session_start"
	| "prompt_submit"
	| "tool_complete"
	| "stop"
	| "permission_request"
	| "permission_replied"
	| "question_asked"
	| "idle_prompt";

/** Payload for one warp://cli-agent OSC 777 notification. */
export interface WarpEventPayload {
	event: WarpEventType;
	session_id?: string;
	cwd?: string;
	project?: string;
	query?: string;
	response?: string;
	summary?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	plugin_version?: string;
}

// ─── OSC 777 emitter ────────────────────────────────────────────────────────

/**
 * Writes an OSC 777 PluggableNotification to stdout.
 *
 * Format: ESC ] 777 ; notify ; <title> ; <body> BEL
 *
 * The title is the sentinel `warp://cli-agent`.
 * The body is a JSON object conforming to the v1 schema.
 *
 * @internal exported for testing
 */
export function emitWarpEvent(payload: WarpEventPayload): void {
	const body = JSON.stringify({
		v: PROTOCOL_VERSION,
		agent: AGENT_ID,
		...payload,
	});
	// OSC 777 ; notify ; <title> ; <body> BEL
	process.stdout.write(`\x1b]777;notify;${WARP_SENTINEL};${body}\x07`);
}

// ─── Text helpers ───────────────────────────────────────────────────────────

/** Truncate text to a max length for event payloads. */
function truncate(text: string | undefined, max: number = MAX_TEXT_PREVIEW): string | undefined {
	if (!text) return undefined;
	return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Extract plain text from a message content value (string or content array). */
function extractText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join(" ") || undefined;
	}
	return undefined;
}

/** Extract the last assistant text from Pi's agent_end event. */
function extractLastAssistantResponse(messages: AgentEndEvent["messages"]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") {
			return truncate(extractText(message.content));
		}
	}
	return undefined;
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default function warpIntegration(pi: ExtensionAPI): void {
	// Gate: only activate inside Warp
	if (!isWarpTerminal()) return;

	// ── State ─────────────────────────────────────────────────────────────

	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let fallbackPromptTimer: ReturnType<typeof setTimeout> | null = null;
	let idlePromptTimer: ReturnType<typeof setTimeout> | null = null;
	let frameIndex = 0;
	let sessionId: string | undefined;
	let pendingQuery: string | undefined;
	let lastQuery: string | undefined;
	let promptSubmittedForTurn = false;
	let promptSubmittedQuery: string | undefined;

	// ── Title helpers ─────────────────────────────────────────────────────

	function projectName(): string {
		return path.basename(process.cwd());
	}

	function baseTitle(): string {
		const session = pi.getSessionName();
		const cwd = path.basename(process.cwd());
		return session ? `π ${session} — ${cwd}` : `π — ${cwd}`;
	}

	function setStaticTitle(ctx: ExtensionContext): void {
		ctx.ui.setTitle(baseTitle());
	}

	function startSpinner(ctx: ExtensionContext): void {
		stopSpinner(ctx);
		spinnerTimer = setInterval(() => {
			const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
			ctx.ui.setTitle(`${frame} ${baseTitle()}`);
			frameIndex++;
		}, SPINNER_INTERVAL_MS);
	}

	function stopSpinner(ctx: ExtensionContext): void {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
		frameIndex = 0;
		setStaticTitle(ctx);
	}

	function makeSessionId(): string {
		// crypto.randomUUID is available in Node 19+ and all modern runtimes
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return crypto.randomUUID();
		}
		// fallback: timestamp + random suffix
		return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	}

	function ensureSessionId(): string {
		sessionId ??= makeSessionId();
		return sessionId;
	}

	function emitSessionStart(): void {
		emitWarpEvent({
			event: "session_start",
			session_id: ensureSessionId(),
			cwd: process.cwd(),
			project: projectName(),
			plugin_version: PLUGIN_VERSION,
		});
	}

	function emitPromptSubmit(query: string | undefined): void {
		promptSubmittedForTurn = true;
		promptSubmittedQuery = query;
		lastQuery = query ?? lastQuery;

		emitWarpEvent({
			event: "prompt_submit",
			session_id: ensureSessionId(),
			cwd: process.cwd(),
			project: projectName(),
			query,
		});
	}

	function emitPromptSubmitIfChanged(query: string | undefined): void {
		if (promptSubmittedForTurn && promptSubmittedQuery === query) return;
		emitPromptSubmit(query);
	}

	function clearFallbackPromptTimer(): void {
		if (fallbackPromptTimer) {
			clearTimeout(fallbackPromptTimer);
			fallbackPromptTimer = null;
		}
	}

	function scheduleFallbackPromptSubmit(): void {
		clearFallbackPromptTimer();
		fallbackPromptTimer = setTimeout(() => {
			fallbackPromptTimer = null;
			if (!promptSubmittedForTurn) {
				emitPromptSubmit(pendingQuery ?? lastQuery ?? CONTINUE_QUERY);
			}
		}, FALLBACK_PROMPT_SUBMIT_DELAY_MS);
	}

	function stopActiveHeartbeat(): void {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	function startActiveHeartbeat(): void {
		stopActiveHeartbeat();
		heartbeatTimer = setInterval(() => {
			// Re-send both signals: session_start can recreate Warp's listener,
			// prompt_submit refreshes an existing listener back to InProgress.
			emitSessionStart();
			emitPromptSubmit(promptSubmittedQuery ?? pendingQuery ?? lastQuery ?? CONTINUE_QUERY);
		}, ACTIVE_HEARTBEAT_INTERVAL_MS);
	}

	function clearIdlePromptTimer(): void {
		if (idlePromptTimer) {
			clearTimeout(idlePromptTimer);
			idlePromptTimer = null;
		}
	}

	// ── Session lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		sessionId = makeSessionId();
		pendingQuery = undefined;
		lastQuery = undefined;
		promptSubmittedForTurn = false;
		promptSubmittedQuery = undefined;

		emitSessionStart();

		setStaticTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearFallbackPromptTimer();
		clearIdlePromptTimer();
		stopActiveHeartbeat();
		stopSpinner(ctx);
	});

	// ── Agent turn ────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		pendingQuery = truncate(event.prompt);
	});

	pi.on("agent_start", async (_event, ctx) => {
		clearIdlePromptTimer();
		promptSubmittedForTurn = false;
		promptSubmittedQuery = undefined;

		// Warp may drop the per-tab session after a completed turn. Re-announcing
		// here lets the next prompt self-heal without restarting the Warp tab.
		emitSessionStart();
		if (pendingQuery) {
			emitPromptSubmit(pendingQuery);
		} else {
			scheduleFallbackPromptSubmit();
		}

		startSpinner(ctx);
		startActiveHeartbeat();
	});

	// Capture the user's prompt for query reporting
	pi.on("message_start", async (event, _ctx) => {
		if (event.message?.role === "user") {
			const query = truncate(extractText(event.message.content)) ?? pendingQuery;
			lastQuery = query ?? lastQuery;
			clearFallbackPromptTimer();
			emitPromptSubmitIfChanged(query);
		}
	});

	pi.on("tool_result", async (event, _ctx) => {
		// Build a tool_input preview from the event args if available
		let toolInput: Record<string, unknown> | undefined;
		if (event.input) {
			const input = event.input as Record<string, unknown>;
			if (input.command) {
				toolInput = { command: input.command };
			} else if (input.path) {
				toolInput = { file_path: input.path };
			}
		}

		emitWarpEvent({
			event: "tool_complete",
			session_id: ensureSessionId(),
			cwd: process.cwd(),
			project: projectName(),
			tool_name: event.toolName,
			tool_input: toolInput,
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		clearFallbackPromptTimer();
		stopActiveHeartbeat();
		stopSpinner(ctx);

		// Try to extract last assistant response
		const response = extractLastAssistantResponse(event.messages);

		emitWarpEvent({
			event: "stop",
			session_id: ensureSessionId(),
			cwd: process.cwd(),
			project: projectName(),
			query: lastQuery,
			response,
		});
		pendingQuery = undefined;
		promptSubmittedForTurn = false;
		promptSubmittedQuery = undefined;

		// Emit idle_prompt after a short delay so Warp knows the agent
		// is alive but waiting for user input
		clearIdlePromptTimer();
		idlePromptTimer = setTimeout(() => {
			idlePromptTimer = null;
			emitWarpEvent({
				event: "idle_prompt",
				session_id: ensureSessionId(),
				cwd: process.cwd(),
				project: projectName(),
			});
		}, IDLE_PROMPT_DELAY_MS);
	});
}
