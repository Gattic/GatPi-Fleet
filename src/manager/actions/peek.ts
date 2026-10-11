// Read-only peeks at a GNU screen window: a hardcopy written by screen, read on the next refresh.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

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
