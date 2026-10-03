// Test-only pi extension: registers a local scripted model so end-to-end tests
// can drive a real interactive pi without network access or API cost.
//
// Prompt scripts (last user message):
//   "sleep N"  -> calls the bash tool with `sleep N`, then replies "slept N"
//   "fail"     -> ends with stopReason "error"
//   anything   -> streams "echo: <prompt>" over ~0.6 s
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
	}
	return "";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		});
	});
}

function streamScripted(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	(async () => {
		try {
			stream.push({ type: "start", partial: output });
			output.usage.input = 1000;
			output.usage.output = 100;
			output.usage.totalTokens = 1100;
			calculateCost(model, output.usage);
			const last = context.messages.at(-1);
			const prompt = lastUserText(context).trim();
			const sleep = /^sleep (\d+(?:\.\d+)?)$/.exec(prompt);
			if (last?.role === "toolResult") {
				await emitText(sleep ? `slept ${sleep[1]}` : "tool finished");
			} else if (sleep) {
				output.content.push({ type: "toolCall", id: `call_${Date.now()}`, name: "bash", arguments: { command: `sleep ${sleep[1]}` } });
				const index = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				const toolCall = output.content[index];
				if (toolCall.type !== "toolCall") throw new Error("unreachable");
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
				output.stopReason = "toolUse";
			} else if (prompt === "fail") {
				throw new Error("scripted failure");
			} else {
				await emitText(`echo: ${prompt}`);
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	async function emitText(text: string): Promise<void> {
		output.content.push({ type: "text", text: "" });
		const index = output.content.length - 1;
		stream.push({ type: "text_start", contentIndex: index, partial: output });
		for (const word of text.split(/(?<= )/)) {
			await delay(150, options?.signal);
			const block = output.content[index];
			if (block.type === "text") block.text += word;
			stream.push({ type: "text_delta", contentIndex: index, delta: word, partial: output });
		}
		const block = output.content[index];
		stream.push({ type: "text_end", contentIndex: index, content: block.type === "text" ? block.text : "", partial: output });
	}

	return stream;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
	pi.registerProvider("dash-test", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-key",
		api: "dash-test-api",
		models: [
			{
				id: "scripted",
				name: "Scripted test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8192,
			},
		],
		streamSimple: streamScripted,
	});
}
