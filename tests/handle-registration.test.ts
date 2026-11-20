import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HANDLE_CERT_TYPE } from "@1sat/types";
import {
	type AcquireCertificateArgs,
	MasterCertificate,
	PrivateKey,
	ProtoWallet,
} from "@bsv/sdk";
import {
	allowsRegistration,
	checkHandleAvailability,
	type DirectCertificate,
	normalizeHandleUsername,
	registerHandle,
} from "@/lib/wallet/handle-registration";

const quiet = { error: console.error };
beforeEach(() => {
	console.error = () => {};
});
afterEach(() => {
	console.error = quiet.error;
});

const certifierKey = PrivateKey.fromRandom();
const certifier = new ProtoWallet(certifierKey);
const certifierPub = certifierKey.toPublicKey().toString();
const subjectKey = PrivateKey.fromRandom();
const subject = subjectKey.toPublicKey().toString();

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** The handle host for testnet.1sat.app, as fetch answers it. */
function host(resolveStatus: number, identityKey = subject) {
	const urls: string[] = [];
	const answer = (async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url === "https://testnet.1sat.app/manifest.json") {
			return json({
				metanet: {
					handles: { version: "1.0" },
					trust: { publicKey: certifierPub },
				},
			});
		}
		if (resolveStatus !== 200) return json({}, resolveStatus);
		return json({
			metanetHandles: "1.0",
			handle: "alice",
			domain: "testnet.1sat.app",
			identityKey,
			certificate: { subject: identityKey },
			messagebox: "https://testnet.messagebox.1sat.app",
			ttl: 60,
			revoked: false,
		});
	}) as typeof fetch;
	return { fetch: answer, urls };
}

async function directCertificate(
	fields: Record<string, string>,
	over: Partial<DirectCertificate> = {},
): Promise<DirectCertificate> {
	const cert = await MasterCertificate.issueCertificateForSubject(
		certifier,
		subject,
		fields,
		HANDLE_CERT_TYPE,
	);
	return {
		type: cert.type,
		certifier: cert.certifier,
		acquisitionProtocol: "direct",
		fields: cert.fields,
		serialNumber: cert.serialNumber,
		revocationOutpoint: cert.revocationOutpoint,
		signature: cert.signature as string,
		keyringRevealer: "certifier",
		keyringForSubject: cert.masterKeyring,
		subject,
		...over,
	};
}

function subjectWallet() {
	const proto = new ProtoWallet(subjectKey);
	const acquired: AcquireCertificateArgs[] = [];
	return {
		acquired,
		wallet: {
			decrypt: proto.decrypt.bind(proto),
			listCertificates: async () => ({
				totalCertificates: 0,
				certificates: [],
			}),
			acquireCertificate: async (args: AcquireCertificateArgs) => {
				acquired.push(args);
				return {} as never;
			},
		},
	};
}

describe("handle usernames", () => {
	it("follows the host's rules", () => {
		assert.equal(normalizeHandleUsername("  Alice-1 "), "alice-1");
		for (const bad of ["ab", "-ab", "ab-", "a_b", "a".repeat(64)]) {
			assert.equal(normalizeHandleUsername(bad), null, bad);
		}
	});
});

describe("checkHandleAvailability", () => {
	it("reads a 404 from the resolver as available", async () => {
		const a = await checkHandleAvailability(
			"alice",
			"test",
			subject,
			host(404),
		);
		assert.deepEqual(a, {
			kind: "available",
			handle: "@alice@testnet.1sat.app",
		});
		assert.equal(allowsRegistration(a), true);
	});

	it("tells this account's handle from someone else's", async () => {
		assert.equal(
			(await checkHandleAvailability("alice", "test", subject, host(200))).kind,
			"yours",
		);
		const other = PrivateKey.fromRandom().toPublicKey().toString();
		const taken = await checkHandleAvailability(
			"alice",
			"test",
			subject,
			host(200, other),
		);
		assert.equal(taken.kind, "taken");
		assert.equal(allowsRegistration(taken), false);
	});

	it("leaves a host that failed as unknown, still registrable", async () => {
		const a = await checkHandleAvailability(
			"alice",
			"test",
			subject,
			host(500),
		);
		assert.equal(a.kind, "unknown");
		assert.equal(allowsRegistration(a), true);
		assert.equal(
			(await checkHandleAvailability("x", "test", subject, host(404))).kind,
			"invalid",
		);
	});
});

describe("registerHandle", () => {
	it("posts to the chain's account host and files a certificate that checks out", async () => {
		const cert = await directCertificate({
			handle: "alice",
			domain: "testnet.1sat.app",
		});
		const posted: [string, string][] = [];
		const { wallet, acquired } = subjectWallet();
		const handle = await registerHandle(
			"Alice",
			{ wallet, chain: "test", identityKey: subject },
			{
				fetch: host(404).fetch,
				post: async (url, body) => {
					posted.push([url, body]);
					return json({
						username: "alice",
						identityKey: subject,
						certificate: cert,
					});
				},
			},
		);
		assert.equal(handle, "@alice@testnet.1sat.app");
		assert.deepEqual(posted, [
			[
				"https://testnet.messagebox.1sat.app/account/register",
				JSON.stringify({ username: "alice" }),
			],
		]);
		assert.equal(acquired.length, 1);
		assert.equal(acquired[0].acquisitionProtocol, "direct");
		assert.equal(acquired[0].serialNumber, cert.serialNumber);
		assert.deepEqual(
			{ ...acquired[0].keyringForSubject },
			{ ...cert.keyringForSubject },
		);
	});

	it("refuses a certificate for another handle, or from another certifier", async () => {
		const run = async (cert: DirectCertificate) => {
			const { wallet, acquired } = subjectWallet();
			await assert.rejects(
				registerHandle(
					"alice",
					{ wallet, chain: "test", identityKey: subject },
					{
						fetch: host(404).fetch,
						post: async () => json({ certificate: cert }),
					},
				),
				/didn't check out/,
			);
			assert.equal(acquired.length, 0);
		};
		await run(
			await directCertificate({
				handle: "mallory",
				domain: "testnet.1sat.app",
			}),
		);
		await run(
			await directCertificate(
				{ handle: "alice", domain: "testnet.1sat.app" },
				{ certifier: PrivateKey.fromRandom().toPublicKey().toString() },
			),
		);
	});

	it("passes the host's own refusal through and posts nothing without a certifier key", async () => {
		const { wallet } = subjectWallet();
		await assert.rejects(
			registerHandle(
				"alice",
				{ wallet, chain: "test", identityKey: subject },
				{
					fetch: host(404).fetch,
					post: async () => json({ error: "username taken" }, 409),
				},
			),
			/^HandleRegistrationError: username taken$/,
		);
		let posted = false;
		await assert.rejects(
			registerHandle(
				"alice",
				{ wallet, chain: "test", identityKey: subject },
				{
					fetch: (async () => json({}, 404)) as typeof fetch,
					post: async () => {
						posted = true;
						return json({});
					},
				},
			),
			/doesn't say which key certifies its handles/,
		);
		assert.equal(posted, false);
	});
});
