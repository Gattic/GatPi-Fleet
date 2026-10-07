import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError } from "./contract.ts";

export interface Device { id: string; name: string; hash: string; createdAt: number }
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class DeviceStore {
	readonly path: string;
	constructor(path: string) { this.path = path; }
	list(): Device[] {
		if (!existsSync(this.path)) return [];
		const stat = statSync(this.path);
		if ((stat.mode & 0o077) !== 0 || stat.size > 64_000) throw new Error("Device file must be private and bounded");
		const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
		if (!Array.isArray(data) || data.length > 32 || data.some((d) => !d || typeof d.id !== "string" || typeof d.name !== "string" || !/^[a-f0-9]{64}$/.test(d.hash) || !Number.isFinite(d.createdAt))) throw new Error("Invalid device file");
		return data;
	}
	authenticate(authorization: string | undefined): Device {
		const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
		if (!token) throw new ApiError(401, "Pair this device with the host");
		let devices: Device[];
		try { devices = this.list(); } catch { throw new ApiError(503, "Device credentials unavailable; check host configuration"); }
		const candidate = Buffer.from(digest(token), "hex");
		const device = devices.find((d) => timingSafeEqual(Buffer.from(d.hash, "hex"), candidate));
		if (!device) throw new ApiError(401, "Device token invalid or revoked");
		return device;
	}
	private update(change: (devices: Device[]) => Device[]): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const lock = `${this.path}.lock`;
		const fd = openSync(lock, "wx", 0o600);
		const tmp = `${this.path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(change(this.list()), null, 2) + "\n", { mode: 0o600, flag: "wx" });
			renameSync(tmp, this.path);
		} finally {
			closeSync(fd);
			unlinkSync(lock);
			if (existsSync(tmp)) unlinkSync(tmp);
		}
	}
	pair(name: string): { device: Device; token: string } {
		if (!name.trim() || name.length > 80) throw new Error("Device name must be 1–80 characters");
		const token = randomBytes(32).toString("base64url");
		const device = { id: randomUUID(), name: name.trim(), hash: digest(token), createdAt: Date.now() };
		this.update((devices) => { if (devices.length >= 32) throw new Error("Revoke a device before pairing more"); return [...devices, device]; });
		return { device, token };
	}
	revoke(id: string): void {
		this.update((devices) => {
			if (!devices.some((d) => d.id === id)) throw new Error("Unknown device ID");
			return devices.filter((d) => d.id !== id);
		});
	}
}
