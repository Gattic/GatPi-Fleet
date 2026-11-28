// Slash commands a dashboard or phone prompt can run in a session: Pi's extension commands,
// prompt templates and skills, plus the Pi built-ins pi-dash can execute remotely.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type SlashCommand,
	MAX_SLASH_COMMANDS,
	SLASH_COMMAND_TEXT_LIMIT,
} from "../protocol/index.ts";

/**
 * Pi built-ins with a remote equivalent. The rest open interactive dialogs and need desktop pi;
 * they are named in DESKTOP_ONLY so a typed command fails with a useful reason instead of
 * reaching the model as literal text.
 */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: "model", description: "Switch the session's model", argumentHint: "<provider/modelId>", source: "builtin" },
	{ name: "thinking", description: "Set the thinking level", argumentHint: "<level>", source: "builtin" },
	{ name: "compact", description: "Summarize the conversation so far", argumentHint: "[instructions]", source: "builtin" },
	{ name: "new", description: "Start a fresh conversation in the same project", source: "builtin" },
	{ name: "clear", description: "Start a fresh conversation (alias for /new)", source: "builtin" },
	{ name: "reload", description: "Reload extensions, skills, prompts and themes", source: "builtin" },
	{ name: "name", description: "Set the session display name", argumentHint: "<name>", source: "builtin" },
	{ name: "quit", description: "Close pi gracefully", source: "builtin" },
	{ name: "exit", description: "Close pi gracefully (alias for /quit)", source: "builtin" },
];

/** Built-ins that only exist in desktop pi's interactive UI. */
export const DESKTOP_ONLY_SLASH_COMMANDS: ReadonlySet<string> = new Set([
	"settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy", "session",
	"changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "resume", "mcp",
]);

function bound(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const line = text.replace(/\s+/g, " ").trim();
	return line ? (line.length > SLASH_COMMAND_TEXT_LIMIT ? `${line.slice(0, SLASH_COMMAND_TEXT_LIMIT - 1)}…` : line) : undefined;
}

/** The commands a prompt can run, built-ins first, then Pi's resources in Pi's own order. */
export function publishedSlashCommands(pi: ExtensionAPI): SlashCommand[] {
	const resources: SlashCommand[] = pi
		.getCommands()
		// Names are the invokable identity, so a name that cannot be represented whole is left out.
		.filter((command) => command.name.length > 0 && command.name.length <= SLASH_COMMAND_TEXT_LIMIT && !/\s/.test(command.name) && !command.name.startsWith("pi-dash-"))
		.map((command) => ({
			name: command.name,
			description: bound(command.description),
			source: command.source,
		}));
	return [...BUILTIN_SLASH_COMMANDS, ...resources].slice(0, MAX_SLASH_COMMANDS);
}

/** A slash command's name and argument text; undefined when the text has no name. */
export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	return { name: match[1], args: (match[2] ?? "").trim() };
}
