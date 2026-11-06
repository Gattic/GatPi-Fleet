// Context windows for sessions whose bridge is gone. pi's own model catalog is the only source;
// an unknown model stays unknown, never a substitute window.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export class ContextWindows {
	private runtime?: ModelRuntime;
	private loading?: Promise<void>;
	private readonly cache = new Map<string, number | null>();

	/** Load the read-only catalog once; no network refresh, so this cannot block on a provider. */
	async load(): Promise<void> {
		if (this.runtime) return;
		if (!this.loading) {
			this.loading = ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })
				.then((runtime) => {
					this.runtime = runtime;
				}, () => {})
				.finally(() => {
					this.loading = undefined;
				});
		}
		await this.loading;
	}

	/** `provider/model` (the usage index's key) → context window, or null while unloaded or unknown. */
	window(model: string): number | null {
		if (!this.runtime) return null;
		const cached = this.cache.get(model);
		if (cached !== undefined) return cached;
		const slash = model.indexOf("/");
		const window = slash > 0 ? this.runtime.getModel(model.slice(0, slash), model.slice(slash + 1))?.contextWindow ?? null : null;
		this.cache.set(model, window);
		return window;
	}
}
