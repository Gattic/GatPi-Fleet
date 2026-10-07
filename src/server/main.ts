import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ManagerRuntime } from "../manager/runtime.ts";
import { DeviceStore } from "./auth.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";

async function main(): Promise<void> {
	process.umask(0o077);
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		config: { type: "string" }, dir: { type: "string" }, url: { type: "string" }, listen: { type: "string" },
		project: { type: "string", multiple: true }, name: { type: "string" }, id: { type: "string" }, help: { type: "boolean" },
	} });
	const dir = resolve(values.dir ?? join(homedir(), ".config", "pi-dash-server"));
	const configPath = resolve(values.config ?? join(dir, "config.json"));
	const action = positionals[0] ?? "serve";
	if (values.help) {
		console.log(`pi-dash-server — authenticated intranet session gateway

init --url https://HOST:7443 --listen LAN_IP --project /approved/project [--project ...]
pair --name PHONE          Prints sensitive pairing JSON; copy into Android locally
list                       List paired device IDs (no tokens)
revoke --id DEVICE_ID       Existing streams close within five seconds
serve                      Run using the configured HTTPS listener

All commands accept --config PATH or --dir DIRECTORY.
Default directory: ~/.config/pi-dash-server
Default bind: 127.0.0.1. No plaintext mode. init creates a private self-signed CA/server
certificate; verify its fingerprint on the phone. No host/provider secrets enter the APK.`);
		return;
	}
	if (action === "init") {
		if (!values.url) throw new Error("init requires --url https://HOST:PORT");
		const url = new URL(values.url);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an HTTPS origin");
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (!isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("Invalid hostname");
		if (existsSync(configPath) || existsSync(join(dir, "server.key"))) throw new Error("Configuration already exists; rotation requires an explicit new directory and re-pairing");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const config: ServerConfig = { listen: values.listen ?? "127.0.0.1", port: Number(url.port || 443), url: url.origin, label: host,
			cert: join(dir, "server.crt"), key: join(dir, "server.key"), devices: join(dir, "devices.json"), auditDir: join(dir, "audit"), projectRoots: (values.project ?? []).map((p) => resolve(p)) };
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "365", "-keyout", config.key, "-out", config.cert, "-subj", "/CN=pi-dash", "-addext", `subjectAltName=${isIP(host) ? "IP" : "DNS"}:${host}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign", "-addext", "extendedKeyUsage=serverAuth"], { stdio: "ignore" });
		writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		console.log(`Created ${configPath}\nCertificate SHA-256: ${new X509Certificate(readFileSync(config.cert)).fingerprint256}\nRun pair --name PHONE, then serve. Restrict the listener with your firewall.`);
		return;
	}
	const config = loadConfig(configPath);
	const devices = new DeviceStore(config.devices);
	if (action === "pair") {
		const { token, device } = devices.pair(values.name ?? "Android");
		console.log(JSON.stringify({ version: 1, url: config.url, token, deviceId: device.id, caCertificate: readFileSync(config.cert, "utf8"), fingerprint: new X509Certificate(readFileSync(config.cert)).fingerprint256 }, null, 2));
		return;
	}
	if (action === "list") { console.log(JSON.stringify(devices.list().map(({ id, name, createdAt }) => ({ id, name, createdAt })), null, 2)); return; }
	if (action === "revoke") { if (!values.id) throw new Error("revoke requires --id"); devices.revoke(values.id); console.log("Revoked; streams close within five seconds"); return; }
	if (action !== "serve") throw new Error(`Unknown action: ${action}`);
	const runtime = new ManagerRuntime({ cacheName: "usage-index-server.json" });
	const gateway = new Gateway(config, runtime);
	let stopping = false;
	const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); await runtime.close(); };
	process.on("SIGINT", () => { void stop(); });
	process.on("SIGTERM", () => { void stop(); });
	try { await gateway.listen(); runtime.start(); }
	catch (error) { await stop(); throw error; }
	console.log(`pi-dash gateway listening on ${config.listen}:${config.port}; ${devices.list().length} paired devices`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Gateway failed"); process.exitCode = 1; });
