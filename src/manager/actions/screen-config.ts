import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve on the launch host, not the dashboard host. Overrides contain settings, not windows. */
export function screenConfig(env: NodeJS.ProcessEnv = process.env): { path: string; env: NodeJS.ProcessEnv } {
	const custom = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "pi-dash", "screenrc");
	if (lstatSync(custom, { throwIfNoEntry: false })) {
		// A broken or unreadable override must not silently select different settings.
		if (!statSync(custom).isFile()) throw new Error(`${custom}: expected a Screen configuration file`);
		accessSync(custom, constants.R_OK);
		return { path: custom, env: { ...env } };
	}
	const version = execFileSync("screen", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, env }).trim();
	const major = /^Screen version ([45])\./.exec(version)?.[1];
	if (!major) throw new Error(`Unsupported GNU Screen version (expected 4.x or 5.x): ${version}`);
	return {
		path: fileURLToPath(new URL(`../../../config/screenrc-${major}`, import.meta.url)),
		// Screen 5 builds can abort in findrcfile on relative includes; use an absolute source.
		env: { ...env, PI_DASH_SCREENRC_COMMON: fileURLToPath(new URL("../../../config/screenrc", import.meta.url)) },
	};
}
