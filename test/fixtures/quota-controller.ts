import { join } from "node:path";
import { QuotaMonitor } from "../../src/manager/collectors/quota.ts";

const [agent, clock] = process.argv.slice(2);
let now = Number(clock);
let complete: ((response: Response) => void) | undefined;
const quota = new QuotaMonitor(join(agent, "multi-login-state.json"), join(agent, "auth.json"), {
	now: () => now,
	renew: async () => {},
	fetch: async () => {
		process.send!({ type: "request" });
		return new Promise<Response>((resolve) => { complete = resolve; });
	},
});
process.on("message", (message) => {
	if (message === "refresh") void quota.refresh().then(() => process.send!({ type: "done", snapshot: quota.snapshot(now) }));
	else if (message === "throttle") complete!(new Response("", { status: 429, headers: { "Retry-After": "1640" } }));
	else if (message === "advance") { now += 600_000; process.send!({ type: "clock" }); }
});
process.send!({ type: "ready" });
