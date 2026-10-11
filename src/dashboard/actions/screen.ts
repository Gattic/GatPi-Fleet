// Terminal-only GNU screen attach.
import { spawn } from "node:child_process";
import { sshTerminalCommand } from "../../manager/remote/hosts.ts";

/** Multi-display attach, over ssh for a session on a remote host; the original terminal remains attached. */
export function attachSession(sty: string, window: string | undefined, host?: string): Promise<void> {
	const env = { ...process.env };
	delete env.STY;
	const screen = ["screen", "-rx", sty, ...(window !== undefined ? ["-p", window] : [])];
	const [command, ...args] = host === undefined ? screen : sshTerminalCommand(host, screen);
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit", env });
		child.on("exit", () => resolve());
		child.on("error", () => resolve());
	});
}
