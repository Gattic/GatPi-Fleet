import assert from "node:assert/strict";
import { test } from "node:test";
import { SlashAutocompleteProvider } from "../src/dashboard/ui/slash.ts";
import type { SlashCommand } from "../src/protocol/index.ts";

const commands: SlashCommand[] = [
	{ name: "model", description: "Switch the session's model", argumentHint: "<provider/modelId>", source: "builtin" },
	{ name: "thinking", description: "Set the thinking level", argumentHint: "<level>", source: "builtin" },
	{ name: "compact", description: "Summarize the conversation so far", argumentHint: "[instructions]", source: "builtin" },
	{ name: "review", description: "Review the diff", source: "prompt" },
	{ name: "skill:commit", description: "Commit work", source: "skill" },
];
const models = ["anthropic/claude-sonnet", "openai/gpt-6.1"];
const provider = () => new SlashAutocompleteProvider(() => commands, () => models);
const options = { signal: new AbortController().signal };

function suggestions(line: string, col = line.length) {
	return provider().getSuggestions([line], 0, col, options);
}

test("a slash alone lists every command with its hint and description", async () => {
	const result = await suggestions("/");
	assert.ok(result);
	assert.equal(result.prefix, "/");
	assert.deepEqual(result.items.map((item) => item.value), commands.map((command) => command.name));
	assert.equal(result.items[0].description, "<provider/modelId> — Switch the session's model");
});

test("a prefix matches names and a skill's bare name", async () => {
	const result = await suggestions("/co");
	assert.deepEqual(result?.items.map((item) => item.value), ["compact", "skill:commit"], "prefix matches come before the rest");
	const skill = await suggestions("/comm");
	assert.deepEqual(skill?.items.map((item) => item.value), ["skill:commit"]);
});

test("a subsequence finds a skill inside its bare name", async () => {
	const result = await suggestions("/mit");
	assert.deepEqual(result?.items.map((item) => item.value), ["skill:commit"]);
});

test("arguments complete for the built-ins whose choices the session publishes", async () => {
	const model = await suggestions("/model claude");
	assert.equal(model?.prefix, "claude");
	assert.deepEqual(model?.items.map((item) => item.value), ["anthropic/claude-sonnet"]);
	const thinking = await suggestions("/thinking h");
	assert.deepEqual(thinking?.items.map((item) => item.value), ["high", "xhigh"], "levels containing the prefix are offered");
	const noChoices = await suggestions("/review API");
	assert.equal(noChoices, null);
});

test("text that is not a slash command, and arguments with no choices, get no menu", async () => {
	assert.equal(await suggestions("fix the tests"), null);
	const emptyPrefix = await suggestions("/model ");
	assert.deepEqual(emptyPrefix?.items.map((item) => item.value), models, "a bare /model offers every model");
	assert.equal(await suggestions("/skill:commit now"), null);
});

test("choosing a command completes its name and leaves a space for arguments", () => {
	const completed = provider().applyCompletion(["  /rev"], 0, 6, { value: "review", label: "review" }, "/rev");
	assert.deepEqual(completed, { lines: ["  /review "], cursorLine: 0, cursorCol: 10 });
});

test("choosing an argument completes the argument without adding a slash", () => {
	const completed = provider().applyCompletion(["/model claude"], 0, 13, { value: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet" }, "claude");
	assert.deepEqual(completed, { lines: ["/model anthropic/claude-sonnet"], cursorLine: 0, cursorCol: 30 });
});
