import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchSession } from "../src/manager/actions/launch.ts";

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
	assert.equal(JSON.parse(readFileSync(join(runtime, "launches", reservations[0]), "utf8")).screen, name);
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
