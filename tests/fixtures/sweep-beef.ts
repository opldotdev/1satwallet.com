import type { OneSatServices } from "@1sat/wallet-browser";
import { Beef, MerklePath, Script, Transaction } from "@bsv/sdk";

/** A transaction whose one OP_RETURN output carries `payloadBytes` bytes. */
function payloadTx(payloadBytes: number, seed: number): Transaction {
	const tx = new Transaction();
	tx.addOutput({
		lockingScript: new Script([
			{ op: 0x6a },
			{
				op: 0x4e,
				data: new Array(Math.max(1, payloadBytes)).fill(seed & 0xff),
			},
		]),
		satoshis: 0,
	});
	return tx;
}

/** A BEEF the sweep accepts: one tx with a merkle proof (BUMP). */
export function provenBeef(payloadBytes = 4, seed = 1): Beef {
	const tx = payloadTx(payloadBytes, seed);
	const id = tx.id("hex");
	tx.merklePath = new MerklePath(800_000, [
		[
			{ offset: 0, hash: id, txid: true },
			{ offset: 1, duplicate: true },
		],
	]);
	const beef = new Beef();
	beef.mergeTransaction(tx);
	return beef;
}

/** A BEEF Beef.isValid() rejects: one unconfirmed tx, no proof, no parent. */
export function prooflessBeef(): Beef {
	const tx = payloadTx(4, 2);
	tx.addInput({
		sourceTXID: "ab".repeat(32),
		sourceOutputIndex: 0,
		unlockingScript: new Script(),
		sequence: 0xffffffff,
	});
	const beef = new Beef();
	beef.mergeRawTx(tx.toBinary());
	return beef;
}

/** Services whose getBeefForTxid serves `beefFor(txid)` (default: proven). */
export function beefServices(
	beefFor: (txid: string) => Beef = () => provenBeef(),
	fetched: string[] = [],
): OneSatServices {
	return {
		getBeefForTxid: async (txid: string) => {
			fetched.push(txid);
			return beefFor(txid);
		},
	} as unknown as OneSatServices;
}
