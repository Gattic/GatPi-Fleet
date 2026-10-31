// A real bridge/process for SIGKILL testing, without providers or an interactive terminal.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piDashBridge from "../../src/bridge/index.ts";

const root = process.argv[2];
const sessionFile = join(root, "conversation.jsonl");
writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "recover-me", cwd: root })}\n`);
const handlers = new Map<string, (event: unknown, ctx?: ExtensionContext) => void>();
const pi = {
	on: (name: string, handler: (event: unknown, ctx?: ExtensionContext) => void) => handlers.set(name, handler),
	events: { on: () => {} },
	registerCommand: () => {},
	getSessionName: () => "Crash fixture",
} as unknown as ExtensionAPI;
const context = {
	mode: "tui", cwd: root, isIdle: () => true, scopedModels: [],
	modelRegistry: { getAvailable: () => [] }, getContextUsage: () => undefined,
	sessionManager: { getEntries: () => [], getSessionId: () => "recover-me", getSessionFile: () => sessionFile },
} as unknown as ExtensionContext;
piDashBridge(pi);
handlers.get("session_start")!({}, context);
process.on("message", (message) => {
	handlers.get("session_shutdown")!({ reason: message === "reload" ? "reload" : "quit" });
	if (message === "reload") process.send!("reloading");
	else process.exit(0);
});
process.send!("ready");
