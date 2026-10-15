import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitFixture } from "../scripts/git-fixture.ts";
import { COMMIT_REVIEW_PROMPT, GitCli, type GitSummary } from "../src/manager/actions/git.ts";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage } from "../src/protocol/index.ts";
import { DeviceStore } from "../src/server/auth.ts";
import { Gateway } from "../src/server/gateway.ts";
import { ApiError } from "../src/server/contract.ts";
import { gitMenu, SessionGit } from "../src/server/git.ts";
import { Sessions } from "../src/server/sessions.ts";

const base: GitSummary = { cwd: "/project", root: "/project", branch: "main", headOid: "a".repeat(40), ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, remotes: ["origin"] };
test("git menu matches the TUI guards, warnings, confirmations and shared phone fixture", () => {
	const menu = (patch: Partial<GitSummary>) => gitMenu({ ...base, ...patch }, undefined, "revision", ["agent"]);
	assert.deepEqual(gitFixture(), JSON.parse(readFileSync(new URL("../api/fixtures/git.json", import.meta.url), "utf8")));
	const initial = menu({});
	assert.match(initial.actions[0].blocked!, /No upstream/);
	assert.equal(initial.actions[1].blocked, null);
	assert.match(initial.actions[1].description!, /git push -u origin HEAD/);
	assert.equal(initial.commitPrompt, COMMIT_REVIEW_PROMPT);
	assert.match(initial.warning!, /agent is working/);
	assert.match(menu({ remotes: ["one", "two"] }).actions[1].blocked!, /No upstream/);
	const detached = menu({ branch: undefined, headOid: "12345678901234567890" });
	assert.equal(detached.head, "detached 123456789012");
	assert.match(detached.actions[0].blocked!, /detached HEAD/);
	assert.match(detached.actions[1].blocked!, /detached HEAD/);
	assert.equal(detached.actions[2].blocked, null);
	const dirty = menu({ upstream: "origin/main", staged: 1, behind: 2 });
	assert.match(dirty.actions[0].description!, /1 staged/);
	assert.match(dirty.actions[0].description!, /Let active tools finish/);
	assert.match(dirty.actions[1].description!, /behind origin\/main by 2/);
	assert.match(dirty.actions[2].blocked!, /Working tree has changes/);
});

test("an amended commit invalidates a push confirmation even when divergence and tree counts stay unchanged", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-git-amend-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const project = join(dir, "project"); mkdirSync(project);
	const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	writeFileSync(join(project, "file"), "initial"); git("add", "file"); git("commit", "-m", "initial");
	git("remote", "add", "origin", join(dir, "origin.git"));
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	git("branch", "--set-upstream-to=origin/main");
	writeFileSync(join(project, "file"), "unpushed"); git("commit", "-am", "unpushed");
	const originalHead = git("rev-parse", "HEAD");
	const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache") });
	t.after(() => runtime.close());
	runtime.store.setState(11, { pid: 11, instanceId: "instance", sessionId: "session", cwd: project, phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	const sessions = new Sessions(runtime), service = new SessionGit(sessions);
	const id = sessions.overview()[0].id;
	const confirmed = await service.menu(id);
	assert.equal(confirmed.ahead, 1);
	assert.equal(confirmed.behind, 0);
	assert.equal(confirmed.tree, "clean");
	writeFileSync(join(project, "file"), "amended"); git("commit", "-am", "amended", "--amend");
	assert.notEqual(git("rev-parse", "HEAD"), originalHead);
	const refreshed = await service.menu(id);
	const { revision: oldRevision, ...oldDisplay } = confirmed;
	const { revision: newRevision, ...newDisplay } = refreshed;
	assert.deepEqual(newDisplay, oldDisplay, "only the commit identity changed, not the displayed summary");
	// Capture dispatch rather than publishing even to a test remote.
	const push = t.mock.method(GitCli.prototype, "push", async () => ({ stdout: "", stderr: "" }));
	const request = { requestId: randomUUID(), epoch: randomUUID(), revision: oldRevision, action: { kind: "push" as const } };
	await assert.rejects(service.action(id, request), (error: unknown) => error instanceof ApiError && error.status === 409 && /state changed/.test(error.message));
	assert.equal(push.mock.callCount(), 0, "the stale confirmation must not dispatch");
	assert.notEqual(newRevision, oldRevision);
	await service.action(id, { ...request, requestId: randomUUID(), revision: newRevision });
	assert.equal(push.mock.callCount(), 1, "a freshly reviewed confirmation can dispatch");
});

test("authenticated git routes operate only on session projects, confirm current state and deduplicate mutations", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-server-git-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const project = join(dir, "project"); mkdirSync(project);
	const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	writeFileSync(join(project, "file"), "initial"); git("add", "."); git("commit", "-m", "initial"); git("branch", "feature");
	const remote = join(dir, "origin.git"); execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
	git("remote", "add", "origin", remote);
	const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
	const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache") });
	t.after(() => runtime.close());
	runtime.store.setState(11, { pid: 11, instanceId: "instance", sessionId: "session", cwd: project, phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	const devices = new DeviceStore(join(dir, "devices.json")); const paired = devices.pair("test");
	const gateway = new Gateway({ listen: ["127.0.0.1"], port: 7443, urls: ["https://127.0.0.1:7443"], label: "test", cert, key, devices: devices.path, auditDir: join(dir, "audit") }, runtime);
	await gateway.listen(0); t.after(() => gateway.close());
	const call = (path: string, body?: unknown, token = paired.token, origin?: string) => new Promise<{ status: number; data: any }>((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port: gateway.port, path, ca: readFileSync(cert), method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) } }, (res) => {
			let text = ""; res.setEncoding("utf8"); res.on("data", (s) => { text += s; }); res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(text) }));
		}); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
	});
	const id = gateway.sessions.overview()[0].id, path = `/api/v1/sessions/${id}/git`;
	const info = (await call("/api/v1/info")).data;
	assert.ok(info.capabilities.includes("git"));
	const menu = async () => { const r = await call(path); assert.equal(r.status, 200); return r.data; };
	const input = async (action: object) => ({ requestId: randomUUID(), epoch: info.epoch, revision: (await menu()).revision, action });
	const settled = async (body: { requestId: string }) => {
		for (let i = 0; i < 500; i++) {
			const r = (await call(`/api/v1/commands/${body.requestId}`)).data;
			if (r.state !== "received") return r;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.fail("git receipt did not settle");
	};
	const push = await input({ kind: "push" });
	for (const [route, body] of [[path, undefined], [`${path}/branches`, undefined], [`${path}/status`, undefined], [path, push]] as const) {
		assert.equal((await call(route, body, "invalid")).status, 401);
		assert.equal((await call(route, body, paired.token, "https://evil.invalid")).status, 403);
	}
	assert.match((await menu()).actions[1].description, /git push -u origin HEAD/);
	assert.equal((await call(path, push)).status, 202);
	assert.equal((await settled(push)).state, "accepted");
	assert.equal(git("rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
	assert.equal((await call(path, { ...push, action: { kind: "pull" } })).status, 409);
	assert.equal((await call(path, { ...push, requestId: randomUUID(), epoch: randomUUID() })).status, 409);
	for (const action of [{ kind: "shell", text: "pwd" }, { kind: "push", force: true }, { kind: "switch", branch: "" }]) {
		assert.equal((await call(path, { ...push, action })).status, 400);
	}
	assert.equal((await call(path, { ...push, cwd: "/" })).status, 400);
	assert.deepEqual((await call(`${path}/branches`)).data.branches.map((b: { name: string }) => b.name), ["feature", "main"]);
	assert.match((await call(`${path}/status`)).data.text, /On branch main/);
	const switchBranch = await input({ kind: "switch", branch: "feature" });
	await Promise.all([call(path, switchBranch), call(path, switchBranch)]);
	assert.equal((await settled(switchBranch)).state, "accepted");
	assert.equal((await call(path, switchBranch)).data.state, "accepted", "same receipt, not another dispatch with stale revision");
	assert.equal(git("branch", "--show-current"), "feature");
	const stale = await input({ kind: "switch", branch: "main" });
	writeFileSync(join(project, "dirty"), "changes");
	await call(path, stale); assert.match((await settled(stale)).error, /state changed/);
	const dirty = await input({ kind: "switch", branch: "main" });
	await call(path, dirty); assert.match((await settled(dirty)).error, /Working tree has changes/);
	rmSync(join(project, "dirty"));
	const invalid = await input({ kind: "switch", branch: "--detach" });
	await call(path, invalid); assert.match((await settled(invalid)).error, /existing local branch/);
	git("switch", "main");
	const other = join(dir, "other"); execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
	writeFileSync(join(other, "new"), "from remote");
	execFileSync("git", ["-C", other, "add", "."]);
	execFileSync("git", ["-C", other, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "remote change"], { stdio: "ignore" });
	execFileSync("git", ["-C", other, "push"], { stdio: "ignore" });
	const pull = await input({ kind: "pull" }); await call(path, pull);
	assert.equal((await settled(pull)).state, "accepted"); assert.equal(readFileSync(join(project, "new"), "utf8"), "from remote");
	git("checkout", "--detach");
	const detached = await input({ kind: "push" }); await call(path, detached);
	assert.match((await settled(detached)).error, /detached HEAD/);
	runtime.store.rows.clear();
	assert.equal((await call(path)).status, 404);
	const gone = { ...pull, requestId: randomUUID() }; await call(path, gone);
	assert.match((await settled(gone)).error, /Session no longer exists/);
});
