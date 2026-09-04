import { Hash, Utils } from "@bsv/sdk";
import { v } from "convex/values";
import {
	isIdentityKey,
	type P2PCommand,
	verifyP2PCommand,
} from "../lib/p2p-auth";
import {
	assertParticipantBinding,
	assertSettlementState,
	bodyRecord,
	buildLockedOfferCommitment,
	MAX_SETTLEMENT_TTL_MS,
	parseNonNegativeDecimal,
	parsePositiveUint64,
	parseSafeInteger,
	parseSettlementCommandPayload,
	parseSettlementHash,
	parseSettlementIdentity,
	parseSettlementOutpoint,
	parseSettlementUuid,
	SETTLEMENT_PROTOCOL,
	SETTLEMENT_RETENTION_MS,
	SETTLEMENT_WIRE_VERSION,
	type SettlementAction,
	type SettlementBinding,
	type SettlementCommandPayload,
	type SettlementStatus,
	settlementDigest,
	settlementStatusAfterEvidence,
	settlementStatusAfterInternalization,
	settlementStatusAfterTimeout,
} from "../lib/p2p-settlement";
import type { Doc } from "./_generated/dataModel";
import {
	env,
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";

const { toHex } = Utils;
const signedArgs = { body: v.string(), signature: v.string() };
const MAX_CONTRIBUTION_INPUTS = 64;
const MAX_DESTINATIONS = 32;
const MAX_MANIFEST_INPUTS = 96;
const MAX_MANIFEST_OUTPUTS = 96;

type SettlementDoc = Doc<"p2pSettlements">;
type ParticipantRole = "partyA" | "partyB";

function array(value: unknown, field: string, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) {
		throw new Error(`Invalid ${field}`);
	}
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Invalid ${field}`);
	return value;
}

function boundedText(value: unknown, field: string, limit = 512): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > limit ||
		value.trim() !== value
	) {
		throw new Error(`Invalid ${field}`);
	}
	return value;
}

function canonicalHex(value: unknown, field: string, limit: number): string {
	const result = boundedText(value, field, limit);
	if (
		result.length % 2 !== 0 ||
		result.toLowerCase() !== result ||
		!/^[0-9a-f]+$/.test(result)
	) {
		throw new Error(`Invalid ${field}`);
	}
	return result;
}

function binding(settlement: SettlementDoc): SettlementBinding {
	return {
		chain: settlement.chain,
		sessionId: settlement.sessionId,
		settlementId: settlement.settlementId,
		attempt: settlement.attempt,
		offerDigest: settlement.offerDigest,
		lockedInitiatorRevision: settlement.lockedInitiatorRevision,
		lockedParticipantRevision: settlement.lockedParticipantRevision,
		partyA: settlement.partyA,
		partyB: settlement.partyB,
		builder: settlement.builder,
		feePayer: settlement.feePayer,
		expiresAt: settlement.expiresAt,
		lastPartyARevision: settlement.lastPartyARevision,
		lastPartyBRevision: settlement.lastPartyBRevision,
	};
}

function revisionPatch(role: ParticipantRole, revision: number) {
	return role === "partyA"
		? { lastPartyARevision: revision }
		: { lastPartyBRevision: revision };
}

function roleValue<T>(
	role: ParticipantRole,
	partyA: T | undefined,
	partyB: T | undefined,
): T | undefined {
	return role === "partyA" ? partyA : partyB;
}

async function settlementByAttempt(
	ctx: MutationCtx | QueryCtx,
	settlementId: string,
	attempt: number,
) {
	return ctx.db
		.query("p2pSettlements")
		.withIndex("by_settlement_attempt", (q) =>
			q.eq("settlementId", settlementId).eq("attempt", attempt),
		)
		.first();
}

async function sessionById(ctx: MutationCtx | QueryCtx, sessionId: string) {
	return ctx.db
		.query("p2pSessions")
		.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
		.first();
}

function replayLocator(
	body: string,
): { identityKey: string; nonce: string } | null {
	try {
		const value = JSON.parse(body) as Record<string, unknown>;
		return isIdentityKey(value.identityKey) && typeof value.nonce === "string"
			? { identityKey: value.identityKey.toLowerCase(), nonce: value.nonce }
			: null;
	} catch {
		return null;
	}
}

async function runSignedSettlement<T>(
	ctx: MutationCtx,
	action: SettlementAction,
	body: string,
	signature: string,
	execute: (
		command: P2PCommand,
		payload: SettlementCommandPayload,
		now: number,
	) => Promise<T>,
): Promise<T> {
	const bodyHash = toHex(Hash.sha256(body, "utf8"));
	const signatureHash = toHex(Hash.sha256(signature, "utf8"));
	const locator = replayLocator(body);
	if (locator) {
		const previous = await ctx.db
			.query("p2pCommands")
			.withIndex("by_identity_nonce", (q) =>
				q.eq("identityKey", locator.identityKey).eq("nonce", locator.nonce),
			)
			.first();
		if (previous) {
			if (
				previous.action !== action ||
				previous.bodyHash !== bodyHash ||
				previous.signatureHash !== signatureHash
			) {
				throw new Error("Signed command nonce was already used");
			}
			return JSON.parse(previous.result) as T;
		}
	}
	const now = Date.now();
	const command = verifyP2PCommand({ body, signature }, action, now);
	const payload = parseSettlementCommandPayload(command.payload, now);
	const result = await execute(command, payload, now);
	await ctx.db.insert("p2pCommands", {
		identityKey: command.identityKey,
		nonce: command.nonce,
		action,
		bodyHash,
		signatureHash,
		result: JSON.stringify(result ?? null),
		createdAt: now,
		// Ambiguous post-signature outcomes have no safe time-based terminal.
		// Their replay records live with the settlement and are removed only
		// after an evidence-backed terminal state receives a purge deadline.
		expiresAt: Number.MAX_SAFE_INTEGER,
		settlementId: payload.settlementId,
		settlementAttempt: payload.attempt,
	});
	return result;
}

function configuredChain(): "main" | "test" {
	return (env as Record<string, string | undefined>).P2P_SETTLEMENT_CHAIN ===
		"test"
		? "test"
		: "main";
}

function configuredVerifier(): string {
	const identity = (env as Record<string, string | undefined>)
		.P2P_SETTLEMENT_VERIFIER_IDENTITY;
	if (!identity) {
		throw new Error("Settlement evidence verifier is not configured");
	}
	return parseSettlementIdentity(identity, "settlement evidence verifier");
}

function assertInitialParticipants(
	payload: SettlementCommandPayload,
	signer: string,
	partyA: string,
	partyB: string,
): ParticipantRole {
	if (payload.sender !== signer) {
		throw new Error("Settlement sender does not match the BRC-77 signer");
	}
	const role =
		signer === partyA ? "partyA" : signer === partyB ? "partyB" : null;
	if (!role) throw new Error("Settlement signer is not a participant");
	const peer = role === "partyA" ? partyB : partyA;
	if (payload.recipient !== peer) {
		throw new Error("Settlement recipient is not the fixed counterparty");
	}
	return role;
}

function parsePrepare(value: unknown, signer: string) {
	const body = bodyRecord(
		value,
		["walletIdentity", "providerInstanceId", "capabilities"],
		"Invalid settlement prepare",
	);
	const walletIdentity = parseSettlementIdentity(
		body.walletIdentity,
		"wallet identity",
	);
	if (walletIdentity !== signer) {
		throw new Error("Prepared wallet identity does not match the signer");
	}
	const capabilities = bodyRecord(
		body.capabilities,
		[
			"exactTemplateReview",
			"externalInputSignature",
			"localReservationLease",
			"internalizeAction",
		],
		"Invalid settlement capabilities",
	);
	for (const capability of Object.values(capabilities)) {
		if (capability !== true) {
			throw new Error("Settlement v1 requires every wallet capability");
		}
	}
	return {
		walletIdentity,
		providerInstanceId: parseSettlementUuid(
			body.providerInstanceId,
			"provider instance",
		),
		prepareHash: settlementDigest(body),
	};
}

function parseContribution(value: unknown, expiresAt: number, now: number) {
	const body = bodyRecord(
		value,
		[
			"reservationId",
			"reservationExpiresAt",
			"inputs",
			"destinations",
			"contributionHash",
		],
		"Invalid settlement contribution",
	);
	const inputs = array(
		body.inputs,
		"contribution inputs",
		MAX_CONTRIBUTION_INPUTS,
	).map((value) => {
		const input = bodyRecord(
			value,
			[
				"outpoint",
				"purpose",
				"tokenId",
				"tokenAmount",
				"sourceSatoshis",
				"sourceScriptHash",
				"sourceBeefHash",
			],
			"Invalid contribution input",
		);
		if (input.purpose !== "ordinal" && input.purpose !== "bsv21") {
			throw new Error("Invalid contribution input purpose");
		}
		const common = {
			outpoint: parseSettlementOutpoint(input.outpoint, "input outpoint"),
			purpose: input.purpose,
			sourceSatoshis: parseNonNegativeDecimal(
				input.sourceSatoshis,
				"input source satoshis",
			),
			sourceScriptHash: parseSettlementHash(
				input.sourceScriptHash,
				"sourceScriptHash",
			),
			sourceBeefHash: parseSettlementHash(
				input.sourceBeefHash,
				"sourceBeefHash",
			),
		};
		if (input.purpose === "ordinal") {
			if (input.tokenId !== undefined || input.tokenAmount !== undefined) {
				throw new Error("Ordinal contribution has token fields");
			}
			return common;
		}
		return {
			...common,
			tokenId: parseSettlementOutpoint(input.tokenId, "input token ID"),
			tokenAmount: parsePositiveUint64(input.tokenAmount, "input token amount"),
		};
	});
	const destinations = array(
		body.destinations,
		"contribution destinations",
		MAX_DESTINATIONS,
	).map((value) => {
		const destination = bodyRecord(
			value,
			[
				"legIndex",
				"purpose",
				"lockingScript",
				"satoshis",
				"tokenId",
				"tokenAmount",
				"destinationProof",
			],
			"Invalid contribution destination",
		);
		if (
			destination.purpose !== "ordinal-receipt" &&
			destination.purpose !== "bsv21-receipt" &&
			destination.purpose !== "bsv-payment"
		) {
			throw new Error("Invalid contribution destination purpose");
		}
		const result: Record<string, unknown> = {
			legIndex: parseSafeInteger(destination.legIndex, "destination leg index"),
			purpose: destination.purpose,
			lockingScript: canonicalHex(
				destination.lockingScript,
				"destination locking script",
				20_000,
			),
			satoshis: parseNonNegativeDecimal(
				destination.satoshis,
				"destination satoshis",
			),
			destinationProof: boundedText(
				destination.destinationProof,
				"destination proof",
				2_048,
			),
		};
		if (destination.purpose === "bsv21-receipt") {
			result.tokenId = parseSettlementOutpoint(
				destination.tokenId,
				"destination token ID",
			);
			result.tokenAmount = parsePositiveUint64(
				destination.tokenAmount,
				"destination token amount",
			);
		} else if (
			destination.tokenId !== undefined ||
			destination.tokenAmount !== undefined
		) {
			throw new Error("Non-token destination has token fields");
		}
		return result;
	});
	const reservationExpiresAt = parseSafeInteger(
		body.reservationExpiresAt,
		"reservation expiry",
		1,
	);
	if (reservationExpiresAt <= now || reservationExpiresAt > expiresAt) {
		throw new Error("Reservation does not cover the current settlement");
	}
	const committed = {
		reservationId: parseSettlementUuid(body.reservationId, "reservationId"),
		reservationExpiresAt,
		inputs,
		destinations,
	};
	const contributionHash = parseSettlementHash(
		body.contributionHash,
		"contributionHash",
	);
	if (contributionHash !== settlementDigest(committed)) {
		throw new Error("Contribution hash does not match its contents");
	}
	const inputOutpoints = new Set(inputs.map((input) => input.outpoint));
	if (inputOutpoints.size !== inputs.length) {
		throw new Error("Contribution repeats an input outpoint");
	}
	const destinationLegs = new Set(
		destinations.map((destination) => destination.legIndex as number),
	);
	if (destinationLegs.size !== destinations.length) {
		throw new Error("Contribution repeats a destination leg");
	}
	return { ...committed, contributionHash };
}

type ParsedContribution = ReturnType<typeof parseContribution>;

function validateContributionAgainstLockedOffer(
	contribution: ParsedContribution,
	settlement: SettlementDoc,
	role: ParticipantRole,
	session: Doc<"p2pSessions">,
) {
	const owner = role === "partyA" ? settlement.partyA : settlement.partyB;
	const ownerIsInitiator = session.initiatorIdentity === owner;
	if (!ownerIsInitiator && session.participantIdentity !== owner) {
		throw new Error("Contribution owner is not in the locked session");
	}
	const outgoing = ownerIsInitiator
		? session.initiatorItems
		: session.participantItems;
	const incoming = ownerIsInitiator
		? session.participantItems
		: session.initiatorItems;
	const ordinalInputs = new Set(
		contribution.inputs
			.filter((input) => input.purpose === "ordinal")
			.map((input) => input.outpoint),
	);
	const offeredOrdinals = outgoing
		.filter((item) => item.type === "ordinal")
		.map((item) => item.id);
	if (
		ordinalInputs.size !== offeredOrdinals.length ||
		offeredOrdinals.some((outpoint) => !ordinalInputs.has(outpoint))
	) {
		throw new Error("Ordinal contribution does not match the locked offer");
	}
	const offeredTokens = new Map(
		outgoing
			.filter((item) => item.type === "bsv21")
			.map((item) => [item.id, BigInt(item.amount)]),
	);
	const contributedTokens = new Map<string, bigint>();
	for (const input of contribution.inputs) {
		if (input.purpose !== "bsv21") continue;
		const tokenId = "tokenId" in input ? input.tokenId : undefined;
		const tokenAmount = "tokenAmount" in input ? input.tokenAmount : undefined;
		if (
			typeof tokenId !== "string" ||
			typeof tokenAmount !== "string" ||
			!offeredTokens.has(tokenId)
		) {
			throw new Error("BSV21 contribution names an unoffered token");
		}
		const total = (contributedTokens.get(tokenId) ?? 0n) + BigInt(tokenAmount);
		if (total > 18_446_744_073_709_551_615n) {
			throw new Error("BSV21 contribution quantity overflows uint64");
		}
		contributedTokens.set(tokenId, total);
	}
	for (const [tokenId, amount] of offeredTokens) {
		if ((contributedTokens.get(tokenId) ?? 0n) < amount) {
			throw new Error("BSV21 contribution underfunds the locked offer");
		}
	}
	if (contributedTokens.size !== offeredTokens.size) {
		throw new Error("BSV21 contribution does not match the locked offer");
	}
	if (contribution.destinations.length !== incoming.length) {
		throw new Error(
			"Contribution destinations do not cover every incoming leg",
		);
	}
	for (let legIndex = 0; legIndex < incoming.length; legIndex += 1) {
		const item = incoming[legIndex];
		const destination = contribution.destinations.find(
			(candidate) => candidate.legIndex === legIndex,
		);
		if (!destination) {
			throw new Error("Contribution destination leg is missing");
		}
		switch (item.type) {
			case "ordinal":
				if (
					destination.purpose !== "ordinal-receipt" ||
					destination.satoshis !== "1"
				) {
					throw new Error(
						"Ordinal destination does not match the locked offer",
					);
				}
				break;
			case "bsv21":
				if (
					destination.purpose !== "bsv21-receipt" ||
					destination.satoshis !== "1" ||
					destination.tokenId !== item.id ||
					destination.tokenAmount !== item.amount
				) {
					throw new Error("BSV21 destination does not match the locked offer");
				}
				break;
			case "satoshis":
				if (
					destination.purpose !== "bsv-payment" ||
					destination.satoshis !== String(item.satoshis)
				) {
					throw new Error("BSV destination does not match the locked offer");
				}
				break;
		}
	}
}

function parseManifest(
	value: unknown,
	payload: SettlementCommandPayload,
	settlement: SettlementDoc,
) {
	const manifest = bodyRecord(
		value,
		[
			"protocol",
			"version",
			"chain",
			"sessionId",
			"settlementId",
			"attempt",
			"offerDigest",
			"builder",
			"expiresAt",
			"unsignedTxHash",
			"inputs",
			"outputs",
			"overlayPolicies",
		],
		"Invalid settlement manifest",
	);
	if (
		manifest.protocol !== SETTLEMENT_PROTOCOL ||
		manifest.version !== SETTLEMENT_WIRE_VERSION ||
		manifest.chain !== payload.chain ||
		manifest.sessionId !== payload.sessionId ||
		manifest.settlementId !== payload.settlementId ||
		manifest.attempt !== payload.attempt ||
		manifest.offerDigest !== payload.offerDigest ||
		manifest.builder !== payload.builder ||
		manifest.expiresAt !== payload.expiresAt
	) {
		throw new Error("Transaction manifest binding does not match");
	}
	parseSettlementHash(manifest.unsignedTxHash, "unsignedTxHash");
	const inputIndexes = new Set<number>();
	const inputOutpoints = new Set<string>();
	const partyAInputIndexes: number[] = [];
	const partyBInputIndexes: number[] = [];
	const ordinalInputOutpoints = new Set<string>();
	const tokenInputTotals = new Map<string, bigint>();
	for (const value of array(
		manifest.inputs,
		"manifest inputs",
		MAX_MANIFEST_INPUTS,
	)) {
		const input = bodyRecord(
			value,
			[
				"index",
				"outpoint",
				"owner",
				"purpose",
				"tokenId",
				"tokenAmount",
				"sourceSatoshis",
				"sourceScriptHash",
			],
			"Invalid manifest input",
		);
		const index = parseSafeInteger(input.index, "manifest input index");
		const outpoint = parseSettlementOutpoint(
			input.outpoint,
			"manifest input outpoint",
		);
		if (inputIndexes.has(index) || inputOutpoints.has(outpoint)) {
			throw new Error("Duplicate manifest input");
		}
		inputIndexes.add(index);
		inputOutpoints.add(outpoint);
		if (
			input.owner !== "builder-funding" &&
			input.owner !== settlement.partyA &&
			input.owner !== settlement.partyB
		) {
			throw new Error("Invalid manifest input owner");
		}
		if (
			input.purpose !== "ordinal" &&
			input.purpose !== "bsv21" &&
			input.purpose !== "bsv-funding"
		) {
			throw new Error("Invalid manifest input purpose");
		}
		if (
			(input.owner === "builder-funding") !==
			(input.purpose === "bsv-funding")
		) {
			throw new Error("Manifest funding input role does not match its purpose");
		}
		const sourceSatoshis = parseNonNegativeDecimal(
			input.sourceSatoshis,
			"manifest source satoshis",
		);
		parseSettlementHash(input.sourceScriptHash, "manifest source script hash");
		if (input.purpose === "bsv21") {
			const tokenId = parseSettlementOutpoint(
				input.tokenId,
				"manifest input token ID",
			);
			const tokenAmount = parsePositiveUint64(
				input.tokenAmount,
				"manifest input token amount",
			);
			const total = (tokenInputTotals.get(tokenId) ?? 0n) + BigInt(tokenAmount);
			if (total > 18_446_744_073_709_551_615n) {
				throw new Error("Manifest BSV21 input quantity overflows uint64");
			}
			tokenInputTotals.set(tokenId, total);
		} else if (input.tokenId !== undefined || input.tokenAmount !== undefined) {
			throw new Error("Non-token manifest input has token fields");
		}
		if (input.purpose === "ordinal") {
			if (sourceSatoshis === "0") {
				throw new Error("Ordinal input cannot have zero satoshis");
			}
			ordinalInputOutpoints.add(outpoint);
		}
		if (input.owner === settlement.partyA) partyAInputIndexes.push(index);
		if (input.owner === settlement.partyB) partyBInputIndexes.push(index);
	}
	if (
		inputIndexes.size === 0 ||
		Array.from(inputIndexes).some((index) => index >= inputIndexes.size)
	) {
		throw new Error("Manifest input indexes must be contiguous");
	}
	const outputIndexes = new Set<number>();
	const outputTokenIds = new Set<string>();
	const tokenOutputTotals = new Map<string, bigint>();
	const tokenOutputCounts = new Map<string, number>();
	const ordinalReceiptSources = new Set<string>();
	const overlayFeeSatoshis: string[] = [];
	for (const value of array(
		manifest.outputs,
		"manifest outputs",
		MAX_MANIFEST_OUTPUTS,
	)) {
		const output = bodyRecord(
			value,
			[
				"index",
				"owner",
				"purpose",
				"satoshis",
				"scriptHash",
				"tokenId",
				"tokenAmount",
				"sourceOrdinal",
			],
			"Invalid manifest output",
		);
		const index = parseSafeInteger(output.index, "manifest output index");
		if (outputIndexes.has(index)) throw new Error("Duplicate manifest output");
		outputIndexes.add(index);
		if (
			output.purpose !== "ordinal-receipt" &&
			output.purpose !== "bsv21-receipt" &&
			output.purpose !== "bsv21-change" &&
			output.purpose !== "bsv-payment" &&
			output.purpose !== "overlay-fee" &&
			output.purpose !== "builder-change"
		) {
			throw new Error("Invalid manifest output purpose");
		}
		const ordinaryOwner =
			output.owner === settlement.partyA || output.owner === settlement.partyB;
		if (
			(output.purpose === "overlay-fee" && output.owner !== "overlay-fee") ||
			(output.purpose === "builder-change" &&
				output.owner !== "builder-change") ||
			(output.purpose !== "overlay-fee" &&
				output.purpose !== "builder-change" &&
				!ordinaryOwner)
		) {
			throw new Error("Manifest output owner does not match its purpose");
		}
		parseNonNegativeDecimal(output.satoshis, "manifest output satoshis");
		parseSettlementHash(output.scriptHash, "manifest output script hash");
		if (
			output.purpose === "bsv21-receipt" ||
			output.purpose === "bsv21-change"
		) {
			const tokenId = parseSettlementOutpoint(
				output.tokenId,
				"manifest output token ID",
			);
			outputTokenIds.add(tokenId);
			const tokenAmount = parsePositiveUint64(
				output.tokenAmount,
				"manifest output token amount",
			);
			const total =
				(tokenOutputTotals.get(tokenId) ?? 0n) + BigInt(tokenAmount);
			if (total > 18_446_744_073_709_551_615n) {
				throw new Error("Manifest BSV21 output quantity overflows uint64");
			}
			tokenOutputTotals.set(tokenId, total);
			tokenOutputCounts.set(tokenId, (tokenOutputCounts.get(tokenId) ?? 0) + 1);
		} else if (
			output.tokenId !== undefined ||
			output.tokenAmount !== undefined
		) {
			throw new Error("Non-token manifest output has token fields");
		}
		if (output.purpose === "ordinal-receipt") {
			const sourceOrdinal = parseSettlementOutpoint(
				output.sourceOrdinal,
				"manifest source ordinal",
			);
			if (ordinalReceiptSources.has(sourceOrdinal)) {
				throw new Error("Manifest repeats an ordinal receipt");
			}
			ordinalReceiptSources.add(sourceOrdinal);
		} else if (output.sourceOrdinal !== undefined) {
			throw new Error("Non-ordinal output has a source ordinal");
		}
		if (output.purpose === "overlay-fee") {
			const satoshis = parseNonNegativeDecimal(
				output.satoshis,
				"overlay fee satoshis",
			);
			if (satoshis === "0") {
				throw new Error("Zero-satoshi overlay fee is forbidden");
			}
			overlayFeeSatoshis.push(satoshis);
		}
	}
	if (
		outputIndexes.size === 0 ||
		Array.from(outputIndexes).some((index) => index >= outputIndexes.size)
	) {
		throw new Error("Manifest output indexes must be contiguous");
	}
	const overlayTokenIds: string[] = [];
	for (const value of array(manifest.overlayPolicies, "overlay policies", 32)) {
		const policy = bodyRecord(
			value,
			[
				"tokenId",
				"statusCheckedAt",
				"feeAddress",
				"feePerOutput",
				"countedOutputs",
				"totalFee",
			],
			"Invalid overlay policy",
		);
		const tokenId = parseSettlementOutpoint(policy.tokenId, "overlay token ID");
		if (overlayTokenIds.includes(tokenId))
			throw new Error("Duplicate overlay policy");
		overlayTokenIds.push(tokenId);
		parseSafeInteger(policy.statusCheckedAt, "overlay status time", 1);
		boundedText(policy.feeAddress, "overlay fee address", 128);
		const feePerOutput = parseNonNegativeDecimal(
			policy.feePerOutput,
			"overlay fee per output",
		);
		const countedOutputs = parseSafeInteger(
			policy.countedOutputs,
			"overlay counted outputs",
		);
		const totalFee = parseNonNegativeDecimal(
			policy.totalFee,
			"overlay total fee",
		);
		if (BigInt(feePerOutput) * BigInt(countedOutputs) !== BigInt(totalFee)) {
			throw new Error("Overlay fee total does not match");
		}
		if (countedOutputs !== (tokenOutputCounts.get(tokenId) ?? 0)) {
			throw new Error(
				"Overlay policy output count does not match the template",
			);
		}
	}
	const sortedOverlayTokenIds = [...overlayTokenIds].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	if (
		overlayTokenIds.some(
			(tokenId, index) => tokenId !== sortedOverlayTokenIds[index],
		)
	) {
		throw new Error("Overlay policies must be sorted by token ID");
	}
	if (
		overlayTokenIds.length !== outputTokenIds.size ||
		overlayTokenIds.some((tokenId) => !outputTokenIds.has(tokenId))
	) {
		throw new Error("Overlay policies do not cover every BSV21 output");
	}
	if (
		tokenInputTotals.size !== tokenOutputTotals.size ||
		Array.from(tokenInputTotals).some(
			([tokenId, amount]) => tokenOutputTotals.get(tokenId) !== amount,
		)
	) {
		throw new Error("Manifest does not conserve BSV21 quantities exactly");
	}
	if (
		ordinalInputOutpoints.size !== ordinalReceiptSources.size ||
		Array.from(ordinalInputOutpoints).some(
			(outpoint) => !ordinalReceiptSources.has(outpoint),
		)
	) {
		throw new Error("Manifest does not map every ordinal input exactly once");
	}
	const expectedOverlayFees = array(
		manifest.overlayPolicies,
		"overlay policies",
		32,
	)
		.map((value) =>
			parseNonNegativeDecimal(
				(value as Record<string, unknown>).totalFee,
				"overlay total fee",
			),
		)
		.filter((satoshis) => satoshis !== "0")
		.sort();
	overlayFeeSatoshis.sort();
	if (
		overlayFeeSatoshis.length !== expectedOverlayFees.length ||
		overlayFeeSatoshis.some(
			(satoshis, index) => satoshis !== expectedOverlayFees[index],
		)
	) {
		throw new Error("Overlay fee outputs do not match committed policies");
	}
	partyAInputIndexes.sort((left, right) => left - right);
	partyBInputIndexes.sort((left, right) => left - right);
	return {
		manifestHash: settlementDigest(manifest),
		overlayTokenIds,
		partyAInputIndexes,
		partyBInputIndexes,
	};
}

function parseAuthorization(value: unknown, expiresAt: number, now: number) {
	const body = bodyRecord(
		value,
		[
			"offerDigest",
			"templateHash",
			"contributionHash",
			"authorizedInputs",
			"authorizationExpiresAt",
		],
		"Invalid settlement authorization",
	);
	const indexes = new Set<number>();
	const authorizedInputs = array(
		body.authorizedInputs,
		"authorized inputs",
		MAX_CONTRIBUTION_INPUTS,
	).map((value) => {
		const input = bodyRecord(
			value,
			["inputIndex", "unlockingScriptHash"],
			"Invalid authorized input",
		);
		const inputIndex = parseSafeInteger(
			input.inputIndex,
			"authorized input index",
		);
		if (indexes.has(inputIndex)) throw new Error("Duplicate authorized input");
		indexes.add(inputIndex);
		return {
			inputIndex,
			unlockingScriptHash: parseSettlementHash(
				input.unlockingScriptHash,
				"unlockingScriptHash",
			),
		};
	});
	for (let index = 1; index < authorizedInputs.length; index += 1) {
		if (
			authorizedInputs[index - 1].inputIndex >=
			authorizedInputs[index].inputIndex
		) {
			throw new Error("Authorized inputs must be sorted by input index");
		}
	}
	const authorizationExpiresAt = parseSafeInteger(
		body.authorizationExpiresAt,
		"authorization expiry",
		1,
	);
	if (authorizationExpiresAt <= now || authorizationExpiresAt > expiresAt) {
		throw new Error("Invalid authorization expiry");
	}
	const committed = {
		offerDigest: parseSettlementHash(
			body.offerDigest,
			"authorization offerDigest",
		),
		templateHash: parseSettlementHash(
			body.templateHash,
			"authorization templateHash",
		),
		contributionHash: parseSettlementHash(
			body.contributionHash,
			"authorization contributionHash",
		),
		authorizedInputs,
		authorizationExpiresAt,
	};
	return { ...committed, authorizationHash: settlementDigest(committed) };
}

function assertVerifierBinding(
	payload: SettlementCommandPayload,
	settlement: SettlementDoc,
	command: P2PCommand,
) {
	const verifier = configuredVerifier();
	if (command.identityKey !== verifier || payload.sender !== verifier) {
		throw new Error(
			"Settlement evidence signer is not the configured verifier",
		);
	}
	if (payload.recipient !== settlement.builder) {
		throw new Error("Settlement evidence recipient must be the builder");
	}
	const expected = binding(settlement);
	if (
		payload.chain !== expected.chain ||
		payload.sessionId !== expected.sessionId ||
		payload.settlementId !== expected.settlementId ||
		payload.attempt !== expected.attempt ||
		payload.offerDigest !== expected.offerDigest ||
		payload.lockedOfferVersion.initiatorRevision !==
			expected.lockedInitiatorRevision ||
		payload.lockedOfferVersion.participantRevision !==
			expected.lockedParticipantRevision ||
		payload.builder !== expected.builder ||
		payload.feePayer !== expected.feePayer ||
		payload.expiresAt !== expected.expiresAt
	) {
		throw new Error("Settlement evidence binding does not match");
	}
	if (payload.revision !== settlement.lastVerifierRevision + 1) {
		throw new Error("Settlement verifier revision is stale");
	}
}

async function loadBoundSettlement(
	ctx: MutationCtx,
	command: P2PCommand,
	payload: SettlementCommandPayload,
) {
	const settlement = await settlementByAttempt(
		ctx,
		payload.settlementId,
		payload.attempt,
	);
	if (!settlement) throw new Error("Settlement attempt not found");
	const role = assertParticipantBinding(
		payload,
		binding(settlement),
		command.identityKey,
	);
	return { settlement, role };
}

export const prepare = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.prepare",
			args.body,
			args.signature,
			async (command, payload, now) => {
				if (payload.chain !== configuredChain()) {
					throw new Error("Settlement chain is not enabled");
				}
				const prepared = parsePrepare(payload.body, command.identityKey);
				const existing = await settlementByAttempt(
					ctx,
					payload.settlementId,
					payload.attempt,
				);
				if (existing) {
					assertSettlementState(existing.status, ["preparing"]);
					if (existing.expiresAt <= now) {
						throw new Error("Settlement preparation expired");
					}
					const role = assertParticipantBinding(
						payload,
						binding(existing),
						command.identityKey,
					);
					if (roleValue(role, existing.partyAPrepare, existing.partyBPrepare)) {
						throw new Error("Participant is already prepared");
					}
					await ctx.db.patch(existing._id, {
						...(role === "partyA"
							? { partyAPrepare: prepared }
							: { partyBPrepare: prepared }),
						...revisionPatch(role, payload.revision),
						status: "contributing",
						stateVersion: existing.stateVersion + 1,
						updatedAt: now,
					});
					return {
						settlementId: existing.settlementId,
						attempt: existing.attempt,
						status: "contributing" as const,
						stateVersion: existing.stateVersion + 1,
					};
				}
				if (
					payload.expiresAt <= now ||
					payload.expiresAt - now > MAX_SETTLEMENT_TTL_MS
				) {
					throw new Error("Invalid settlement expiry");
				}
				const session = await sessionById(ctx, payload.sessionId);
				if (
					session?.status !== "ready" ||
					!session.initiatorLocked ||
					!session.participantLocked ||
					session.expiresAt <= now ||
					payload.expiresAt > session.expiresAt
				) {
					throw new Error("Locked trade session is not available");
				}
				if (
					payload.lockedOfferVersion.initiatorRevision !==
						session.initiatorRevision ||
					payload.lockedOfferVersion.participantRevision !==
						session.participantRevision
				) {
					throw new Error("Locked offer version changed");
				}
				const commitment = buildLockedOfferCommitment(
					session,
					payload.chain,
					payload.builder,
					payload.expiresAt,
				);
				if (settlementDigest(commitment) !== payload.offerDigest) {
					throw new Error("Locked offer digest does not match the session");
				}
				const [partyA, partyB] = commitment.parties;
				const role = assertInitialParticipants(
					payload,
					command.identityKey,
					partyA,
					partyB,
				);
				const previous = await ctx.db
					.query("p2pSettlements")
					.withIndex("by_settlement", (q) =>
						q.eq("settlementId", payload.settlementId),
					)
					.order("desc")
					.first();
				if (previous) {
					if (
						previous.sessionId !== payload.sessionId ||
						previous.attempt + 1 !== payload.attempt ||
						previous.offerDigest !== payload.offerDigest ||
						!(
							["failed", "expired", "cancelled"] as SettlementStatus[]
						).includes(previous.status)
					) {
						throw new Error("Settlement attempt cannot be restarted");
					}
				} else if (payload.attempt !== 1) {
					throw new Error("The first settlement attempt must be one");
				}
				await ctx.db.insert("p2pSettlements", {
					protocol: SETTLEMENT_PROTOCOL,
					wireVersion: SETTLEMENT_WIRE_VERSION,
					chain: payload.chain,
					sessionId: payload.sessionId,
					settlementId: payload.settlementId,
					attempt: payload.attempt,
					offerDigest: payload.offerDigest,
					lockedInitiatorRevision: payload.lockedOfferVersion.initiatorRevision,
					lockedParticipantRevision:
						payload.lockedOfferVersion.participantRevision,
					partyA,
					partyB,
					builder: payload.builder,
					feePayer: payload.feePayer,
					status: "preparing",
					stateVersion: 1,
					lastPartyARevision: role === "partyA" ? payload.revision : 0,
					lastPartyBRevision: role === "partyB" ? payload.revision : 0,
					lastVerifierRevision: 0,
					...(role === "partyA"
						? { partyAPrepare: prepared }
						: { partyBPrepare: prepared }),
					createdAt: now,
					updatedAt: now,
					expiresAt: payload.expiresAt,
				});
				return {
					settlementId: payload.settlementId,
					attempt: payload.attempt,
					status: "preparing" as const,
					stateVersion: 1,
				};
			},
		),
});

export const contribute = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.contribution",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const { settlement, role } = await loadBoundSettlement(
					ctx,
					command,
					payload,
				);
				assertSettlementState(settlement.status, ["contributing"]);
				if (
					roleValue(
						role,
						settlement.partyAContribution,
						settlement.partyBContribution,
					)
				) {
					throw new Error("Participant already contributed");
				}
				const contribution = parseContribution(
					payload.body,
					settlement.expiresAt,
					now,
				);
				const session = await sessionById(ctx, settlement.sessionId);
				if (
					session?.status !== "ready" ||
					!session.initiatorLocked ||
					!session.participantLocked ||
					session.expiresAt <= now ||
					session.initiatorRevision !== settlement.lockedInitiatorRevision ||
					session.participantRevision !== settlement.lockedParticipantRevision
				) {
					throw new Error("Locked offer changed before contribution");
				}
				validateContributionAgainstLockedOffer(
					contribution,
					settlement,
					role,
					session,
				);
				const peerContribution =
					role === "partyA"
						? settlement.partyBContribution
						: settlement.partyAContribution;
				const status = peerContribution ? "constructing" : "contributing";
				await ctx.db.patch(settlement._id, {
					...(role === "partyA"
						? {
								partyAContribution: {
									contributionHash: contribution.contributionHash,
									reservationId: contribution.reservationId,
									reservationExpiresAt: contribution.reservationExpiresAt,
								},
							}
						: {
								partyBContribution: {
									contributionHash: contribution.contributionHash,
									reservationId: contribution.reservationId,
									reservationExpiresAt: contribution.reservationExpiresAt,
								},
							}),
					...revisionPatch(role, payload.revision),
					status,
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

export const publishTemplate = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.template",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const { settlement, role } = await loadBoundSettlement(
					ctx,
					command,
					payload,
				);
				assertSettlementState(settlement.status, ["constructing"]);
				if (command.identityKey !== settlement.builder) {
					throw new Error("Only the fixed builder may publish the template");
				}
				if (
					(settlement.partyAContribution?.reservationExpiresAt ?? 0) <= now ||
					(settlement.partyBContribution?.reservationExpiresAt ?? 0) <= now
				) {
					throw new Error(
						"A contribution reservation expired before construction",
					);
				}
				const body = bodyRecord(
					payload.body,
					[
						"offerDigest",
						"contributionHashes",
						"templateHash",
						"manifest",
						"signableBeefHash",
					],
					"Invalid settlement template",
				);
				if (body.offerDigest !== settlement.offerDigest) {
					throw new Error("Template offer digest changed");
				}
				const contributionHashes = array(
					body.contributionHashes,
					"template contribution hashes",
					2,
				).map((hash) => parseSettlementHash(hash, "contribution hash"));
				if (
					contributionHashes.length !== 2 ||
					contributionHashes[0] !==
						settlement.partyAContribution?.contributionHash ||
					contributionHashes[1] !==
						settlement.partyBContribution?.contributionHash
				) {
					throw new Error(
						"Template contributions do not match both participants",
					);
				}
				const {
					manifestHash,
					overlayTokenIds,
					partyAInputIndexes,
					partyBInputIndexes,
				} = parseManifest(body.manifest, payload, settlement);
				const templateHash = parseSettlementHash(
					body.templateHash,
					"templateHash",
				);
				if (templateHash !== manifestHash) {
					throw new Error("Template hash does not match the manifest");
				}
				await ctx.db.patch(settlement._id, {
					templateHash,
					manifestHash,
					signableBeefHash: parseSettlementHash(
						body.signableBeefHash,
						"signableBeefHash",
					),
					overlayTokenIds,
					partyAInputIndexes,
					partyBInputIndexes,
					...revisionPatch(role, payload.revision),
					status: "reviewing",
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status: "reviewing" as const,
					templateHash,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

export const authorize = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.authorize",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const { settlement, role } = await loadBoundSettlement(
					ctx,
					command,
					payload,
				);
				assertSettlementState(settlement.status, [
					"reviewing",
					"partially_authorized",
				]);
				if (
					(settlement.partyAContribution?.reservationExpiresAt ?? 0) <= now ||
					(settlement.partyBContribution?.reservationExpiresAt ?? 0) <= now
				) {
					throw new Error(
						"A contribution reservation expired before authorization",
					);
				}
				if (
					roleValue(
						role,
						settlement.partyAAuthorization,
						settlement.partyBAuthorization,
					)
				) {
					throw new Error("Participant already authorized this attempt");
				}
				const authorization = parseAuthorization(
					payload.body,
					settlement.expiresAt,
					now,
				);
				const ownContribution =
					role === "partyA"
						? settlement.partyAContribution
						: settlement.partyBContribution;
				if (
					authorization.offerDigest !== settlement.offerDigest ||
					authorization.templateHash !== settlement.templateHash ||
					authorization.contributionHash !== ownContribution?.contributionHash
				) {
					throw new Error("Authorization is not bound to this exact template");
				}
				const expectedInputIndexes =
					role === "partyA"
						? settlement.partyAInputIndexes
						: settlement.partyBInputIndexes;
				if (
					!expectedInputIndexes ||
					authorization.authorizedInputs.length !==
						expectedInputIndexes.length ||
					authorization.authorizedInputs.some(
						(input, index) => input.inputIndex !== expectedInputIndexes[index],
					)
				) {
					throw new Error(
						"Authorization does not cover exactly the sender's asset inputs",
					);
				}
				const peerAuthorization =
					role === "partyA"
						? settlement.partyBAuthorization
						: settlement.partyAAuthorization;
				const status = peerAuthorization
					? "authorized"
					: "partially_authorized";
				const stored = {
					authorizationHash: authorization.authorizationHash,
					contributionHash: authorization.contributionHash,
					authorizationExpiresAt: authorization.authorizationExpiresAt,
				};
				await ctx.db.patch(settlement._id, {
					...(role === "partyA"
						? { partyAAuthorization: stored }
						: { partyBAuthorization: stored }),
					...revisionPatch(role, payload.revision),
					status,
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status,
					authorizationHash: authorization.authorizationHash,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

export const claimBroadcast = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.broadcast-claim",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const { settlement, role } = await loadBoundSettlement(
					ctx,
					command,
					payload,
				);
				assertSettlementState(settlement.status, ["authorized"]);
				if (command.identityKey !== settlement.builder) {
					throw new Error("Only the builder may claim the broadcast lease");
				}
				const claimDeadline = Math.min(
					settlement.partyAContribution?.reservationExpiresAt ?? 0,
					settlement.partyBContribution?.reservationExpiresAt ?? 0,
					settlement.partyAAuthorization?.authorizationExpiresAt ?? 0,
					settlement.partyBAuthorization?.authorizationExpiresAt ?? 0,
				);
				if (claimDeadline <= now) {
					throw new Error(
						"A reservation or authorization expired before broadcast",
					);
				}
				const body = bodyRecord(
					payload.body,
					[
						"templateHash",
						"authorizationHashes",
						"broadcaster",
						"leaseId",
						"leaseExpiresAt",
					],
					"Invalid broadcast claim",
				);
				const hashes = array(
					body.authorizationHashes,
					"authorization hashes",
					2,
				).map((hash) => parseSettlementHash(hash, "authorization hash"));
				if (
					body.templateHash !== settlement.templateHash ||
					hashes.length !== 2 ||
					hashes[0] !== settlement.partyAAuthorization?.authorizationHash ||
					hashes[1] !== settlement.partyBAuthorization?.authorizationHash ||
					body.broadcaster !== settlement.builder
				) {
					throw new Error(
						"Broadcast claim is not bound to both authorizations",
					);
				}
				const leaseExpiresAt = parseSafeInteger(
					body.leaseExpiresAt,
					"broadcast lease expiry",
					1,
				);
				if (leaseExpiresAt <= now || leaseExpiresAt > claimDeadline) {
					throw new Error("Invalid broadcast lease expiry");
				}
				const leaseId = parseSettlementUuid(body.leaseId, "broadcast lease ID");
				await ctx.db.patch(settlement._id, {
					broadcastLease: {
						leaseId,
						leaseExpiresAt,
						broadcaster: settlement.builder,
					},
					...revisionPatch(role, payload.revision),
					status: "broadcasting",
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status: "broadcasting" as const,
					leaseId,
					leaseExpiresAt,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

export const reportBroadcast = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.broadcast-result",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const { settlement, role } = await loadBoundSettlement(
					ctx,
					command,
					payload,
				);
				assertSettlementState(settlement.status, [
					"broadcasting",
					"outcome_unknown",
				]);
				if (command.identityKey !== settlement.builder) {
					throw new Error("Only the builder may report broadcast outcome");
				}
				const body = bodyRecord(
					payload.body,
					[
						"templateHash",
						"rawTxHash",
						"txid",
						"broadcaster",
						"leaseId",
						"submittedAt",
						"providerResult",
						"evidenceHash",
					],
					"Invalid broadcast result",
				);
				if (
					body.templateHash !== settlement.templateHash ||
					body.broadcaster !== settlement.builder ||
					body.leaseId !== settlement.broadcastLease?.leaseId
				) {
					throw new Error("Broadcast result is not bound to its lease");
				}
				if (
					body.providerResult !== "accepted" &&
					body.providerResult !== "already-known" &&
					body.providerResult !== "unknown" &&
					body.providerResult !== "rejected"
				) {
					throw new Error("Invalid broadcast provider result");
				}
				const rawTxHash = parseSettlementHash(body.rawTxHash, "rawTxHash");
				const txid = parseSettlementHash(body.txid, "txid");
				if (
					(settlement.rawTxHash && settlement.rawTxHash !== rawTxHash) ||
					(settlement.txid && settlement.txid !== txid)
				) {
					throw new Error(
						"A different transaction cannot replace this attempt",
					);
				}
				const submittedAt = parseSafeInteger(
					body.submittedAt,
					"broadcast submission time",
					1,
				);
				if (submittedAt > now + 30_000) {
					throw new Error("Broadcast submission time is in the future");
				}
				const status =
					body.providerResult === "accepted" ||
					body.providerResult === "already-known"
						? "verifying"
						: "outcome_unknown";
				await ctx.db.patch(settlement._id, {
					rawTxHash,
					txid,
					providerResult: body.providerResult,
					broadcastEvidenceHash: parseSettlementHash(
						body.evidenceHash,
						"broadcast evidence hash",
					),
					...revisionPatch(role, payload.revision),
					status,
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status,
					txid,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

export const reportEvidence = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.evidence",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const settlement = await settlementByAttempt(
					ctx,
					payload.settlementId,
					payload.attempt,
				);
				if (!settlement) throw new Error("Settlement attempt not found");
				assertVerifierBinding(payload, settlement, command);
				assertSettlementState(settlement.status, [
					"verifying",
					"overlay_pending",
					"outcome_unknown",
				]);
				const body = bodyRecord(
					payload.body,
					[
						"templateHash",
						"rawTxHash",
						"txid",
						"chain",
						"inputStatus",
						"conflictingTxid",
						"overlays",
						"evidenceHash",
					],
					"Invalid settlement evidence",
				);
				const rawTxHash = parseSettlementHash(body.rawTxHash, "rawTxHash");
				const txid = parseSettlementHash(body.txid, "txid");
				if (
					body.templateHash !== settlement.templateHash ||
					rawTxHash !== settlement.rawTxHash ||
					txid !== settlement.txid
				) {
					throw new Error(
						"Evidence is not for the exact broadcast transaction",
					);
				}
				const chain = bodyRecord(
					body.chain,
					["status", "checkedAt", "evidenceHash"],
					"Invalid chain evidence",
				);
				if (chain.status !== "found" && chain.status !== "absent") {
					throw new Error("Invalid chain evidence status");
				}
				const chainEvidenceHash = parseSettlementHash(
					chain.evidenceHash,
					"chain evidence hash",
				);
				const chainCheckedAt = parseSafeInteger(
					chain.checkedAt,
					"chain evidence time",
					1,
				);
				if (chainCheckedAt > now + 30_000) {
					throw new Error("Chain evidence time is in the future");
				}
				if (
					body.inputStatus !== "exact-tx" &&
					body.inputStatus !== "unspent" &&
					body.inputStatus !== "conflicted" &&
					body.inputStatus !== "unknown"
				) {
					throw new Error("Invalid committed input status");
				}
				if (body.inputStatus === "conflicted") {
					parseSettlementHash(body.conflictingTxid, "conflicting txid");
				} else if (body.conflictingTxid !== undefined) {
					throw new Error("Unexpected conflicting transaction");
				}
				const overlays = array(body.overlays, "overlay evidence", 32).map(
					(value) => {
						const evidence = bodyRecord(
							value,
							["tokenId", "status", "checkedAt", "evidenceHash"],
							"Invalid overlay evidence",
						);
						if (
							evidence.status !== "accepted" &&
							evidence.status !== "pending" &&
							evidence.status !== "rejected"
						) {
							throw new Error("Invalid overlay evidence status");
						}
						const status = evidence.status as
							| "accepted"
							| "pending"
							| "rejected";
						const checkedAt = parseSafeInteger(
							evidence.checkedAt,
							"overlay evidence time",
							1,
						);
						if (checkedAt > now + 30_000) {
							throw new Error("Overlay evidence time is in the future");
						}
						return {
							tokenId: parseSettlementOutpoint(
								evidence.tokenId,
								"overlay evidence token ID",
							),
							status,
							checkedAt,
							evidenceHash: parseSettlementHash(
								evidence.evidenceHash,
								"overlay evidence hash",
							),
						};
					},
				);
				const sortedOverlays = [...overlays].sort((left, right) =>
					left.tokenId < right.tokenId
						? -1
						: left.tokenId > right.tokenId
							? 1
							: 0,
				);
				if (
					overlays.some(
						(evidence, index) =>
							evidence.tokenId !== sortedOverlays[index]?.tokenId,
					)
				) {
					throw new Error("Overlay evidence must be sorted by token ID");
				}
				if (
					overlays.length !== (settlement.overlayTokenIds ?? []).length ||
					overlays.some(
						(evidence, index) =>
							evidence.tokenId !== settlement.overlayTokenIds?.[index],
					)
				) {
					throw new Error(
						"Overlay evidence does not cover the exact token set",
					);
				}
				const claimedEvidenceHash = parseSettlementHash(
					body.evidenceHash,
					"settlement evidence hash",
				);
				const committedEvidence = { ...body };
				delete committedEvidence.evidenceHash;
				if (claimedEvidenceHash !== settlementDigest(committedEvidence)) {
					throw new Error("Settlement evidence hash does not match");
				}
				const status = settlementStatusAfterEvidence(
					body.inputStatus,
					chain.status,
					overlays.map((item) => item.status),
				);
				await ctx.db.patch(settlement._id, {
					chainEvidenceHash,
					overlayEvidence: overlays,
					lastVerifierRevision: payload.revision,
					status,
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
					...(status === "conflicted"
						? {
								terminalAt: now,
								purgeAt: now + SETTLEMENT_RETENTION_MS,
							}
						: {}),
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status,
					txid,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

export const reportInternalization = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runSignedSettlement(
			ctx,
			"settlement.internalize",
			args.body,
			args.signature,
			async (command, payload, now) => {
				const { settlement, role } = await loadBoundSettlement(
					ctx,
					command,
					payload,
				);
				assertSettlementState(settlement.status, ["internalizing"]);
				const body = bodyRecord(
					payload.body,
					["templateHash", "txid", "status", "checkedAt", "receiptHash"],
					"Invalid internalization receipt",
				);
				if (
					body.templateHash !== settlement.templateHash ||
					body.txid !== settlement.txid ||
					(body.status !== "complete" && body.status !== "failed")
				) {
					throw new Error("Internalization receipt binding does not match");
				}
				const receiptStatus = body.status as "complete" | "failed";
				const previous =
					role === "partyA"
						? settlement.partyAInternalization
						: settlement.partyBInternalization;
				if (previous?.status === "complete" && body.status !== "complete") {
					throw new Error("Completed internalization cannot regress");
				}
				const receiptHash =
					receiptStatus === "complete"
						? parseSettlementHash(
								body.receiptHash,
								"internalization receipt hash",
							)
						: body.receiptHash === undefined
							? undefined
							: parseSettlementHash(
									body.receiptHash,
									"internalization receipt hash",
								);
				const checkedAt = parseSafeInteger(
					body.checkedAt,
					"internalization checked time",
					1,
				);
				if (checkedAt > now + 30_000) {
					throw new Error("Internalization receipt time is in the future");
				}
				const receipt = {
					status: receiptStatus,
					checkedAt,
					...(receiptHash ? { receiptHash } : {}),
				};
				const peerReceipt =
					role === "partyA"
						? settlement.partyBInternalization
						: settlement.partyAInternalization;
				const status = settlementStatusAfterInternalization(
					receiptStatus,
					peerReceipt?.status,
				);
				await ctx.db.patch(settlement._id, {
					...(role === "partyA"
						? { partyAInternalization: receipt }
						: { partyBInternalization: receipt }),
					...revisionPatch(role, payload.revision),
					status,
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
					...(status === "settled"
						? {
								terminalAt: now,
								purgeAt: now + SETTLEMENT_RETENTION_MS,
							}
						: {}),
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status,
					txid: settlement.txid,
					stateVersion: settlement.stateVersion + 1,
				};
			},
		),
});

async function closeBeforeAuthorization(
	ctx: MutationCtx,
	action: "settlement.cancel" | "settlement.timeout" | "settlement.failure",
	body: string,
	signature: string,
) {
	return runSignedSettlement(
		ctx,
		action,
		body,
		signature,
		async (command, payload, now) => {
			const settlement = await settlementByAttempt(
				ctx,
				payload.settlementId,
				payload.attempt,
			);
			if (!settlement) throw new Error("Settlement attempt not found");
			const participant =
				command.identityKey === settlement.partyA ||
				command.identityKey === settlement.partyB;
			if (action === "settlement.failure" && !participant) {
				assertVerifierBinding(payload, settlement, command);
				assertSettlementState(settlement.status, ["outcome_unknown"]);
				const failure = bodyRecord(
					payload.body,
					[
						"failureHash",
						"checkedAt",
						"exactTransactionAbsent",
						"committedInputsUnspent",
					],
					"Invalid verified settlement failure",
				);
				if (
					!boolean(
						failure.exactTransactionAbsent,
						"exact transaction absence",
					) ||
					!boolean(failure.committedInputsUnspent, "committed input status") ||
					now < settlement.expiresAt
				) {
					throw new Error(
						"Settlement failure is not authoritatively established",
					);
				}
				parseSafeInteger(failure.checkedAt, "failure checked time", 1);
				const failureHash = parseSettlementHash(
					failure.failureHash,
					"failure evidence hash",
				);
				await ctx.db.patch(settlement._id, {
					failureHash,
					lastVerifierRevision: payload.revision,
					status: "failed",
					stateVersion: settlement.stateVersion + 1,
					updatedAt: now,
					terminalAt: now,
					purgeAt: now + SETTLEMENT_RETENTION_MS,
				});
				return {
					settlementId: settlement.settlementId,
					attempt: settlement.attempt,
					status: "failed" as const,
					stateVersion: settlement.stateVersion + 1,
				};
			}
			const role = assertParticipantBinding(
				payload,
				binding(settlement),
				command.identityKey,
			);
			const reason = bodyRecord(
				payload.body,
				[
					"reasonHash",
					...(action === "settlement.timeout" ? ["observedAt"] : []),
				],
				"Invalid settlement close command",
			);
			const failureHash = parseSettlementHash(reason.reasonHash, "reason hash");
			let status: SettlementStatus;
			if (action === "settlement.timeout") {
				parseSafeInteger(reason.observedAt, "timeout observation", 1);
				if (now < settlement.expiresAt) {
					throw new Error("Settlement has not expired");
				}
				status = settlementStatusAfterTimeout(settlement.status);
			} else {
				assertSettlementState(settlement.status, [
					"preparing",
					"contributing",
					"constructing",
					"reviewing",
				]);
				status = action === "settlement.cancel" ? "cancelled" : "failed";
			}
			await ctx.db.patch(settlement._id, {
				failureHash,
				...revisionPatch(role, payload.revision),
				status,
				stateVersion: settlement.stateVersion + 1,
				updatedAt: now,
				...(status === "outcome_unknown"
					? {}
					: {
							terminalAt: now,
							purgeAt: now + SETTLEMENT_RETENTION_MS,
						}),
			});
			return {
				settlementId: settlement.settlementId,
				attempt: settlement.attempt,
				status,
				stateVersion: settlement.stateVersion + 1,
			};
		},
	);
}

export const cancel = mutation({
	args: signedArgs,
	handler: (ctx, args) =>
		closeBeforeAuthorization(
			ctx,
			"settlement.cancel",
			args.body,
			args.signature,
		),
});

export const timeout = mutation({
	args: signedArgs,
	handler: (ctx, args) =>
		closeBeforeAuthorization(
			ctx,
			"settlement.timeout",
			args.body,
			args.signature,
		),
});

export const fail = mutation({
	args: signedArgs,
	handler: (ctx, args) =>
		closeBeforeAuthorization(
			ctx,
			"settlement.failure",
			args.body,
			args.signature,
		),
});

export const get = query({
	args: { settlementId: v.string(), attempt: v.number() },
	handler: async (ctx, args) => {
		let settlementId: string;
		try {
			settlementId = parseSettlementUuid(args.settlementId, "settlementId");
		} catch {
			return null;
		}
		if (!Number.isSafeInteger(args.attempt) || args.attempt < 1) return null;
		return settlementByAttempt(ctx, settlementId, args.attempt);
	},
});

export const deletePurged = internalMutation({
	args: {},
	handler: async (ctx) => {
		const records = await ctx.db
			.query("p2pSettlements")
			.withIndex("by_purgeAt", (q) =>
				q.gt("purgeAt", 0).lt("purgeAt", Date.now()),
			)
			.take(200);
		const commandGroups = await Promise.all(
			records.map((record) =>
				ctx.db
					.query("p2pCommands")
					.withIndex("by_settlement_attempt", (q) =>
						q
							.eq("settlementId", record.settlementId)
							.eq("settlementAttempt", record.attempt),
					)
					.collect(),
			),
		);
		await Promise.all([
			...records.map((record) => ctx.db.delete(record._id)),
			...commandGroups.flat().map((command) => ctx.db.delete(command._id)),
		]);
	},
});
