// Preload for test/e2e/quota-renewal.test.ts (NODE_OPTIONS=--import). It answers Anthropic's OAuth token
// and usage endpoints in-process with synthetic data and rejects every other request, so no socket is
// ever opened. It also records what the dashboard did, including whether process.exit() was requested and
// whether the rotated token was already on disk at that moment.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

const log = process.env.QUOTA_STUB_LOG;
const failRefresh = process.env.QUOTA_STUB_TOKEN_MODE === "fail";
const refreshDelayMs = Number(process.env.QUOTA_STUB_TOKEN_DELAY_MS ?? 0);
const record = (event: Record<string, unknown>) => {
	if (log) appendFileSync(log, `${JSON.stringify({ t: Date.now(), main: isMainThread, ...event })}\n`);
};
let issued = 0;

if (isMainThread) {
	// `entry` proves which source tree actually ran.
	record({ kind: "start", pid: process.pid, entry: process.argv[1] });
	process.on("exit", (code) => record({ kind: "exit", code }));
	// An explicit process.exit() (the dashboard's quit path) differs from the event loop merely draining
	// once this stub's pending refresh response settles.
	const realExit = process.exit;
	process.exit = (code) => {
		let persisted = false;
		try { persisted = readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "auth.json"), "utf8").includes("SYN-ACCESS-NEW-"); } catch { /* not persisted */ }
		record({ kind: "exit-called", code, persisted, stack: new Error().stack?.split("\n").slice(2, 6).map((line) => line.trim()) });
		return realExit.call(process, code);
	};
}

globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const method = (init.method ?? "GET").toUpperCase();

	if (url === "https://platform.claude.com/v1/oauth/token" && method === "POST") {
		const body = JSON.parse(String(init.body));
		record({ kind: "token-request", grant: body.grant_type, refresh: body.refresh_token });
		// The response is withheld like a slow provider; only Pi's own request signal can cancel it.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, refreshDelayMs);
			init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
		});
		if (failRefresh) {
			record({ kind: "token-response", status: 400 });
			return new Response(JSON.stringify({ error: "invalid_grant", detail: "SYN-SECRET-BODY" }), { status: 400 });
		}
		issued++;
		record({ kind: "token-response", status: 200, issued });
		return Response.json({ access_token: `SYN-ACCESS-NEW-${issued}`, refresh_token: `SYN-REFRESH-NEW-${issued}`, expires_in: 28800 });
	}

	if (url === "https://api.anthropic.com/api/oauth/usage" && method === "GET") {
		const authorization = new Headers(init.headers).get("authorization");
		const accepted = Boolean(authorization?.startsWith("Bearer SYN-ACCESS-")) && !authorization?.includes("EXPIRED");
		record({ kind: "usage", authorization, ok: accepted });
		if (!accepted) return new Response("", { status: 401 });
		return Response.json({
			five_hour: { utilization: 37, resets_at: new Date(Date.now() + 3 * 3600e3).toISOString() },
			seven_day: { utilization: 61, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
		});
	}

	record({ kind: "blocked", url, method });
	throw new TypeError("network blocked by the test stub");
};
