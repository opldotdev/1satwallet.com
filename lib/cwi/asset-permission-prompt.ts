import {
	isTransactionPrompt,
	type PromptHandler,
	type PromptRequest,
	type VerificationServices,
	verifyIntent,
} from "@1sat/permission-module";

let activeHandler: PromptHandler | null = null;

/** Routes built-in wallet asset reviews to the active hosted-CWI relay. */
export const requestAssetPermission: PromptHandler = (request) =>
	activeHandler?.(request) ?? Promise.resolve(false);

export function bindAssetPermissionPromptHandler(
	handler: PromptHandler,
): () => void {
	activeHandler = handler;
	return () => {
		if (activeHandler === handler) activeHandler = null;
	};
}

/** Re-checks live overlay facts at the moment the user approves. */
export async function canApproveAssetPermission(
	request: PromptRequest,
	services: VerificationServices,
): Promise<{ allowed: boolean; reason?: string }> {
	if (
		request.kind !== "transaction" ||
		!isTransactionPrompt(request.payload) ||
		!request.payload.trust ||
		!request.payload.verify
	) {
		return { allowed: true };
	}

	const result = await verifyIntent(
		services,
		request.payload.verify.kind,
		request.payload.verify.inputs,
		request.payload.verify.outputs,
		services.ordfs?.getContentUrl?.bind(services.ordfs),
	);
	return result.state === "mismatch"
		? {
				allowed: false,
				reason:
					result.note ??
					"Live asset verification no longer matches this request.",
			}
		: { allowed: true };
}
