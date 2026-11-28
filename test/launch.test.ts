import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { launchReservation, launchSession } from "../src/manager/actions/launch.ts";
import { processIdentity } from "../src/manager/recovery.ts";

const screenVersion = 'if [ "$1" = "--version" ]; then echo "Screen version 4.09.01 (GNU)"; exit 0; fi\n';

let config: string;
let previousConfig: string | undefined;
beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "pi-dash-launch-config-"));
	previousConfig = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = config;
});
afterEach(() => {
	if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = previousConfig;
	rmSync(config, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("launch fixture timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("a failed reservation write releases only the reservation this attempt created", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-reservation-write-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const write = fs.writeFileSync;
	t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
		if (typeof args[0] === "number") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
		return write(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	assert.throws(() => launchSession({ cwd: root, label: "test", sessionFile: file }, [], root), /disk full/);
	assert.deepEqual(readdirSync(join(root, "launches")), []);
});

test("a detached launch whose project disappears still releases its reservation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-cwd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project"); mkdirSync(cwd);
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const done = join(root, "done");
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), `#!/bin/sh\n${screenVersion}shift 6\nrmdir '${cwd}'\n( "$@"; touch '${done}' ) </dev/null >/dev/null 2>&1 &\nexit 0\n`, { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; });
	launchSession({ cwd, label: "test", sessionFile: file }, [], root);
	await until(() => fs.existsSync(done));
	assert.deepEqual(readdirSync(join(root, "launches")), []);
});

test("launch reservations exclude another controller, including session symlink aliases", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"); mkdirSync(bin);
	const record = join(root, "arguments");
	writeFileSync(join(bin, "screen"), '#!/bin/sh\n' + screenVersion + 'if [ "$1" = "-ls" ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$PI_TEST_SCREEN_ARGUMENTS"\n', { mode: 0o700 });
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`; process.env.PI_TEST_SCREEN_ARGUMENTS = record;
	t.after(() => { process.env.PATH = path; delete process.env.PI_TEST_SCREEN_ARGUMENTS; });
	const file = join(root, "session;not-shell.jsonl"); writeFileSync(file, "");
	const alias = join(root, "alias.jsonl"); symlinkSync(file, alias);
	const runtime = join(root, "runtime");
	const options = { cwd: root, label: "project; not a shell", sessionFile: file };
	const name = launchSession(options, [], runtime);
	assert.match(name, /^pi-project-not-a-shell-/);
	assert.throws(() => launchSession({ ...options, sessionFile: alias }, [], runtime), /launch is reserved/);
	const args = readFileSync(record, "utf8").split("\n");
	assert.equal(args.at(-2), file);
	const reservations = readdirSync(join(runtime, "launches"));
	assert.equal(reservations.length, 1);
	const reservation = join(runtime, "launches", reservations[0]);
	assert.equal(JSON.parse(readFileSync(reservation, "utf8")).screen, name);
	const stale = JSON.stringify({ screen: "missing-screen", at: 0 });
	writeFileSync(reservation, stale);
	assert.throws(() => launchSession(options, [], runtime), /Inspect .* before removing a stale reservation/);
	assert.equal(readFileSync(reservation, "utf8"), stale, "neither age nor an absent screen is authority to steal a reservation");
});

function launches(root: string): string {
	const dir = join(root, "launches");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** A PID whose recorded process identity is provably gone, as an abruptly killed screen server leaves it. */
async function deadWitness(): Promise<{ pid: number; identity: string }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	let identity: string | undefined | null;
	const deadline = Date.now() + 3000;
	while (typeof identity !== "string" && Date.now() < deadline) {
		identity = processIdentity(child.pid!);
		if (typeof identity !== "string") await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(typeof identity, "string", "the fixture needs a real process identity");
	child.kill("SIGKILL");
	await once(child, "exit");
	return { pid: child.pid!, identity: identity as string };
}

test("a reservation whose recorded screen owner is provably gone is reclaimed", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-owner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), `#!/bin/sh\n${screenVersion}exit 0\n`, { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; });
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const runtime = join(root, "runtime");
	const reservation = launchReservation(file, runtime);
	launches(runtime);
	writeFileSync(reservation, JSON.stringify({ screen: "pi-gone-00000000", at: Date.now() - 60_000, owner: await deadWitness() }));
	const name = launchSession({ cwd: root, label: "test", sessionFile: file }, [], runtime);
	assert.match(name, /^pi-test-/);
	assert.equal(JSON.parse(readFileSync(reservation, "utf8")).screen, name, "the reclaiming launch owns the reservation");
});

test("a launch in flight is not reclaimed by age or by an absent screen", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-inflight-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), `#!/bin/sh\n${screenVersion}exit 0\n`, { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; });
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const runtime = join(root, "runtime");
	const reservation = launchReservation(file, runtime);
	launches(runtime);
	// This process is the controller: it could still be between claiming and starting screen.
	const claim = JSON.stringify({ screen: "pi-pending-00000000", at: 0, controller: { pid: process.pid, identity: processIdentity(process.pid) } });
	writeFileSync(reservation, claim);
	assert.throws(() => launchSession({ cwd: root, label: "test", sessionFile: file }, [], runtime), /launch is reserved/);
	assert.equal(readFileSync(reservation, "utf8"), claim);
});

test("a claim left by a controller that died before starting screen is reclaimed", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-controller-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), `#!/bin/sh\n${screenVersion}exit 0\n`, { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; });
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const runtime = join(root, "runtime");
	const reservation = launchReservation(file, runtime);
	launches(runtime);
	writeFileSync(reservation, JSON.stringify({ screen: "pi-gone-11111111", at: Date.now() - 60_000, controller: await deadWitness() }));
	const name = launchSession({ cwd: root, label: "test", sessionFile: file }, [], runtime);
	assert.equal(JSON.parse(readFileSync(reservation, "utf8")).screen, name);
});

test("a claim replaced after it was judged stale is restored, not deleted", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-race-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"); mkdirSync(bin);
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const runtime = join(root, "runtime");
	const reservation = launchReservation(file, runtime);
	launches(runtime);
	const fresh = JSON.stringify({ screen: "pi-fresh-00000000", at: Date.now(), controller: { pid: process.pid, identity: processIdentity(process.pid) } });
	const freshFile = join(root, "fresh"); writeFileSync(freshFile, fresh);
	// A concurrent launch replaces the claim between judging it and moving it aside: `screen -ls`
	// runs inside that window, so the fixture does the replacing there.
	writeFileSync(join(bin, "screen"), `#!/bin/sh\n${screenVersion}if [ "$1" = "-ls" ]; then cp "$PI_TEST_FRESH" "$PI_TEST_RESERVATION"; fi\nexit 0\n`, { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
	process.env.PI_TEST_FRESH = freshFile; process.env.PI_TEST_RESERVATION = reservation;
	t.after(() => { process.env.PATH = path; delete process.env.PI_TEST_FRESH; delete process.env.PI_TEST_RESERVATION; });
	writeFileSync(reservation, JSON.stringify({ screen: "pi-gone-22222222", at: Date.now() - 60_000, owner: await deadWitness() }));
	assert.throws(() => launchSession({ cwd: root, label: "test", sessionFile: file }, [], runtime), /launch is reserved/);
	assert.equal(readFileSync(reservation, "utf8"), fresh, "the claim another launch created survives");
	assert.deepEqual(readdirSync(join(runtime, "launches")), [basename(reservation)], "the reclaim leaves no moved copy behind");
});

test("a claim without a recorded identity, or one that is unreadable, stays reserved", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-unknown-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), `#!/bin/sh\n${screenVersion}exit 0\n`, { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; });
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	const runtime = join(root, "runtime");
	const reservation = launchReservation(file, runtime);
	launches(runtime);
	const options = { cwd: root, label: "test", sessionFile: file };
	const unknown = JSON.stringify({ screen: "pi-unknown-00000000", at: 0, owner: { pid: 1 } });
	writeFileSync(reservation, unknown);
	assert.throws(() => launchSession(options, [], runtime), /Inspect .* before removing a stale reservation/);
	assert.equal(readFileSync(reservation, "utf8"), unknown, "an unavailable identity is not proof of death");
	writeFileSync(reservation, "not a claim");
	assert.throws(() => launchSession(options, [], runtime), /launch is reserved/);
});

test("a failed screen launch releases its reservation and reports screen's reason on one line", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-fail-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// What a setgid screen prints, on stdout, when it runs without that privilege; other reasons come on stderr.
	writeFileSync(join(root, "screen"), "#!/bin/sh\n" + screenVersion + "echo \"Directory '/run/screen' must have mode 777.\"\necho 'Second line.' >&2\nexit 1\n", { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = root;
	t.after(() => { process.env.PATH = path; });
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	assert.throws(() => launchSession({ cwd: root, label: "test", sessionFile: file }, [], root), { message: "screen could not start pi: Directory '/run/screen' must have mode 777. Second line." });
	assert.deepEqual(readdirSync(join(root, "launches")), []);
});
