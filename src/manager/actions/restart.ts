import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { type BridgeHub, pidAlive } from "../collectors/bridges.ts";
import { rowLabel, type SessionRow } from "../model/store.ts";
import { launchReservation, launchSession } from "./launch.ts";

/** Runs on the session's host. Never launch while the old process or its reservation still owns the file. */
export async function restartSession(row: SessionRow, hub: BridgeHub, rows: () => SessionRow[], runtimeDir: string): Promise<string> {
	const state = row.bridge;
	if (!state || !row.connected || row.exitedAt !== undefined) throw new Error("Session bridge disconnected or exited");
	if (state.phase !== "idle") throw new Error("Restart only while idle");
	if (state.asks.some((ask) => ask.status === "answering")) throw new Error("A side question is still answering");
	if (!state.sessionFile) throw new Error("Restart requires a saved conversation");
	const options = { cwd: state.cwd, label: rowLabel(row), sessionFile: state.sessionFile };
	const reservation = launchReservation(state.sessionFile, runtimeDir);
	await hub.send(state, { kind: "shutdown" });
	const deadline = Date.now() + 15_000;
	while (pidAlive(state.pid) || existsSync(reservation)) {
		if (Date.now() >= deadline) throw new Error("Restart stopped: the old process or its launch reservation has not exited. Inspect the session before resuming it from Projects.");
		await delay(100);
	}
	return launchSession(options, rows(), runtimeDir);
}
