/**
 * Tests for the Warp terminal integration extension.
 *
 * These tests verify:
 * 1. Environment detection (isWarpTerminal)
 * 2. OSC 777 event formatting (emitWarpEvent)
 * 3. Extension lifecycle behavior (mock-based integration tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isWarpTerminal, emitWarpEvent, type WarpEventPayload } from "../extensions/warp-integration.js";

// ─── isWarpTerminal ─────────────────────────────────────────────────────────

describe("isWarpTerminal", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns true when TERM_PROGRAM is WarpTerminal", () => {
		process.env.TERM_PROGRAM = "WarpTerminal";
		expect(isWarpTerminal()).toBe(true);
	});

	it("returns true when TERM_PROGRAM is Warp", () => {
		process.env.TERM_PROGRAM = "Warp";
		expect(isWarpTerminal()).toBe(true);
	});

	it("returns true when WARP_IS_LOCAL_SHELL_SESSION is set", () => {
		delete process.env.TERM_PROGRAM;
		process.env.WARP_IS_LOCAL_SHELL_SESSION = "1";
		expect(isWarpTerminal()).toBe(true);
	});

	it("returns false for iTerm2", () => {
		process.env.TERM_PROGRAM = "iTerm.app";
		delete process.env.WARP_IS_LOCAL_SHELL_SESSION;
		expect(isWarpTerminal()).toBe(false);
	});

	it("returns false for Ghostty", () => {
		process.env.TERM_PROGRAM = "ghostty";
		delete process.env.WARP_IS_LOCAL_SHELL_SESSION;
		expect(isWarpTerminal()).toBe(false);
	});

	it("returns false when no terminal env is set", () => {
		delete process.env.TERM_PROGRAM;
		delete process.env.WARP_IS_LOCAL_SHELL_SESSION;
		expect(isWarpTerminal()).toBe(false);
	});
});

// ─── emitWarpEvent ──────────────────────────────────────────────────────────

describe("emitWarpEvent", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let captured: string[];

	beforeEach(() => {
		captured = [];
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
			captured.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("emits a correctly formatted OSC 777 sequence", () => {
		emitWarpEvent({
			event: "session_start",
			session_id: "test-123",
			cwd: "/tmp/proj",
			project: "proj",
			plugin_version: "0.1.0",
		});

		expect(captured).toHaveLength(1);
		const raw = captured[0];

		// Starts with ESC ] 777 ; notify ;
		expect(raw.startsWith("\x1b]777;notify;")).toBe(true);

		// Contains the sentinel title
		expect(raw).toContain("warp://cli-agent;");

		// Ends with BEL
		expect(raw.endsWith("\x07")).toBe(true);
	});

	it("includes protocol version and agent id in JSON body", () => {
		emitWarpEvent({
			event: "stop",
			session_id: "abc",
		});

		const raw = captured[0];
		// Extract JSON body between the last ; and BEL
		const jsonStart = raw.indexOf("warp://cli-agent;") + "warp://cli-agent;".length;
		const jsonEnd = raw.length - 1; // before BEL
		const body = JSON.parse(raw.slice(jsonStart, jsonEnd));

		expect(body.v).toBe(1);
		expect(body.agent).toBe("pi");
		expect(body.event).toBe("stop");
		expect(body.session_id).toBe("abc");
	});

	it("serializes prompt_submit with query", () => {
		emitWarpEvent({
			event: "prompt_submit",
			session_id: "s1",
			cwd: "/home/user/proj",
			project: "proj",
			query: "fix the bug",
		});

		const raw = captured[0];
		const body = parseBody(raw);

		expect(body.event).toBe("prompt_submit");
		expect(body.query).toBe("fix the bug");
		expect(body.cwd).toBe("/home/user/proj");
	});

	it("serializes tool_complete with tool_name and tool_input", () => {
		emitWarpEvent({
			event: "tool_complete",
			session_id: "s1",
			tool_name: "bash",
			tool_input: { command: "npm test" },
		});

		const body = parseBody(captured[0]);
		expect(body.event).toBe("tool_complete");
		expect(body.tool_name).toBe("bash");
		expect(body.tool_input).toEqual({ command: "npm test" });
	});

	it("serializes stop with query and response", () => {
		emitWarpEvent({
			event: "stop",
			session_id: "s1",
			query: "hello",
			response: "world",
		});

		const body = parseBody(captured[0]);
		expect(body.event).toBe("stop");
		expect(body.query).toBe("hello");
		expect(body.response).toBe("world");
	});

	it("serializes permission_request with summary", () => {
		emitWarpEvent({
			event: "permission_request",
			session_id: "s1",
			summary: "Allow rm -rf /tmp/foo?",
		});

		const body = parseBody(captured[0]);
		expect(body.event).toBe("permission_request");
		expect(body.summary).toBe("Allow rm -rf /tmp/foo?");
	});

	it("serializes idle_prompt (minimal payload)", () => {
		emitWarpEvent({
			event: "idle_prompt",
			session_id: "s1",
			cwd: "/tmp",
			project: "test",
		});

		const body = parseBody(captured[0]);
		expect(body.event).toBe("idle_prompt");
		expect(body.session_id).toBe("s1");
	});

	it("omits undefined fields from JSON", () => {
		emitWarpEvent({
			event: "stop",
		});

		const body = parseBody(captured[0]);
		expect(body.event).toBe("stop");
		expect(body).not.toHaveProperty("session_id");
		expect(body).not.toHaveProperty("query");
		expect(body).not.toHaveProperty("response");
	});
});

// ─── OSC sequence structure tests ───────────────────────────────────────────

describe("OSC 777 sequence structure", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let captured: string[];

	beforeEach(() => {
		captured = [];
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
			captured.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("uses BEL (0x07) as sequence terminator, not ST", () => {
		emitWarpEvent({ event: "stop" });
		const raw = captured[0];

		expect(raw.charCodeAt(raw.length - 1)).toBe(0x07);
		// Should NOT use ST (ESC \)
		expect(raw).not.toContain("\x1b\\");
	});

	it("does not double-escape inner JSON", () => {
		emitWarpEvent({
			event: "stop",
			query: 'He said "hello"',
		});

		const body = parseBody(captured[0]);
		expect(body.query).toBe('He said "hello"');
	});

	it("handles special characters in project names", () => {
		emitWarpEvent({
			event: "session_start",
			project: "my-project (v2)",
		});

		const body = parseBody(captured[0]);
		expect(body.project).toBe("my-project (v2)");
	});
});

// ─── Protocol conformance ───────────────────────────────────────────────────

describe("Warp v1 protocol conformance", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let captured: string[];

	beforeEach(() => {
		captured = [];
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
			captured.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("session_start includes plugin_version", () => {
		emitWarpEvent({
			event: "session_start",
			session_id: "x",
			plugin_version: "0.1.0",
		});

		const body = parseBody(captured[0]);
		expect(body.plugin_version).toBe("0.1.0");
	});

	it("all events include v=1 and agent=pi", () => {
		const events: WarpEventPayload["event"][] = [
			"session_start",
			"prompt_submit",
			"tool_complete",
			"stop",
			"permission_request",
			"permission_replied",
			"question_asked",
			"idle_prompt",
		];

		for (const event of events) {
			captured = [];
			emitWarpEvent({ event });
			const body = parseBody(captured[0]);
			expect(body.v).toBe(1);
			expect(body.agent).toBe("pi");
		}
	});

	it("event payloads parse as valid JSON", () => {
		emitWarpEvent({
			event: "tool_complete",
			session_id: "s1",
			tool_name: "bash",
			tool_input: {
				command: 'echo "hello\nworld"',
			},
		});

		// If JSON.parse doesn't throw, the body is valid
		const body = parseBody(captured[0]);
		expect(body.tool_input.command).toBe('echo "hello\nworld"');
	});
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseBody(raw: string): Record<string, any> {
	const sentinel = "warp://cli-agent;";
	const jsonStart = raw.indexOf(sentinel) + sentinel.length;
	const jsonEnd = raw.length - 1; // strip trailing BEL
	return JSON.parse(raw.slice(jsonStart, jsonEnd));
}
