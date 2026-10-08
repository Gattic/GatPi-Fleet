import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";

export const ConfigSchema = Type.Object({
	listen: Type.String({ minLength: 1, maxLength: 255 }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
	url: Type.String({ minLength: 1, maxLength: 500 }), label: Type.String({ minLength: 1, maxLength: 120 }),
	cert: Type.String(), key: Type.String(), devices: Type.String(), auditDir: Type.String(),
}, { additionalProperties: false });
export type ServerConfig = Static<typeof ConfigSchema>;
const validator = Schema.Compile(ConfigSchema);

export function loadConfig(path: string): ServerConfig {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!validator.Check(value)) throw new Error("Invalid gateway configuration");
	const url = new URL(value.url);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("url must be an HTTPS origin");
	for (const path of [value.cert, value.key, value.devices, value.auditDir]) if (!isAbsolute(path)) throw new Error("Configuration paths must be absolute");
	return value;
}
