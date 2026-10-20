// pi-dash-relay: pi-dash starts it over ssh on a remote host. It serves that host's pi bridges,
// process samples, peeks, project and session listings, launches and Git operations on stdin/stdout.
// `pi-dash-relay install` registers this package's bridge with the host's pi.
import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitCli } from "../manager/actions/git.ts";
import { launchSession } from "../manager/actions/launch.ts";
import { readHardcopy, requestHardcopy } from "../manager/actions/peek.ts";
import { listProjects, listSessions } from "../manager/actions/sessions.ts";
import { BridgeHub, pidAlive, UncertainCommandError } from "../manager/collectors/bridges.ts";
import { GpuMonitor } from "../manager/collectors/gpu.ts";
import { ProcSampler } from "../manager/collectors/procs.ts";
import { rowCwd, Store } from "../manager/model/store.ts";
import { agentDir, RecoveryJournal } from "../manager/recovery.ts";
import type { IndexUpdate } from "../manager/usage/types.ts";
import { UsageIndex, USAGE_RETENTION_MS } from "../manager/usage/usage-index.ts";
import { cacheDir, diffState, LineDecoder, PROTOCOL_VERSION, type SessionState, socketDir } from "../protocol/index.ts";
import { chunkUsage, encodeRelay, GIT_METHODS, RELAY_VERSION, type RelayMessage, type RelayOp, type RelayOps, type RelayRequest } from "./protocol.ts";

type Handlers = { [K in RelayOp]: (params: RelayOps[K]["params"]) => RelayOps[K]["result"] | Promise<RelayOps[K]["result"]> };

/** A usage message stays well below the receiver's line limit however many files a first scan finds. */
const USAGE_MESSAGE_CHARS = 1024 * 1024;

function serve(): void {
	const dir = socketDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const sessionRoot = join(agentDir(), "sessions");
	const recovery = new RecoveryJournal();
	const write = (message: RelayMessage) => process.stdout.write(encodeRelay(message));
	// The state last forwarded per bridge: later states go out as patches against it.
	const forwarded = new Map<number, SessionState>();
	const store = new Store(() => {});
	const hub = new BridgeHub(dir, {
		onState: (pid, state) => {
			store.setState(pid, state);
			const previous = forwarded.get(pid);
			forwarded.set(pid, state);
			write(previous ? { type: "patch", pid, changes: diffState(previous, state) } : { type: "snapshot", pid, state });
		},
		onBye: (pid, reason) => {
			store.bye(pid, reason);
			if (reason === "quit") store.dismiss(String(pid));
			write({ type: "bye", pid, reason });
		},
		onDisconnect: (pid) => {
			forwarded.delete(pid);
			const alive = pidAlive(pid);
			store.disconnect(pid, alive);
			if (!alive) store.dismiss(String(pid));
			write({ type: "disconnect", pid, alive });
		},
		onIncompatible: (pid, version) => write({ type: "incompatible", pid, version }),
	});
	// This host's usage, indexed in a worker so a first scan never delays the bridges. Updates go out as they
	// arrive: the first message replaces what an earlier relay of this host delivered.
	let firstUsage = true;
	let scanReported = false;
	const usage = new UsageIndex({
		sessionRoot,
		cachePath: join(cacheDir(), "usage-index-relay.json"),
		retentionMs: USAGE_RETENTION_MS,
		onUpdate: (update: IndexUpdate) => {
			if (!firstUsage && !update.changed.length && !update.removed.length && (!update.scanned || scanReported)) return;
			scanReported ||= update.scanned;
			const messages = chunkUsage(update.changed, USAGE_MESSAGE_CHARS);
			messages.forEach((changed, index) => {
				const last = index === messages.length - 1;
				write({ type: "usage", reset: firstUsage, changed, removed: index === 0 ? update.removed : [], scanned: last && update.scanned });
				firstUsage = false;
			});
		},
	});
	const sampler = new ProcSampler();
	const gpu = new GpuMonitor();
	const git = new GitCli();
	const peeks = new Set<string>();
	const launchRows = () => {
		// Controller snapshots can lag. Recheck ownership on the host performing the mutation,
		// including processes whose bridge predates lifecycle tracking or is disconnected.
		hub.scan();
		store.applySample(sampler.sample(store.targets(), gpu.latest), gpu.latest, Date.now());
		// Unlike a dashboard, the relay needs only current owners, not an ever-growing exit history.
		for (const row of store.rows.values()) if (row.exitedAt !== undefined) store.dismiss(row.key);
		return store.ordered();
	};

	const handlers: Handlers = {
		command: async ({ target, command }) => {
			await hub.send(target, command);
			return null;
		},
		sample: ({ targets }) => {
			const sample = sampler.sample(targets, gpu.latest);
			const latest = gpu.latest;
			return { resources: [...sample.resources], piProcesses: sample.piProcesses, interrupted: recovery.list(), host: sample.host, gpu: latest && { utilization: latest.utilization, memUsed: latest.memUsed, memTotal: latest.memTotal } };
		},
		peek: ({ pid, sty, window }) => {
			// The pid names a file in the private runtime directory.
			if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`);
			const file = join(dir, `peek-${pid}.txt`);
			peeks.add(file);
			const lines = readHardcopy(file) ?? null;
			try {
				unlinkSync(file);
			} catch {}
			requestHardcopy(sty, window, file);
			return lines;
		},
		projects: ({ live }) => listProjects(sessionRoot, live),
		sessions: ({ cwd }) => listSessions(sessionRoot, cwd),
		launch: ({ cwd, label, sessionFile }) => launchSession({ cwd: cwd.replace(/^~(?=\/|$)/, homedir()), label, sessionFile }, sessionFile ? launchRows() : [], dir),
		recover: ({ instanceId }) => {
			const record = recovery.interrupted(instanceId);
			return launchSession({ cwd: record.cwd, label: record.name ?? "recovered", sessionFile: record.sessionFile }, launchRows(), dir);
		},
		dismissRecovery: ({ instanceId }) => { recovery.dismiss(instanceId); return null; },
		git: ({ method, args }) => {
			if (!GIT_METHODS.includes(method)) throw new Error(`unknown git operation ${String(method)}`);
			return (git[method] as (...args: unknown[]) => Promise<unknown>).apply(git, args);
		},
	};

	const run = async (request: RelayRequest) => {
		try {
			const handler = handlers[request.op] as (params: unknown) => unknown;
			write({ type: "result", id: request.id, ok: true, value: await handler(request.params) });
		} catch (error) {
			write({ type: "result", id: request.id, ok: false, error: (error as Error).message || "relay request failed", uncertain: error instanceof UncertainCommandError || undefined });
		}
	};

	const scanUsage = () => usage.scan([...new Set([...usage.cwds(), ...store.ordered().flatMap((row) => rowCwd(row) ?? [])])]);
	const timers = [setInterval(() => hub.scan(), 1000), setInterval(() => void gpu.poll(), 5000), setInterval(scanUsage, 15_000)];
	// pi-dash ends the ssh session when it quits or loses the host; stdin closes then.
	const stop = () => {
		for (const timer of timers) clearInterval(timer);
		hub.close();
		void usage.close();
		for (const file of peeks) {
			try {
				unlinkSync(file);
			} catch {}
		}
		process.exit(0);
	};
	const decoder = new LineDecoder();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		let requests: unknown[];
		try {
			requests = decoder.push(chunk);
		} catch {
			return stop();
		}
		for (const request of requests) void run(request as RelayRequest);
	});
	process.stdin.on("end", stop);
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);
	// pi-dash disconnects when stdout closes; a write error then is expected.
	process.stdout.on("error", stop);

	write({ type: "hello", version: RELAY_VERSION, bridge: PROTOCOL_VERSION, hostname: hostname() });
	hub.scan();
	void gpu.poll();
	usage.start();
	scanUsage();
}

if (process.argv[2] === "install") {
	execFileSync("pi", ["install", dirname(dirname(dirname(fileURLToPath(import.meta.url))))], { stdio: "inherit" });
} else if (process.argv.length > 2) {
	process.stderr.write("usage: pi-dash-relay [install]\n");
	process.exit(2);
} else {
	serve();
}
