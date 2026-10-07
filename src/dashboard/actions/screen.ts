// Terminal-only GNU screen attach and read-only peeks.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** Multi-display attach; the original terminal remains attached. */
export function attachSession(sty: string, window: string | undefined): Promise<void> {
	const env = { ...process.env };
	delete env.STY;
	const args = ["-rx", sty, ...(window !== undefined ? ["-p", window] : [])];
	return new Promise((resolve) => {
		const child = spawn("screen", args, { stdio: "inherit", env });
		child.on("exit", () => resolve());
		child.on("error", () => resolve());
	});
}

export function requestHardcopy(sty: string, window: string | undefined, file: string): void {
	execFile("screen", ["-S", sty, ...(window !== undefined ? ["-p", window] : []), "-X", "hardcopy", file], () => {});
}

export function readHardcopy(file: string): string[] | undefined {
	try {
		const lines = readFileSync(file, "utf8").split("\n");
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
		return lines;
	} catch { return undefined; }
}
