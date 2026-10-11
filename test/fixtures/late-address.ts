// Runs inside a new network namespace (`unshare -rn`), where it may add and remove addresses as a VPN does. Four
// gateways each wait for addresses not on any interface yet. The first must serve its address once it appears, and
// again after it comes back. The second, closed while it starts, must not serve its address when it appears. At the
// third's address another program takes the port first: the gateway reports that once and stops trying. The fourth
// waits for two addresses and is closed just as it listens on the first: it must not go on to the second.
// Prints one JSON line of results.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagerRuntime } from "../../src/manager/runtime.ts";
import { DeviceStore } from "../../src/server/auth.ts";
import { Gateway } from "../../src/server/gateway.ts";

const VPN = "10.8.0.2", CLOSED = "10.8.0.3", TAKEN = "10.8.0.4", FIRST = "10.8.0.5", SECOND = "10.8.0.6";
const ip = (...args: string[]) => execFileSync("ip", args, { stdio: "ignore" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
ip("link", "set", "lo", "up");
const dir = mkdtempSync(join(tmpdir(), "pi-dash-late-address-"));
const cert = join(dir, "cert.pem"); const key = join(dir, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", `subjectAltName=IP:127.0.0.1,IP:${VPN},IP:${CLOSED}`], { stdio: "ignore" });
const devices = new DeviceStore(join(dir, "devices.json"));
const { token } = devices.pair("test phone");
const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache") });
const gateway = (port: number, ...addresses: string[]) => new Gateway({ listen: ["127.0.0.1", ...addresses], port, urls: addresses.map((address) => `https://${address}:${port}`),
	label: "test host", cert, key, devices: devices.path, auditDir: join(dir, "audit") }, runtime);
const served = gateway(7443, VPN), closed = gateway(7444, CLOSED), taken = gateway(7445, TAKEN), stopping = gateway(7446, FIRST, SECOND);
// The fourth gateway is closed as soon as it reports listening on its first address, while its retry is still under way.
let stopped: Promise<void> | undefined;
const log = console.log;
console.log = (...args: unknown[]) => {
	log(...args);
	if (args[0] === `pi-dash gateway listening on ${FIRST} port 7446`) stopped = stopping.close();
};
/** The status of an authenticated info request, or the error code. */
const info = (hostname: string, port: number) => new Promise<number | string>((resolve) => {
	const req = request({ hostname, port, path: "/api/v1/info", ca: readFileSync(cert), timeout: 3000, headers: { Authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
	req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
	req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
	req.end();
});
async function listenedOn(g: Gateway): Promise<number> {
	const start = Date.now();
	while (g.waitingFor().length) {
		if (Date.now() - start > 10_000) throw new Error("not listened on within 10 s");
		await sleep(50);
	}
	return Date.now() - start;
}
try {
	await served.listen();
	await taken.listen();
	await stopping.listen();
	const starting = closed.listen(); // Stopped during start-up.
	await closed.close();
	await starting;
	const result: Record<string, unknown> = { waitingAtStart: served.waitingFor(), lan: await info("127.0.0.1", 7443) };
	// The addresses appear (the VPN connects). At TAKEN another program listens first: its listen binds on the next
	// tick, before the gateway's next try, which is a timer.
	const appeared = Date.now();
	for (const address of [VPN, CLOSED, TAKEN, FIRST, SECOND]) ip("addr", "add", `${address}/32`, "dev", "lo");
	const other = createServer().listen(7445, TAKEN);
	result.listenedAfterMs = await listenedOn(served);
	result.vpn = await info(VPN, 7443);
	ip("addr", "del", `${VPN}/32`, "dev", "lo"); // The VPN disconnects and connects again.
	ip("addr", "add", `${VPN}/32`, "dev", "lo");
	result.vpnBack = await info(VPN, 7443);
	await sleep(appeared + 4500 - Date.now()); // Two retry periods after the addresses appeared.
	result.closedLan = await info("127.0.0.1", 7444);
	result.closedAddress = await info(CLOSED, 7444);
	result.takenWaitingFor = taken.waitingFor();
	result.stoppedDuringRetry = stopped !== undefined;
	await stopped;
	result.stoppedFirst = await info(FIRST, 7446);
	result.stoppedSecond = await info(SECOND, 7446);
	other.close();
	console.log(JSON.stringify(result));
} finally {
	await served.close();
	await taken.close();
	await runtime.close();
	rmSync(dir, { recursive: true, force: true });
}
