import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostsPath, loadHosts } from "../manager/remote/hosts.ts";
import { ManagerRuntime } from "../manager/runtime.ts";
import { DeviceStore } from "./auth.ts";
import { checkConfig, httpsOrigin, loadConfig, type ServerConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";

async function main(): Promise<void> {
	process.umask(0o077);
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		config: { type: "string" }, dir: { type: "string" }, url: { type: "string", multiple: true }, listen: { type: "string", multiple: true },
		name: { type: "string" }, id: { type: "string" }, help: { type: "boolean" },
	} });
	const dir = resolve(values.dir ?? join(homedir(), ".config", "pi-dash-server"));
	const configPath = resolve(values.config ?? join(dir, "config.json"));
	const action = positionals[0] ?? "serve";
	if (values.help) {
		console.log(`pi-dash-server — authenticated intranet session gateway

init --url https://HOST:7443 --listen LAN_IP
                           Repeat both for each address the phone may use, e.g. a VPN
                           address as well: --url https://VPN_IP:7443 --listen VPN_IP
                           An address not up yet (a VPN not connected) is served once it is
pair --name PHONE          Prints sensitive pairing JSON; copy into Android locally
list                       List paired device IDs (no tokens)
revoke --id DEVICE_ID       Existing streams close within five seconds
serve                      Run using the configured HTTPS listener; includes the remote
                           hosts in ${hostsPath()} (pi-dash-host add HOST)

All commands accept --config PATH or --dir DIRECTORY.
Default directory: ~/.config/pi-dash-server
Default listen address: 127.0.0.1. No plaintext mode. init creates a private self-signed CA/server
certificate; verify its fingerprint on the phone. No host/provider secrets enter the APK.`);
		return;
	}
	if (action === "init") {
		if (!values.url) throw new Error("init requires --url https://HOST:PORT");
		const urls = values.url.map(httpsOrigin);
		const hosts = urls.map((url) => url.hostname.replace(/^\[|\]$/g, ""));
		for (const host of hosts) if (!isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("Invalid hostname");
		const ports = new Set(urls.map((url) => Number(url.port || 443)));
		if (ports.size !== 1) throw new Error("Every --url must use the same port");
		const config: ServerConfig = checkConfig({ listen: values.listen ?? ["127.0.0.1"], port: [...ports][0], urls: urls.map((url) => url.origin), label: hosts[0],
			cert: join(dir, "server.crt"), key: join(dir, "server.key"), devices: join(dir, "devices.json"), auditDir: join(dir, "audit") });
		if (existsSync(configPath) || existsSync(join(dir, "server.key"))) throw new Error("Configuration already exists; rotation requires an explicit new directory and re-pairing");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "365", "-keyout", config.key, "-out", config.cert, "-subj", "/CN=pi-dash", "-addext", `subjectAltName=${hosts.map((host) => `${isIP(host) ? "IP" : "DNS"}:${host}`).join(",")}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign", "-addext", "extendedKeyUsage=serverAuth"], { stdio: "ignore" });
		writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		console.log(`Created ${configPath}\nCertificate SHA-256: ${new X509Certificate(readFileSync(config.cert)).fingerprint256}\nRun pair --name PHONE, then serve. Restrict the listener with your firewall.`);
		return;
	}
	if (action === "list" && !existsSync(configPath)) {
		console.log(`No gateway configuration at ${configPath}. Create one with pi-dash-server init --url https://HOST:PORT --listen LAN_IP.`);
		return;
	}
	const config = loadConfig(configPath);
	const devices = new DeviceStore(config.devices);
	if (action === "pair") {
		const { token, device } = devices.pair(values.name ?? "Android");
		console.log(JSON.stringify({ version: 2, urls: config.urls, token, deviceId: device.id, caCertificate: readFileSync(config.cert, "utf8"), fingerprint: new X509Certificate(readFileSync(config.cert)).fingerprint256 }, null, 2));
		return;
	}
	if (action === "list") { console.log(JSON.stringify(devices.list().map(({ id, name, createdAt }) => ({ id, name, createdAt })), null, 2)); return; }
	if (action === "revoke") { if (!values.id) throw new Error("revoke requires --id"); devices.revoke(values.id); console.log("Revoked; streams close within five seconds"); return; }
	if (action !== "serve") throw new Error(`Unknown action: ${action}`);
	const hosts = loadHosts();
	const runtime = new ManagerRuntime({ cacheName: "usage-index-server.json", hosts });
	const gateway = new Gateway(config, runtime);
	let stopping = false;
	const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); await runtime.close(); };
	process.on("SIGINT", () => { void stop(); });
	process.on("SIGTERM", () => { void stop(); });
	try {
		await gateway.listen();
		// Stopped (SIGTERM) while the gateway was starting: stop() is closing it, so nothing more is started or reported.
		if (stopping) return;
		runtime.start();
	} catch (error) { await stop(); throw error; }
	const waiting = gateway.waitingFor();
	const listening = config.listen.filter((address) => !waiting.includes(address));
	console.log(`pi-dash gateway listening on ${listening.join(", ") || "no address yet"} port ${config.port}; `
		+ (waiting.length ? `waiting for ${waiting.join(", ")} to be on an interface; ` : "")
		+ `${devices.list().length} paired devices; ${hosts.length} remote hosts`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Gateway failed"); process.exitCode = 1; });
