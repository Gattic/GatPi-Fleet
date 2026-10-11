// End-to-end: a real interactive pi (in a detached GNU screen, as users run it)
// with the bridge and a local scripted model, driven through the dashboard's BridgeHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { LineDecoder, encodeMessage, socketPath, type BridgeMessage } from "../../src/protocol/index.ts";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHardcopy, requestHardcopy } from "../../src/manager/actions/peek.ts";
import { BridgeHub } from "../../src/manager/collectors/bridges.ts";
import { pidFromSocketName, type SessionState } from "../../src/protocol/index.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-dash-e2e-"));
const runtime = join(root, "run");
const sockets = join(runtime, "pi-dash");
const screenName = `pi-dash-e2e-${process.pid}`;
const states = new Map<number, SessionState>();
const byes: string[] = [];
const hub = new BridgeHub(sockets, {
	onState: (pid, state) => states.set(pid, state),
	onBye: (_pid, reason) => byes.push(reason),
	onDisconnect: () => {},
	onIncompatible: () => {},
});
let pid = 0;

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		hub.scan();
		const value = check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const current = () => states.get(pid) as SessionState;
const lastAsk = () => current().asks.at(-1);
const sessionLines = () => readFileSync(current().sessionFile as string, "utf8").split("\n").filter(Boolean).length;

before(async () => {
	mkdirSync(join(root, "agent"), { recursive: true });
	mkdirSync(join(root, "project"));
	mkdirSync(runtime, { mode: 0o700 });
	writeFileSync(join(root, "agent", "settings.json"), "{}");
	const pi = [
		"pi",
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"-e",
		join(repo, "src/bridge/index.ts"),
		"-e",
		join(repo, "test/fixtures/scripted-provider.ts"),
		"-e",
		join(repo, "test/fixtures/roadmap-publisher.ts"),
		"-e",
		join(repo, "test/fixtures/suggestion-publisher.ts"),
		"--model",
		"dash-test/scripted",
		"--session-dir",
		join(root, "sessions"),
	];
	execFileSync("screen", ["-c", join(repo, "config/screenrc"), "-dmS", screenName, "sh", "-c", 'cd "$1" && shift && exec "$@"', "e2e", join(root, "project"), ...pi], {
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), XDG_RUNTIME_DIR: runtime },
	});
	pid = await waitFor("bridge socket", () => {
		const name = existsSync(sockets) ? readdirSync(sockets).find((entry) => entry.endsWith(".sock")) : undefined;
		return name ? pidFromSocketName(name) : undefined;
	}, 30_000);
	await waitFor("snapshot", () => states.get(pid));
});

after(() => {
	hub.close();
	try {
		execFileSync("screen", ["-S", screenName, "-X", "quit"], { stdio: "ignore" });
	} catch {}
	rmSync(root, { recursive: true, force: true });
});

test("snapshot identifies the session, its screen and its plan", () => {
	const state = current();
	assert.equal(state.pid, pid);
	assert.match(state.sty ?? "", new RegExp(`\\.${screenName}$`));
	assert.equal(state.window, "0");
	assert.equal(state.model, "dash-test/scripted");
	assert.equal(state.phase, "idle");
	assert.equal(state.plan?.title, "E2E plan");
	assert.deepEqual(state.plan?.activePath.map((step) => step.title), ["Two"]);
	assert.deepEqual(state.models, ["dash-test/scripted", "dash-test/scripted-thinking"]);
	assert.equal(state.lastSettledAt, undefined, "a fresh session is ready, not waiting");
	assert.equal(state.timeline.length, 1);
	assert.equal(state.timeline[0].state, "idle");
	assert.ok(state.timeline[0].at <= Date.now() - 100, "the timeline starts with the process");
});

test("the bridge itself rejects a stale incarnation, not only the dashboard hub", async () => {
	const reply = await new Promise<BridgeMessage>((resolve, reject) => {
		const socket = connect(socketPath(pid, sockets));
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("no stale-target ack")); }, 3000);
		const decoder = new LineDecoder();
		socket.setEncoding("utf8");
		socket.on("error", reject);
		socket.on("data", (data: string) => {
			for (const message of decoder.push(data) as BridgeMessage[]) if (message.type === "ack") {
				clearTimeout(timer); socket.destroy(); resolve(message);
			}
		});
		socket.on("connect", () => socket.write(encodeMessage({ type: "command", id: 99, target: { pid, sessionId: current().sessionId, instanceId: "obsolete" }, command: { kind: "rename", name: "WRONG TARGET" } })));
	});
	assert.equal(reply.type, "ack");
	assert.equal(reply.type === "ack" && reply.ok, false);
	assert.notEqual(current().name, "WRONG TARGET");
});

test("a prompt from the dashboard runs a turn: working → tool → idle with usage and a suggestion", async () => {
	await hub.send(current(), { kind: "prompt", text: "sleep 1" });
	await waitFor("tool activity", () => current().activity?.kind === "tool" && current().activity?.tool === "bash");
	assert.equal(current().phase, "working");
	await waitFor("settled", () => current().phase === "idle" && current().lastSettledAt);
	const state = current();
	assert.equal(state.lastPrompt, "sleep 1");
	assert.equal(state.lastSaid, "slept 1");
	await waitFor("suggestion", () => current().suggestion === "Run the tests next");
	assert.equal(state.usage.direct.tokens, 2200, "two scripted model calls of 1100 tokens");
	assert.ok(state.usage.direct.cost > 0);
	assert.equal(state.tools.at(-1)?.name, "bash");
	assert.ok(state.tools.at(-1)?.endedAt);
	assert.ok((state.context?.percent ?? 0) > 0);
	assert.deepEqual(state.timeline.map((entry) => entry.state), ["idle", "working", "waiting"]);
});

test("a multi-line reply arrives whole", async () => {
	await hub.send(current(), { kind: "prompt", text: "two\nlines" });
	await waitFor("settled", () => current().phase === "idle" && current().lastSaid?.startsWith("echo: two"));
	assert.equal(current().lastSaid, "echo: two\nlines");
	assert.equal(current().lastPrompt, "two lines");
});

test("while the session works, the text beside a tool call does not replace the latest reply", async () => {
	const reply = current().lastSaid;
	assert.ok(reply);
	await hub.send(current(), { kind: "prompt", text: "sleep 1" });
	await waitFor("tool activity", () => current().activity?.kind === "tool");
	assert.equal(current().lastSaid, reply);
	await waitFor("settled", () => current().phase === "idle" && current().lastSaid === "slept 1");
});

test("the prompt is visible in pi's own TUI (peek via screen hardcopy)", async () => {
	const file = join(root, "peek.txt");
	requestHardcopy(current().sty as string, current().window, file);
	const lines = await waitFor("hardcopy", () => readHardcopy(file));
	assert.ok(lines.some((line) => line.includes("slept 1")), lines.join("\n"));
});

test("steer while working is delivered in the same run; the suggestion is withdrawn meanwhile", async () => {
	await waitFor("suggestion", () => current().suggestion === "Run the tests next");
	await hub.send(current(), { kind: "prompt", text: "sleep 2" });
	await waitFor("working", () => current().phase === "working");
	await waitFor("suggestion withdrawn", () => current().suggestion === undefined);
	await hub.send(current(), { kind: "prompt", text: "steered", deliverAs: "steer" });
	await waitFor("settled", () => current().phase === "idle" && current().lastSaid === "echo: steered");
});

test("abort stops the run without reporting an error or replacing the latest reply", async () => {
	await hub.send(current(), { kind: "prompt", text: "sleep 30" });
	await waitFor("tool running", () => current().activity?.kind === "tool");
	await hub.send(current(), { kind: "abort" });
	await waitFor("idle after abort", () => current().phase === "idle");
	assert.equal(current().lastError, undefined);
	assert.equal(current().lastSaid, "echo: steered");
});

test("a reload rebuilds the latest reply from history, skipping the aborted run's tool-call text", async () => {
	execFileSync("screen", ["-S", screenName, "-p", "0", "-X", "stuff", "/reload\r"]);
	await waitFor("bye reload", () => byes.includes("reload"));
	states.delete(pid);
	await waitFor("snapshot after reload", () => states.get(pid));
	const state = current();
	assert.equal(state.phase, "idle");
	assert.equal(state.lastSaid, "echo: steered");
	assert.ok(state.lastSettledAt, "a session with history is waiting on the user, not fresh");
	const bash = state.tools.filter((run) => run.name === "bash");
	assert.deepEqual(bash.map((run) => run.detail), ["sleep 1", "sleep 1", "sleep 2", "sleep 30"], "tool runs are rebuilt from the transcript");
	assert.ok(bash.every((run) => run.endedAt !== undefined));
	assert.ok(bash.at(-1)?.isError, "the aborted run did not succeed");
	const timeline = state.timeline.map((entry) => entry.state);
	assert.equal(timeline[0], "idle", "the process started before the first prompt");
	assert.equal(timeline.at(-1), "waiting");
	assert.equal(timeline.filter((entry) => entry === "working").length, 6, "one run per prompt since the process started, the steer included");
});

test("provider errors surface as lastError", async () => {
	await hub.send(current(), { kind: "prompt", text: "fail" });
	await waitFor("error", () => current().phase === "idle" && current().lastError);
	assert.equal(current().lastError?.message, "scripted failure");
});

test("rename updates the session name", async () => {
	await hub.send(current(), { kind: "rename", name: "e2e session" });
	await waitFor("name", () => current().name === "e2e session");
});

test("model and thinking level can be switched; pi clamps the level to the model", async () => {
	await hub.send(current(), { kind: "model", provider: "dash-test", id: "scripted-thinking" });
	await waitFor("model", () => current().model === "dash-test/scripted-thinking");
	await hub.send(current(), { kind: "thinking", level: "high" });
	await waitFor("thinking", () => current().thinking === "high");
	await hub.send(current(), { kind: "model", provider: "dash-test", id: "scripted" });
	await waitFor("model back, thinking clamped", () => current().model === "dash-test/scripted" && current().thinking === "off");
	await assert.rejects(hub.send(current(), { kind: "model", provider: "dash-test", id: "missing" }), /unknown model dash-test\/missing/);
});

test("compact runs only while idle, reports failures, and compacts a long session", async () => {
	await hub.send(current(), { kind: "prompt", text: "sleep 2" });
	await waitFor("working", () => current().phase === "working");
	await assert.rejects(hub.send(current(), { kind: "compact" }), /session is working/);
	await waitFor("settled", () => current().phase === "idle" && current().lastSaid === "slept 2");

	await hub.send(current(), { kind: "compact" });
	await waitFor("compaction error", () => current().lastError);
	assert.match(current().lastError?.message ?? "", /^compaction failed: Nothing to compact/);

	// Without spaces the scripted model takes a long prompt in one step.
	for (const letter of ["a", "b", "c", "d"]) {
		const settled = current().lastSettledAt ?? 0;
		await hub.send(current(), { kind: "prompt", text: letter.repeat(60_000) });
		await waitFor("bulk turn", () => current().phase === "idle" && (current().lastSettledAt ?? 0) > settled);
	}
	const before = current().usage.direct.tokens;
	await hub.send(current(), { kind: "compact" });
	await waitFor("compacted, then idle", () => current().usage.direct.tokens > before && current().phase === "idle", 30_000);
	assert.equal(current().lastError, undefined, "the finished compaction clears the earlier failure");
});

test("an ask while idle sees the whole context (summary, tool output, system prompt, tools) and changes nothing", async () => {
	await hub.send(current(), { kind: "prompt", text: "shell echo marker-42" });
	await waitFor("settled", () => current().phase === "idle" && current().lastSaid === "tool finished");
	const before = { lines: sessionLines(), said: current().lastSaid, tokens: current().usage.direct.tokens };

	await hub.send(current(), { kind: "ask", question: "Where is the marker?" });
	assert.deepEqual([lastAsk()?.status, lastAsk()?.question], ["answering", "Where is the marker?"], "the question arrives before the ack");
	await waitFor("answered", () => lastAsk()?.status === "answered");
	const seen = JSON.parse(lastAsk()?.answer ?? "");
	assert.equal(seen.prompt, true, "the session's system prompt");
	assert.ok(seen.tools.includes("bash"), "the session's tools");
	assert.match(seen.first, /compacted into the following summary/, "the compaction summary of the earlier conversation");
	assert.match(seen.lastResult, /^marker-42\s*$/, "the tool's output");
	assert.match(seen.roles, /,user,assistant,toolResult,assistant,user$/);
	assert.match(seen.status, /^Session status: idle for \d+s, waiting for the user\.$/);
	assert.equal(seen.question, "Where is the marker?");
	assert.equal(lastAsk()?.usage?.tokens, 1100);

	assert.equal(sessionLines(), before.lines, "nothing is written to the session");
	assert.equal(current().lastSaid, before.said);
	assert.equal(current().usage.direct.tokens, before.tokens, "an ask is not session usage");
	assert.equal(current().phase, "idle");
});

test("an ask during a tool run sees the tool still running; one ask at a time", async () => {
	await hub.send(current(), { kind: "prompt", text: "sleep 4" });
	await waitFor("tool running", () => current().activity?.kind === "tool");
	await hub.send(current(), { kind: "ask", question: "What are you doing?" });
	await assert.rejects(hub.send(current(), { kind: "ask", question: "And now?" }), /still answering the previous question/);
	await waitFor("answered", () => lastAsk()?.status === "answered");
	const seen = JSON.parse(lastAsk()?.answer ?? "");
	assert.match(seen.lastResult, /^Still running \(started \d+s ago\)\. No output yet\.$/, "the unanswered call is answered as running, not failed");
	assert.match(seen.roles, /,user,assistant,toolResult,user$/);
	assert.match(seen.status, /^Session status: working for \d+s\.$/);
	await waitFor("settled", () => current().phase === "idle" && current().lastSaid === "slept 4");
	assert.deepEqual(
		current().asks.map((ask) => ask.question),
		["Where is the marker?", "What are you doing?"],
	);
});

test("an empty question is rejected, and a provider failure fails only the ask", async () => {
	await assert.rejects(hub.send(current(), { kind: "ask", question: "  " }), /question is empty/);
	await hub.send(current(), { kind: "ask", question: "fail" });
	await waitFor("failed", () => lastAsk()?.status === "failed");
	assert.equal(lastAsk()?.error, "scripted failure");
	assert.equal(current().lastError, undefined, "a failed ask is not a session error");
});

test("/new replaces the session: bye, then a fresh snapshot on the same pid", async () => {
	const before = current().sessionId;
	execFileSync("screen", ["-S", screenName, "-p", "0", "-X", "stuff", "/new\r"]);
	await waitFor("bye new", () => byes.includes("new"));
	await waitFor("new session snapshot", () => states.get(pid)?.sessionId !== before && hub.isConnected(pid));
	assert.equal(current().usage.direct.tokens, 0);
	assert.deepEqual(current().asks, [], "asks belong to the session they were asked in");
	assert.equal(current().plan?.title, "E2E plan", "plan is republished for the new session");
});

test("shutdown closes pi, removes the socket and ends its screen", async () => {
	await hub.send(current(), { kind: "shutdown" });
	await waitFor("bye quit", () => byes.includes("quit"));
	await waitFor("socket removed", () => !existsSync(join(sockets, `${pid}.sock`)));
	await waitFor("screen gone", () => {
		try {
			execFileSync("screen", ["-ls", screenName], { stdio: "ignore" });
			return false;
		} catch (error) {
			return !String((error as { stdout?: Buffer }).stdout ?? "").includes(screenName);
		}
	});
});
