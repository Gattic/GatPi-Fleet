// Real GNU Screen rendering through a private PTY/socket directory. No model/provider calls.
// Can also run against a remote installation: PI_DASH_TEST_REPO=/path/to/pi-dash node --test <this-file>.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = process.env.PI_DASH_TEST_REPO || fileURLToPath(new URL("../..", import.meta.url));
const { launchSession }: typeof import("../../src/manager/actions/launch.ts") = await import(pathToFileURL(join(repo, "src/manager/actions/launch.ts")).href);
const { screenConfig }: typeof import("../../src/manager/actions/screen-config.ts") = await import(pathToFileURL(join(repo, "src/manager/actions/screen-config.ts")).href);
const caption = "CAPTION-COLOR-CHECK";
const body = "BODY-COLOR-CHECK";
const prompt = "PROMPT-COLOR-CHECK";
const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

type Color = number | string | undefined;

/** Track SGR attributes at our markers, not merely the presence of a color escape somewhere. */
function markerColors(text: string): { marker: string; fg: Color; bg: Color; bold: boolean }[] {
	let fg: Color; let bg: Color; let bold = false;
	const found: { marker: string; fg: Color; bg: Color; bold: boolean }[] = [];
	for (const match of text.matchAll(/\x1b\[([0-9;]*)m|CAPTION-COLOR-CHECK|BODY-COLOR-CHECK|PROMPT-COLOR-CHECK/g)) {
		if (match[1] === undefined) { found.push({ marker: match[0], fg, bg, bold }); continue; }
		const codes = match[1] ? match[1].split(";").map(Number) : [0];
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 0) { fg = undefined; bg = undefined; bold = false; }
			else if (code === 1) bold = true;
			else if (code === 22) bold = false;
			else if (code === 39) fg = undefined;
			else if (code === 49) bg = undefined;
			else if (code >= 30 && code <= 37) fg = code - 30;
			else if (code >= 40 && code <= 47) bg = code - 40;
			else if (code >= 90 && code <= 97) fg = code - 90 + 8;
			else if (code >= 100 && code <= 107) bg = code - 100 + 8;
			else if (code === 38 || code === 48) {
				let color: Color;
				if (codes[i + 1] === 5) { color = codes[i + 2]; i += 2; }
				else if (codes[i + 1] === 2) { color = codes.slice(i + 2, i + 5).join(","); i += 4; }
				if (code === 38) fg = color; else bg = color;
			}
		}
	}
	return found;
}

function capture(name: string, env: NodeJS.ProcessEnv, expectPrompt: boolean): Promise<string> {
	return new Promise((resolve, reject) => {
		// script (util-linux) supplies a PTY; never attach to any pre-existing screen socket.
		const child = spawn("script", ["-qefc", `stty rows 24 cols 100; exec screen -r ${quote(name)}`, "/dev/null"], { env, stdio: "pipe" });
		let output = ""; let started = false; let detached = false; let failure: Error | undefined;
		const timer = setTimeout(() => { failure = new Error("screen color capture timed out"); child.kill("SIGTERM"); }, 8000);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > 1024 * 1024) { failure = new Error("screen capture exceeded 1 MiB"); child.kill("SIGTERM"); }
			// Release the fixture only after attachment: initial resize/clears can erase a one-shot card.
			if (!started && output.includes(caption)) { started = true; child.stdin.write("\n"); }
			if (!detached && output.includes(caption) && output.includes(body) && (!expectPrompt || output.includes(prompt))) {
				detached = true;
				child.stdin.write("\x01d");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stdin.on("error", (error) => { failure ??= error; });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (failure) reject(Object.assign(failure, { output }));
			else if (code !== 0) reject(new Error(`screen attach exited ${code}: ${JSON.stringify(output)}`));
			else resolve(output);
		});
	});
}

for (const mode of ["defaults", "override", "shell prompt"]) {
	const custom = mode === "override";
	const shell = mode === "shell prompt";
	test(`real Screen renders ${mode} in a single manager-created window`, { timeout: 20_000 }, async () => {
		// Exercise shell quoting as well as the launcher's argv handling of project paths.
		const root = mkdtempSync(join(tmpdir(), "pi-dash-screen-colors-quote'-"));
		const oldEnv = process.env;
		const env: NodeJS.ProcessEnv & { XDG_CONFIG_HOME: string; SCREENDIR: string } = { ...oldEnv, XDG_CONFIG_HOME: join(root, "config"), SCREENDIR: join(root, "screens"), PATH: `${join(root, "bin")}:${oldEnv.PATH}` };
		// Match a non-PTY SSH relay; terminal capabilities arrive only when attaching.
		for (const key of ["STY", "WINDOW", "TMUX", "TMUX_PANE", "TERM", "COLORTERM"]) delete env[key];
		process.env = env;
		let name: string | undefined; let passed = false;
		try {
			mkdirSync(env.SCREENDIR, { mode: 0o700 });
			mkdirSync(join(root, "bin"));
			// Match the Ubuntu/Mint prompt selector without sourcing user startup files or writing history.
			writeFileSync(join(root, "bashrc"), String.raw`
HISTFILE=/dev/null
case "$TERM" in
    xterm-color|*-256color) color_prompt=yes;;
esac
if [ "$color_prompt" = yes ]; then
    PS1='\[\033[01;32m\]\u@\h PROMPT-COLOR-CHECK\[\033[00m\]\$ '
else
    PS1='\u@\h PROMPT-COLOR-CHECK\$ '
fi
printf '\033[32mBODY-COLOR-CHECK\033[0m\n'
`);
			// Run a deterministic card or real Bash instead of Pi: no auth or provider calls.
			const command = shell ? `exec bash --noprofile --rcfile ${quote(join(root, "bashrc"))} -i` : `printf '\\033[32m${body}\\033[0m\\n'\nexec sleep 30`;
			writeFileSync(join(root, "bin", "pi"), `#!/bin/sh\nprintf '%s\\n' "$TERM" > ${quote(join(root, "term"))}\nread -r ready\n${command}\n`, { mode: 0o700 });
			const defaultConfig = screenConfig();
			if (custom) {
				const dir = join(env.XDG_CONFIG_HOME, "pi-dash"); mkdirSync(dir, { recursive: true });
				const colors = defaultConfig.path.endsWith("screenrc-4") ? "gW" : "15;2";
				writeFileSync(join(dir, "screenrc"), `source ${quote(join(repo, "config/screenrc"))}\ncaption always "%{=b ${colors}}${caption}%{-}"\n`);
			}
			name = launchSession({ cwd: root, label: caption }, [], join(root, "run"));
			const output = await capture(name, { ...env, TERM: "xterm-256color" }, shell);
			writeFileSync(join(root, "capture.ansi"), output);
			const colors = markerColors(output);
			assert.ok(colors.some((c) => c.marker === caption && c.bg === (custom ? 2 : 4) && (c.fg === 15 || (c.fg === 7 && c.bold))), JSON.stringify(colors));
			assert.ok(colors.some((c) => c.marker === body && c.fg === 2), JSON.stringify(colors));
			if (shell) assert.ok(colors.some((c) => c.marker === prompt && (c.fg === 10 || (c.fg === 2 && c.bold))), `Bash user@host prompt must be bright green (TERM=${readFileSync(join(root, "term"), "utf8").trim()}): ${JSON.stringify(colors)}`);
			assert.match(readFileSync(join(root, "term"), "utf8"), /^screen-256color\n$/, "shared defaults must preserve the terminal name used by Bash color detection");
			assert.doesNotMatch(output, /unknown command|invalid color|cannot open/i);
			assert.equal(readdirSync(env.SCREENDIR).length, 1);
			// Closing the only window must end the entire screen (no unwanted workspace windows).
			execFileSync("screen", ["-S", name, "-p", "0", "-X", "kill"], { env, stdio: "pipe", timeout: 2000 });
			const deadline = Date.now() + 2000;
			while (readdirSync(env.SCREENDIR).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
			assert.deepEqual(readdirSync(env.SCREENDIR), []);
			name = undefined;
			passed = true;
		} finally {
			if (name) {
				try { execFileSync("screen", ["-S", name, "-X", "quit"], { env, stdio: "ignore", timeout: 2000 }); }
				catch (error) { console.error("Owned test-screen cleanup failed", name, error); }
			}
			process.env = oldEnv;
			if (passed) rmSync(root, { recursive: true, force: true });
			else console.error(`Screen color evidence retained: ${root}`);
		}
	});
}
