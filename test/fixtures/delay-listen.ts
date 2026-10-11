// Preload (`node --import`) that makes every listen() start 1.5 s late and say so on stderr, so a test can stop
// `pi-dash-server serve` while its gateway is still starting.
import { Server } from "node:net";

const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
	process.stderr.write("DELAYING listen\n");
	setTimeout(() => listen.apply(this, args as Parameters<typeof listen>), 1500);
	return this;
} as typeof listen;
