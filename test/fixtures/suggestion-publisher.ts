// Test-only extension standing in for the GatPi-Harness prompt suggestions: publishes
// a next-prompt suggestion when the agent settles and withdraws it while it works.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function suggestionPublisher(pi: ExtensionAPI): void {
	pi.on("agent_start", () => pi.events.emit("prompt-suggestion:changed", null));
	pi.on("agent_settled", () => pi.events.emit("prompt-suggestion:changed", "Run the tests next"));
}
