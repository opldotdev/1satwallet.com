/**
 * Chrome's permission for reaching apps on this device (BRC-325 section 3).
 *
 * Since Chrome 142 a request to a localhost wallet raises a browser dialog the
 * site cannot word, and a "Block" there is permanent for this origin. So the
 * state is read before anything touches localhost:
 *
 * - unsupported: the browser has no such permission; probing raises nothing.
 * - exempt: this page is itself served from localhost; no dialog appears.
 * - granted: probe freely.
 * - prompt: probe only after the user asked for it (see discovery.ts).
 * - denied: never probe; show how to allow it again.
 */
export type LoopbackPermission =
	| "unsupported"
	| "exempt"
	| "granted"
	| "prompt"
	| "denied";

type PermissionQuery = (descriptor: {
	name: string;
}) => Promise<Pick<PermissionStatus, "state"> & Partial<EventTarget>>;

/** The current name first; Chrome before the split exposes only the combined one. */
const DESCRIPTOR_NAMES = ["loopback-network", "local-network-access"] as const;

export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

export type LoopbackPermissionRead = {
	state: LoopbackPermission;
	/** Present when the browser can report changes (BRC-325 section 3.5). */
	status?: Partial<EventTarget>;
};

export async function readLoopbackPermission(
	deps: { hostname?: string; query?: PermissionQuery | null } = {},
): Promise<LoopbackPermissionRead> {
	const hostname =
		deps.hostname ??
		(typeof window === "undefined" ? "" : window.location.hostname);
	if (isLoopbackHost(hostname)) return { state: "exempt" };
	const query =
		deps.query === undefined ? defaultQuery() : (deps.query ?? null);
	if (!query) return { state: "unsupported" };
	for (const name of DESCRIPTOR_NAMES) {
		try {
			const status = await query({ name });
			const state = status.state;
			if (state === "granted" || state === "prompt" || state === "denied") {
				return { state, status };
			}
			console.warn(
				`[wallet-discovery] ${name} permission reported an unknown state`,
				state,
			);
			return { state: "unsupported" };
		} catch (error) {
			// An unknown descriptor name rejects with a TypeError: this browser
			// lacks that permission. Anything else is a real failure.
			if (error instanceof TypeError) continue;
			console.error(
				`[wallet-discovery] reading the ${name} permission failed`,
				error,
			);
			return { state: "unsupported" };
		}
	}
	return { state: "unsupported" };
}

function defaultQuery(): PermissionQuery | null {
	if (typeof navigator === "undefined" || !navigator.permissions?.query) {
		return null;
	}
	const permissions = navigator.permissions;
	return (descriptor) =>
		permissions.query(descriptor as unknown as PermissionDescriptor);
}

/**
 * Calls back whenever the permission may have changed: the browser's own change
 * event, and the page becoming visible again after a trip to site settings.
 */
export function watchLoopbackPermission(
	onChange: () => void,
	status?: Partial<EventTarget>,
): () => void {
	const onVisible = () => {
		if (document.visibilityState === "visible") onChange();
	};
	status?.addEventListener?.("change", onChange);
	document.addEventListener("visibilitychange", onVisible);
	return () => {
		status?.removeEventListener?.("change", onChange);
		document.removeEventListener("visibilitychange", onVisible);
	};
}
