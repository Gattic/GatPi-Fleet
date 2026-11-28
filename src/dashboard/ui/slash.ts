// Slash-command autocomplete for the prompt composer. Commands are the session's published list,
// so the menu matches what the bridge will actually run; arguments complete for the built-ins
// whose choices the bridge already publishes.
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { type SlashCommand, THINKING_LEVELS } from "../../protocol/index.ts";

const MAX_SUGGESTIONS = 50;

function item(command: SlashCommand): AutocompleteItem {
	const description = command.argumentHint
		? command.description ? `${command.argumentHint} — ${command.description}` : command.argumentHint
		: command.description;
	return { value: command.name, label: command.name, ...(description ? { description } : {}) };
}

/** Arguments for /model from the session's models, and /thinking from Pi's levels. */
function argumentCompletions(name: string, prefix: string, models: readonly string[]): AutocompleteItem[] | null {
	const choices = name === "model" ? models : name === "thinking" ? THINKING_LEVELS : [];
	if (!choices.length) return null;
	const items = choices
		.filter((choice) => choice.toLowerCase().includes(prefix.toLowerCase()))
		.map((choice) => ({ value: choice, label: choice }));
	return items.length ? items : null;
}

/** Only slash commands: paths are not completed, since a remote session's files are not here. */
export class SlashAutocompleteProvider implements AutocompleteProvider {
	private readonly commands: () => readonly SlashCommand[];
	private readonly models: () => readonly string[];

	constructor(commands: () => readonly SlashCommand[], models: () => readonly string[]) {
		this.commands = commands;
		this.models = models;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const text = before.trimStart();
		if (!text.startsWith("/")) return null;
		const space = text.indexOf(" ");
		if (space === -1) {
			const prefix = text.slice(1);
			const all = this.commands().map(item);
			const bare = fuzzyFilter(all, prefix, (entry) => (entry.value.startsWith("skill:") ? entry.value.slice("skill:".length) : entry.value));
			const bareValues = new Set(bare.map((entry) => entry.value));
			const full = fuzzyFilter(all.filter((entry) => entry.value.startsWith("skill:") && !bareValues.has(entry.value)), prefix, (entry) => entry.value);
			const items = [...bare, ...full].slice(0, MAX_SUGGESTIONS);
			return items.length ? { items, prefix: text } : null;
		}
		const name = text.slice(1, space);
		const items = argumentCompletions(name, text.slice(space + 1), this.models());
		return items ? { items, prefix: text.slice(space + 1) } : null;
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		const line = lines[cursorLine] ?? "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);
		const afterCursor = line.slice(cursorCol);
		const isName = prefix.startsWith("/") && beforePrefix.trim() === "";
		const value = isName ? `/${item.value} ` : item.value;
		const next = [...lines];
		next[cursorLine] = `${beforePrefix}${value}${afterCursor}`;
		return { lines: next, cursorLine, cursorCol: beforePrefix.length + value.length };
	}
}
