import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchSession } from "../src/manager/actions/launch.ts";

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
	writeFileSync(join(bin, "screen"), `#!/bin/sh\nshift 6\nrmdir '${cwd}'\n( "$@"; touch '${done}' ) </dev/null >/dev/null 2>&1 &\nexit 0\n`, { mode: 0o700 });
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
	writeFileSync(join(bin, "screen"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PI_TEST_SCREEN_ARGUMENTS"\n', { mode: 0o700 });
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

test("a failed screen launch releases its reservation and reports screen's reason on one line", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-launch-fail-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// What a setgid screen prints, on stdout, when it runs without that privilege; other reasons come on stderr.
	writeFileSync(join(root, "screen"), "#!/bin/sh\necho \"Directory '/run/screen' must have mode 777.\"\necho 'Second line.' >&2\nexit 1\n", { mode: 0o700 });
	const path = process.env.PATH; process.env.PATH = root;
	t.after(() => { process.env.PATH = path; });
	const file = join(root, "session.jsonl"); writeFileSync(file, "");
	assert.throws(() => launchSession({ cwd: root, label: "test", sessionFile: file }, [], root), { message: "screen could not start pi: Directory '/run/screen' must have mode 777. Second line." });
	assert.deepEqual(readdirSync(join(root, "launches")), []);
});
