// Worker thread owning the usage index so large initial scans never block the UI.
import { parentPort, workerData } from "node:worker_threads";
import { UsageIndexer } from "./indexer.ts";
import type { IndexUpdate, ScanRequest } from "./types.ts";

const port = parentPort;
if (!port) throw new Error("index-worker must run in a worker thread");

const indexer = new UsageIndexer((workerData as { cachePath?: string }).cachePath);
const loaded = indexer.load();
port.postMessage({ type: "update", changed: loaded, removed: [], scanned: false, durationMs: 0 } satisfies IndexUpdate);

port.on("message", (request: ScanRequest) => {
	const started = Date.now();
	const { changed, removed } = indexer.scan(request);
	if (changed.length || removed.length) indexer.save();
	port.postMessage({ type: "update", changed, removed, scanned: true, durationMs: Date.now() - started } satisfies IndexUpdate);
});
