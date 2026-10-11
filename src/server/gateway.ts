import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import type { ManagerRuntime } from "../manager/runtime.ts";
import { DeviceStore } from "./auth.ts";
import { Audit } from "./audit.ts";
import { API_VERSION, ApiError, MAX_BODY, MAX_FRAME, commandRequest, launchRequest, parseJson, subscription } from "./contract.ts";
import type { ServerConfig } from "./config.ts";
import { Receipts, type Receipt } from "./receipts.ts";
import { Sessions } from "./sessions.ts";

interface Peer { ws: WebSocket; authorization: string; device: string; seq: number; selected: string | null; overview: string; detail: string; alive: boolean }

class RateLimit {
	private readonly buckets = new Map<string, { count: number; at: number }>();
	allow(key: string, limit: number): boolean {
		const now = Date.now();
		for (const [key, b] of this.buckets) if (now - b.at >= 60_000) this.buckets.delete(key);
		const b = this.buckets.get(key) ?? { count: 0, at: now };
		if (!this.buckets.has(key) && this.buckets.size >= 1024) return false;
		this.buckets.set(key, b);
		return ++b.count <= limit;
	}
}

async function body(req: IncomingMessage): Promise<unknown> {
	if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new ApiError(415, "Use application/json");
	if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new ApiError(413, "Request too large");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw new ApiError(413, "Request too large");
		chunks.push(chunk);
	}
	return parseJson(Buffer.concat(chunks).toString("utf8"));
}

export class Gateway {
	readonly epoch = randomUUID();
	readonly server: Server;
	readonly sessions: Sessions;
	readonly devices: DeviceStore;
	private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
	private readonly peers = new Set<Peer>();
	private readonly rate = new RateLimit();
	private readonly receipts: Receipts;
	private readonly audit: Audit;
	private readonly config: ServerConfig;
	private readonly unsubscribe: () => void;
	private readonly heartbeat: NodeJS.Timeout;
	private flushTimer?: NodeJS.Timeout;

	constructor(config: ServerConfig, runtime: ManagerRuntime) {
		this.config = config;
		this.sessions = new Sessions(runtime);
		this.devices = new DeviceStore(config.devices);
		this.audit = new Audit(config.auditDir);
		this.receipts = new Receipts((device, receipt) => this.receiptChanged(device, receipt));
		this.server = createServer({ cert: readFileSync(config.cert), key: readFileSync(config.key), minVersion: "TLSv1.2", handshakeTimeout: 10_000 }, (req, res) => {
			void this.request(req, res).catch((error: unknown) => {
				if (res.destroyed) return;
				this.json(res, error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : "Gateway error; check host configuration" });
			});
		});
		this.server.requestTimeout = 10_000;
		this.server.headersTimeout = 10_000;
		this.server.keepAliveTimeout = 5000;
		this.server.maxConnections = 32;
		this.server.on("upgrade", (req, socket, head) => {
			socket.on("error", () => socket.destroy());
			try {
				if (req.url !== "/api/v1/events" || req.headers.origin) throw new ApiError(403, "Native clients only");
				this.limit(req);
				const device = this.devices.authenticate(req.headers.authorization);
				if (this.peers.size >= 16 || [...this.peers].filter((p) => p.device === device.id).length >= 4) throw new ApiError(429, "Too many connections");
				this.sockets.handleUpgrade(req, socket, head, (ws) => this.connect(ws, device.id, req.headers.authorization!));
			} catch (error) {
				const status = error instanceof ApiError ? error.status : 503;
				socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			}
		});
		this.unsubscribe = runtime.subscribe(() => {
			if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; for (const p of this.peers) this.update(p); }, 250);
		});
		this.heartbeat = setInterval(() => {
			this.receipts.prune();
			for (const p of this.peers) {
				if (!p.alive) { p.ws.terminate(); continue; }
				if (!this.authorized(p)) continue;
				p.alive = false;
				p.ws.ping();
				this.send(p, { type: "heartbeat" });
			}
		}, 5000);
	}

	private limit(req: IncomingMessage): void {
		if (!this.rate.allow(`ip:${req.socket.remoteAddress}`, 240)) throw new ApiError(429, "Request rate exceeded");
	}
	private json(res: ServerResponse, status: number, value: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		res.end(JSON.stringify(value));
	}
	private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
		this.limit(req);
		if (req.headers.origin) throw new ApiError(403, "Native clients only");
		const device = this.devices.authenticate(req.headers.authorization);
		const url = new URL(req.url ?? "/", "https://localhost");
		if (url.search) throw new ApiError(400, "Query parameters are not supported");
		const path = url.pathname;
		if (req.method === "GET") {
			let result: unknown;
			if (path === "/api/v1/info") result = { version: API_VERSION, epoch: this.epoch, label: this.config.label, capabilities: ["sessions", "commands", "launch", "g1-display"] };
			else if (path === "/api/v1/sessions") result = { sessions: this.sessions.overview() };
			else if (path === "/api/v1/projects") result = await this.sessions.projects();
			else if (/^\/api\/v1\/projects\/[a-f0-9]{32}\/sessions$/.test(path)) result = { sessions: await this.sessions.history(path.split("/")[4]) };
			else if (/^\/api\/v1\/sessions\/[a-f0-9]{32}$/.test(path)) result = this.sessions.detail(path.split("/")[4]);
			else if (/^\/api\/v1\/commands\/[a-f0-9-]{36}$/.test(path)) result = this.receipts.get(device.id, path.split("/")[4]) ?? { state: "unknown", error: "No receipt in this server epoch; do not replay automatically" };
			else throw new ApiError(404, "Unknown endpoint");
			this.json(res, 200, result); return;
		}
		if (req.method !== "POST") throw new ApiError(405, "Method not allowed");
		if (!this.rate.allow(`commands:${device.id}`, 60)) throw new ApiError(429, "Command rate exceeded");
		const input = await body(req);
		// Revocation during a slow upload must take effect before dispatch as well.
		this.devices.authenticate(req.headers.authorization);
		let receipt: Receipt;
		if (path === "/api/v1/sessions") {
			if (!launchRequest.Check(input)) throw new ApiError(400, "Invalid launch request");
			if (input.epoch !== this.epoch) throw new ApiError(409, "Gateway restarted; refresh, do not replay old actions");
			this.audit.write(device.id, input.projectId, input.sessionRef ? "resume" : "new", "received");
			receipt = this.receipts.submit(device.id, input.requestId, { path, input }, () => this.sessions.launch(input));
		} else if (/^\/api\/v1\/sessions\/[a-f0-9]{32}\/commands$/.test(path)) {
			if (!commandRequest.Check(input)) throw new ApiError(400, "Invalid command request");
			if (input.epoch !== this.epoch) throw new ApiError(409, "Gateway restarted; refresh, do not replay old actions");
			const id = path.split("/")[4];
			this.audit.write(device.id, id, input.command.kind, "received");
			receipt = this.receipts.submit(device.id, input.requestId, { path, input }, () => this.sessions.command(id, input));
		} else throw new ApiError(404, "Unknown endpoint");
		this.json(res, 202, receipt);
	}
	private authorized(p: Peer): boolean {
		try { this.devices.authenticate(p.authorization); return true; }
		catch { p.ws.close(4001, "Device revoked or unavailable"); return false; }
	}
	private connect(ws: WebSocket, device: string, authorization: string): void {
		const p: Peer = { ws, device, authorization, seq: 0, selected: null, overview: "", detail: "", alive: true };
		this.peers.add(p);
		ws.on("error", () => ws.terminate());
		ws.on("close", () => this.peers.delete(p));
		ws.on("pong", () => { p.alive = true; });
		ws.on("message", (data, binary) => {
			try {
				if (binary || !this.rate.allow(`subscribe:${device}`, 120)) throw new ApiError(429, "Subscription rejected");
				const message = parseJson(data.toString());
				if (!subscription.Check(message)) throw new ApiError(400, "Invalid subscription");
				p.selected = message.sessionId; p.detail = "";
				this.update(p);
			} catch { ws.close(1008, "Invalid subscription"); }
		});
		this.update(p);
	}
	private send(p: Peer, value: object): void {
		if (p.ws.readyState !== WebSocket.OPEN) return;
		const data = JSON.stringify({ version: API_VERSION, epoch: this.epoch, seq: ++p.seq, at: Date.now(), ...value });
		if (Buffer.byteLength(data) > MAX_FRAME || p.ws.bufferedAmount > MAX_FRAME) { p.ws.close(1013, "Resynchronise slow client"); return; }
		p.ws.send(data);
	}
	private update(p: Peer): void {
		if (!this.authorized(p)) return;
		const overview = this.sessions.overview();
		const encoded = JSON.stringify(overview);
		if (encoded !== p.overview) { p.overview = encoded; this.send(p, { type: "snapshot", sessions: overview }); }
		if (p.selected) {
			let detail: ReturnType<Sessions["detail"]> | null = null;
			try { detail = this.sessions.detail(p.selected); } catch (error) { if (!(error instanceof ApiError)) throw error; }
			const encoded = JSON.stringify(detail);
			if (encoded !== p.detail) { p.detail = encoded; this.send(p, { type: "detail", id: p.selected, detail }); }
		}
	}
	private receiptChanged(device: string, receipt: Receipt): void {
		this.audit.write(device, receipt.requestId, "result", receipt.state);
		for (const p of this.peers) if (p.device === device && this.authorized(p)) this.send(p, { type: "receipt", receipt });
	}
	listen(port = this.config.port): Promise<void> {
		return new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, this.config.listen, () => { this.server.off("error", reject); resolve(); }); });
	}
	async close(): Promise<void> {
		this.unsubscribe(); clearInterval(this.heartbeat); clearTimeout(this.flushTimer);
		for (const p of this.peers) p.ws.terminate();
		this.sockets.close();
		await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
	}
}
