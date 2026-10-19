import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { screenConfig } from "../src/manager/actions/screen-config.ts";
import { launchSession } from "../src/manager/actions/launch.ts";

function fixture(t: TestContext, version = "Screen version 4.09.01 (GNU) 20-Aug-23") {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-screen-config-"));
	const bin = join(root, "bin"); mkdirSync(bin);
	const calls = join(root, "calls");
	writeFileSync(join(bin, "screen"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$SCREEN_TEST_CALLS"\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; fi\n`, { mode: 0o700 });
	const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), PATH: bin, SCREEN_TEST_CALLS: calls };
	const previous = process.env;
	process.env = env;
	t.after(() => { process.env = previous; rmSync(root, { recursive: true, force: true }); });
	return { root, env, calls };
}

for (const [version, major] of [["Screen version 4.09.01 (GNU) 20-Aug-23", "4"], ["Screen version 5.0.1 (build on 2026-01-05 00:01:00)", "5"]]) {
	test(`launch uses the Screen ${major} defaults and creates only the requested window`, (t) => {
		const { root, calls } = fixture(t, version);
		launchSession({ cwd: root, label: "color test" }, [], root);
		const args = readFileSync(calls, "utf8").trim().split("\n");
		assert.equal(args[0], "--version");
		assert.equal(args[1], "-c");
		assert.ok(args[2].endsWith(`/config/screenrc-${major}`));
		assert.equal(args[3], "-dmS");
		const style = readFileSync(args[2], "utf8");
		const common = readFileSync(join(args[2], "..", "screenrc"), "utf8");
		assert.match(style, /^source "\$PI_DASH_SCREENRC_COMMON"$/m);
		assert.match(style, /^caption always /m);
		assert.match(style, /^hardstatus alwayslastline /m);
		assert.doesNotMatch(`${style}\n${common}`, /^(screen|chdir|select)\s/m);
		if (major === "4") {
			assert.match(style, /%\{=b bW\}/);
			assert.doesNotMatch(`${style}\n${common}`, /^truecolor\b|%\{[^}]*;/m);
		} else {
			assert.match(style, /%\{=b 15;4\}/);
			assert.match(style, /^truecolor on$/m);
		}
	});
}

for (const useXdg of [true, false]) {
	test(`host-local override wins (${useXdg ? "XDG_CONFIG_HOME" : "HOME/.config"}), without version probing`, (t) => {
		const { root, env, calls } = fixture(t, "not a known version");
		if (!useXdg) delete process.env.XDG_CONFIG_HOME;
		const custom = join(useXdg ? env.XDG_CONFIG_HOME : join(root, ".config"), "pi-dash", "screenrc");
		mkdirSync(join(custom, ".."), { recursive: true });
		const settings = "term screen-256color\nvbell off\n";
		writeFileSync(custom, settings);
		// Neither legacy file is selected or sourced, including their extra windows.
		writeFileSync(join(root, ".screenrc-empty"), "screen -t Unwanted\n");
		writeFileSync(join(root, ".screenrc"), "screen -t AlsoUnwanted\n");
		launchSession({ cwd: root, label: "custom" }, [], root);
		const args = readFileSync(calls, "utf8").trim().split("\n");
		assert.deepEqual(args.slice(0, 3), ["-c", custom, "-dmS"]);
		assert.equal(readFileSync(custom, "utf8"), settings);
	});
}

test("a legacy screenrc alone does not override the compatible defaults", (t) => {
	const { root } = fixture(t);
	writeFileSync(join(root, ".screenrc-empty"), "screen -t Unwanted\n");
	writeFileSync(join(root, ".screenrc"), "screen -t AlsoUnwanted\n");
	assert.ok(screenConfig().path.endsWith("/config/screenrc-4"));
});

for (const kind of ["directory", "broken symlink", "unreadable file"]) {
	test(`a ${kind} override fails before launch/reservation rather than falling back`, (t) => {
		const { root, env, calls } = fixture(t);
		const custom = join(env.XDG_CONFIG_HOME, "pi-dash", "screenrc");
		mkdirSync(join(custom, ".."), { recursive: true });
		if (kind === "directory") mkdirSync(custom);
		else if (kind === "broken symlink") symlinkSync(join(root, "missing"), custom);
		else { writeFileSync(custom, "vbell off\n"); chmodSync(custom, 0); }
		const session = join(root, "session.jsonl"); writeFileSync(session, "");
		assert.throws(() => launchSession({ cwd: root, label: "bad-config", sessionFile: session }, [], root), /expected a Screen configuration file|ENOENT|EACCES/);
		assert.equal(existsSync(calls), false);
		assert.equal(existsSync(join(root, "launches")), false);
	});
}

test("an unsupported version fails before creating a launch reservation", (t) => {
	const { root, calls } = fixture(t, "unrecognized version");
	const session = join(root, "session.jsonl"); writeFileSync(session, "");
	assert.throws(() => launchSession({ cwd: root, label: "bad-version", sessionFile: session }, [], root), /Unsupported GNU Screen version/);
	assert.equal(readFileSync(calls, "utf8"), "--version\n");
	assert.equal(existsSync(join(root, "launches")), false);
});
