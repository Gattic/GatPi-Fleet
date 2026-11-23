// Command menu overlay for a selected session.
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import { fit } from "./format.ts";
import { frame } from "./overlays.ts";
import { keyHints, theme } from "./theme.ts";

/** Session commands in groups: key, name, what it does. Each key is also the command's shortcut outside the menu. */
const COMMANDS: [key: string, name: string, detail: string][][] = [
	[
		["x", "abort", "stop the current run"],
		["s", "said", "read the latest reply full screen"],
		["Z", "compact", "summarize the conversation so far · when idle"],
		["M", "model", "switch model"],
		["T", "thinking", "switch thinking level"],
		["R", "rename", "rename the session"],
		["a", "attach", "open its screen here · Ctrl-a d returns"],
	],
	[
		["L", "reload", "reload extensions, skills and prompts · when idle"],
		["N", "new conversation", "fresh context, like /new · when idle"],
		["S", "restart", "resume this conversation in a new pi · when idle"],
		["c", "close", "close pi gracefully"],
		["C", "recycle", "close, then start a fresh session in its project"],
		["r", "resume", "resume once exited, or pick a saved conversation"],
		["d", "dismiss", "remove the row once exited"],
	],
];

const KEY_COLUMN = 3;
const NAME_COLUMN = 18;

export interface SessionMenuOptions {
	title: string;
	/** The session's state right now; undefined once it ended or another session replaced it. */
	state: () => string | undefined;
	onCommand: (key: string) => void;
	onClose: () => void;
}

/** The selected session's commands; choosing one leaves the menu and runs it. */
export class SessionMenu implements Component {
	private readonly options: SessionMenuOptions;

	constructor(options: SessionMenuOptions) {
		this.options = options;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "m") return this.options.onClose();
		if (COMMANDS.some((group) => group.some(([key]) => key === data))) this.options.onCommand(data);
	}

	render(width: number): string[] {
		const body = [this.options.state() ?? theme.error("✖ session ended or was replaced; select its current instance")];
		for (const group of COMMANDS) {
			body.push("");
			for (const [key, name, detail] of group) body.push(`${fit(theme.bold(theme.accent(key)), KEY_COLUMN)}${fit(theme.text(name), NAME_COLUMN)}${theme.dim(detail)}`);
		}
		return frame(this.options.title, body, width, keyHints([["Esc", "close"]]));
	}
}
