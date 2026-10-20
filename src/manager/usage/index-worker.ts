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
	// The cache only speeds up the next start. If it cannot be written (read-only home, full disk), the scan must still
	// be reported: a worker that dies here never answers, and its host would show as still indexing for good.
	if (changed.length || removed.length) {
		try {
			indexer.save();
		} catch {}
	}
	port.postMessage({ type: "update", changed, removed, scanned: true, durationMs: Date.now() - started } satisfies IndexUpdate);
});
