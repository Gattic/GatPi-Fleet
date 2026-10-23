// Resource attribution against real processes (not mocks).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseStat, ProcSampler } from "../src/manager/collectors/procs.ts";

const children: ChildProcess[] = [];
after(() => {
	for (const child of children) {
		try {
			process.kill(-(child.pid as number), "SIGKILL");
		} catch {}
	}
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("parseStat handles command names with spaces and parentheses", () => {
	// state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss
	const fields = ["S", "1", "100", "100", "34817", "0", "0", "0", "0", "0", "0", "50", "25", "7", "3", "20", "0", "1", "0", "12345", "1000", "10"];
	const stat = parseStat(`4242 (my (odd) cmd) ${fields.join(" ")}`, 4096);
	assert.deepEqual(stat && { pid: stat.pid, comm: stat.comm, ppid: stat.ppid, ttyNr: stat.ttyNr, own: stat.own, child: stat.child, starttime: stat.starttime, rss: stat.rss }, {
		pid: 4242,
		comm: "my (odd) cmd",
		ppid: 1,
		ttyNr: 34817,
		own: 75,
		child: 10,
		starttime: 12345,
		rss: 10 * 4096,
	});
	assert.ok(parseStat(readFileSync("/proc/self/stat", "utf8"), 4096));
});

test("busy descendants, short-lived children and PI_SESSION_ID orphans count as indirect", async () => {
	// root: an idle stand-in for pi that starts a busy child and repeatedly runs short CPU bursts.
	// The trailing comments mark each loop's command line, which is its consumer label.
	const script = `
		sh -c 'while :; do :; done # busy-child' &
		while :; do timeout 0.3 sh -c 'while :; do :; done # burst'; done
	`;
	const root = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
	children.push(root);
	// An orphan in its own session that inherited the pi session id (like a daemonized tool process).
	const orphan = spawn("sh", ["-c", "while :; do :; done # orphan"], { detached: true, stdio: "ignore", env: { ...process.env, PI_SESSION_ID: "dash-test-session" } });
	children.push(orphan);
	const sampler = new ProcSampler();
	const target = { key: "t", pid: root.pid as number, sessionId: "dash-test-session" };
	sampler.sample([target], undefined);
	await sleep(1500);
	const sample = sampler.sample([target], undefined);
	const resources = sample.resources.get("t");
	assert.ok(resources, "target sampled");
	assert.ok(resources.directCpu < 0.2, `idle root has little direct CPU (${resources.directCpu})`);
	// Each loop gets whatever share of a core the machine has free, so check that every
	// mechanism contributes rather than expecting an absolute total.
	const cpuOfLoop = (marker: string) => resources.consumers.find((consumer) => consumer.label === `sh -c while :; do :; done # ${marker}`)?.cpu ?? 0;
	assert.ok(cpuOfLoop("busy-child") > 0.1, `busy descendant is attributed (${cpuOfLoop("busy-child")})`);
	assert.ok(cpuOfLoop("orphan") > 0.1, `PI_SESSION_ID orphan is attributed (${cpuOfLoop("orphan")})`);
	const liveCpu = resources.consumers.filter((consumer) => consumer.kind === "process").reduce((sum, consumer) => sum + consumer.cpu, 0);
	// Bursts that exited between the two samples only remain in the root's cutime.
	assert.ok(resources.indirectCpu - liveCpu > 0.1, `reaped bursts are counted (${resources.indirectCpu} total, ${liveCpu} live)`);
	assert.ok(resources.indirectMem > 0);
	assert.ok(resources.consumers.some((consumer) => consumer.kind === "self"));
	assert.ok(resources.childProcesses >= 1, `live descendants are counted (${resources.childProcesses})`);
});

function userSystemdAvailable(): boolean {
	const uid = process.getuid?.() ?? 0;
	return existsSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`);
}

test("work run in a transient systemd unit is attributed to the session that started it", { skip: !userSystemdAvailable() && "no user systemd" }, async () => {
	// Like build_project: the tool runs `systemd-run --user --wait`; the work lives in
	// run-p<clientPid>-i<n>.service, outside the pi process tree.
	const root = spawn("sh", ["-c", "systemd-run --user --wait --collect -q sh -c 'timeout 6 sh -c \"while :; do :; done\"'"], { detached: true, stdio: "ignore" });
	children.push(root);
	const sampler = new ProcSampler();
	const target = { key: "t", pid: root.pid as number };
	await sleep(800);
	sampler.sample([target], undefined);
	await sleep(1500);
	const resources = sampler.sample([target], undefined).resources.get("t");
	assert.ok(resources);
	const unit = resources.consumers.find((consumer) => consumer.kind === "unit");
	assert.ok(unit, `unit consumer listed: ${JSON.stringify(resources.consumers)}`);
	assert.match(unit.label, /^run-p\d+-i\d+/);
	assert.ok(unit.cpu > 0.5, `unit CPU counted (${unit.cpu})`);
	assert.ok(resources.indirectCpu > 0.5, `indirect CPU includes the unit (${resources.indirectCpu})`);
});

test("background jobs and subagents among a session's processes are recognised with their names", async (t) => {
	const project = mkdtempSync(join(tmpdir(), "pi-dash-bg-"));
	t.after(() => rmSync(project, { recursive: true, force: true }));
	mkdirSync(join(project, ".pi", "jobs"), { recursive: true });
	mkdirSync(join(project, ".pi", "subagents", "records"), { recursive: true });
	writeFileSync(join(project, ".pi", "jobs", "job-1.json"), JSON.stringify({ jobId: "job-1", name: "nightly-build" }));
	writeFileSync(join(project, ".pi", "subagents", "records", "sub_1.json"), JSON.stringify({ id: "sub_1", role: "coder" }));
	// Stand-ins with the command lines GatPi-Harness uses; `; :` keeps sh (and its arguments) alive.
	const job = `sh -c 'sleep 1000; :' /opt/GatPi-Harness/src/managed-job-supervisor.js ${join(project, ".pi", "jobs", "job-1.launch.json")}`;
	const subagent = `sh -c 'sleep 1000; :' pi --mode rpc --session-dir ${join(project, ".pi", "subagents", "rpc-sessions", "sub_1")}`;
	const root = spawn("sh", ["-c", `${job} & ${subagent} & wait`], { detached: true, stdio: "ignore" });
	children.push(root);
	await sleep(300);
	const resources = new ProcSampler().sample([{ key: "t", pid: root.pid as number }], undefined).resources.get("t");
	assert.ok(resources);
	const found = resources.background.map((work) => [work.kind, work.label]).sort();
	assert.deepEqual(found, [
		["job", "nightly-build"],
		["subagent", "coder"],
	]);
	for (const work of resources.background) assert.ok(Math.abs(Date.now() - work.startedAt) < 5000, `start time is the process start (${work.startedAt})`);
});
