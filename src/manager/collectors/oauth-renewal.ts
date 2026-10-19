/**
 * Renews one stored login so the usage probes can use it; rejects when Pi cannot. It takes no
 * AbortSignal on purpose: once Pi's refresh starts, the provider may already have rotated the
 * refresh token, and abandoning the call before it is persisted would destroy the login.
 */
export type RenewLogin = (authFile: string, provider: string) => Promise<void>;

/**
 * Pi owns OAuth. Resolving a provider's auth through Pi's own runtime refreshes an expired token
 * under auth.json's lock, re-checks inside that lock and persists the rotated refresh token, so
 * Pi sessions and other dashboards cannot race this refresh. Pi bounds the lock wait (30 s) and the
 * token request (15 s) itself. The runtime is loaded lazily: it is needed only when a login has
 * expired. It loads no extensions, so providers an extension registers (the multi-login
 * `anthropic-account-N` aliases) are unknown to it, resolve to nothing and stay expired; Pi renews
 * those when a session uses the account.
 */
export const renewLoginWithPi: RenewLogin = async (authFile, provider) => {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({ authPath: authFile, modelsPath: null, refreshOnCreate: false });
	await runtime.getAuth(provider);
};
