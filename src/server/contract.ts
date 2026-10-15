// Authoritative API v1 input schemas. Exportable JSON Schema; shared fixtures test Android decoding.
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import { THINKING_LEVELS } from "../protocol/index.ts";

export const API_VERSION = 1;
export const MAX_BODY = 128 * 1024;
export const MAX_FRAME = 1024 * 1024;
/** Characters in a prompt command. */
export const MAX_PROMPT = 32_000;
const text = (max: number) => Type.String({ minLength: 1, maxLength: max, pattern: "\\S" });
const object = <P extends Type.TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
export const Reference = Type.String({ pattern: "^[a-f0-9]{32}$" });
export const RequestId = Type.String({ pattern: "^[a-f0-9-]{36}$" });
export const CommandSchema = Type.Union([
	object({ kind: Type.Literal("prompt"), text: text(MAX_PROMPT), deliverAs: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])) }),
	object({ kind: Type.Literal("ask"), question: text(4000) }),
	object({ kind: Type.Literal("rename"), name: text(120) }),
	object({ kind: Type.Literal("model"), provider: text(200), id: text(300) }),
	object({ kind: Type.Literal("thinking"), level: Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level))) }),
	object({ kind: Type.Literal("abort") }), object({ kind: Type.Literal("shutdown") }), object({ kind: Type.Literal("compact") }),
	// Removes an exited session's row; the managers act on it, not the bridge.
	object({ kind: Type.Literal("dismiss") }),
]);
export const CommandRequestSchema = object({ requestId: RequestId, epoch: RequestId, revision: Reference, command: CommandSchema });
export const LaunchRequestSchema = object({ requestId: RequestId, epoch: RequestId, projectId: Reference, sessionRef: Type.Optional(Reference) });
export const GitRequestSchema = object({ requestId: RequestId, epoch: RequestId, revision: Reference, action: Type.Union([
	object({ kind: Type.Literal("pull") }), object({ kind: Type.Literal("push") }),
	object({ kind: Type.Literal("switch"), branch: text(300) }),
]) });
export type GitRequest = Static<typeof GitRequestSchema>;
export const gitRequest = Schema.Compile(GitRequestSchema);
export const SubscriptionSchema = object({ type: Type.Literal("subscribe"), sessionId: Type.Union([Reference, Type.Null()]) });
export type CommandRequest = Static<typeof CommandRequestSchema>;
export type LaunchRequest = Static<typeof LaunchRequestSchema>;
export const commandRequest = Schema.Compile(CommandRequestSchema);
export const launchRequest = Schema.Compile(LaunchRequestSchema);
export const subscription = Schema.Compile(SubscriptionSchema);

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}

export function parseJson(text: string): unknown {
	try { return JSON.parse(text); } catch { throw new ApiError(400, "Invalid JSON"); }
}
