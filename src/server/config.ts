import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";

export const ConfigSchema = Type.Object({
	// Local addresses to serve, e.g. the LAN and the VPN address. The phone gets every URL and uses the one it reaches.
	listen: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { minItems: 1, maxItems: 8 }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
	urls: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 8 }), label: Type.String({ minLength: 1, maxLength: 120 }),
	cert: Type.String(), key: Type.String(), devices: Type.String(), auditDir: Type.String(),
}, { additionalProperties: false });
export type ServerConfig = Static<typeof ConfigSchema>;
const validator = Schema.Compile(ConfigSchema);

/**
 * One spelling per IP address, to compare them: IPv6 compressed and lowercase, as in a URL, and an IPv4-mapped IPv6
 * address as IPv4 (listening on ::ffff:127.0.0.1 is listening on 127.0.0.1). A zone (`%wlo1`) is kept.
 */
function canonicalAddress(address: string): string {
	const [ip, zone] = address.split("%");
	if (isIP(ip) === 4) return zone === undefined ? ip : `${ip}%${zone}`;
	const host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	const canonical = mapped ? mapped.slice(1).flatMap((hex) => [parseInt(hex, 16) >> 8, parseInt(hex, 16) & 255]).join(".") : host;
	return zone === undefined ? canonical : `${canonical}%${zone}`;
}

export function httpsOrigin(text: string): URL {
	const url = new URL(text);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("url must be an HTTPS origin");
	return url;
}

/** The configuration [value] if it is valid: `init` checks the one it writes, `loadConfig` the one it reads. */
export function checkConfig(value: unknown): ServerConfig {
	if (!validator.Check(value)) throw new Error("Invalid gateway configuration");
	// The phone refuses a pairing that lists one origin twice. It reads an IPv4-mapped IPv6 host as its IPv4 address
	// (OkHttp), so hosts are compared as canonicalAddress writes them.
	const origins = value.urls.map((text) => {
		const url = httpsOrigin(text);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		return `${isIP(host) ? canonicalAddress(host) : host}:${url.port || 443}`;
	});
	if (new Set(origins).size !== origins.length) throw new Error("Each URL must be a different origin");
	for (const address of value.listen) {
		// 0.0.0.0 and :: listen on every interface.
		if (!isIP(address) || ["0.0.0.0", "::"].includes(canonicalAddress(address).split("%")[0])) throw new Error(`Listen on specific IP addresses of this host, not ${address}`);
	}
	// The same address twice, however written, would fail to start with EADDRINUSE.
	if (new Set(value.listen.map(canonicalAddress)).size !== value.listen.length) throw new Error("Each listen address must be different");
	for (const path of [value.cert, value.key, value.devices, value.auditDir]) if (!isAbsolute(path)) throw new Error("Configuration paths must be absolute");
	return value;
}

export function loadConfig(path: string): ServerConfig {
	return checkConfig(JSON.parse(readFileSync(path, "utf8")));
}
