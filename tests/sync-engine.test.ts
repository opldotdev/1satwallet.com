import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createSyncCoordinator,
	type SyncTaskName,
	type SyncTasksState,
	shouldRunOwnedSync,
} from "@/providers/hooks/use-sync-engine";

const resolvedJobs = (run: (name: SyncTaskName) => Promise<void>) => ({
	addresses: async () => {
		await run("addresses");
		return { processed: 1, failed: 0 };
	},
	payments: async () => {
		await run("payments");
		return { processed: 2, failed: 0 };
	},
	cosignDeliveries: async () => {
		await run("cosignDeliveries");
		return { processed: 3, failed: 0 };
	},
	handleInbox: async () => {
		await run("handleInbox");
		return { processed: 4, failed: 0 };
	},
});

function installedSyncSource(filename: string) {
	return readFileSync(
		join(process.cwd(), "node_modules/@1sat/actions/dist/sync", filename),
		"utf8",
	);
}

describe("wallet sync coordinator", () => {
	it("keeps automatic and manual runs single-flight", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const coordinator = createSyncCoordinator(() => {});
		const jobs = resolvedJobs(async () => {
			calls += 1;
			await blocked;
		});

		const first = coordinator.run(jobs);
		const duplicate = coordinator.run(jobs);
		assert.equal(first.started, true);
		assert.equal(duplicate.started, false);
		assert.equal(first.promise, duplicate.promise);
		release();
		await first.promise;
		assert.equal(calls, 4);
	});

	it("runs the handle inbox alone on its timer, in the task list", async () => {
		let state: SyncTasksState | undefined;
		const ran: SyncTaskName[] = [];
		const coordinator = createSyncCoordinator(
			(next) => {
				state = next;
			},
			() => 7,
		);
		await coordinator.run(
			resolvedJobs(async (name) => {
				ran.push(name);
			}),
			["handleInbox"],
		).promise;
		assert.deepEqual(ran, ["handleInbox"]);
		assert.equal(state?.handleInbox.status, "succeeded");
		assert.equal(state?.handleInbox.processed, 4);
		assert.equal(state?.addresses.status, "idle");

		ran.length = 0;
		await coordinator.run(
			resolvedJobs(async (name) => {
				ran.push(name);
			}),
		).promise;
		assert.deepEqual(ran, [
			"addresses",
			"payments",
			"cosignDeliveries",
			"handleInbox",
		]);
	});

	it("joins a full run with the inbox timer; a full run waits for an inbox run", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ran: SyncTaskName[] = [];
		const coordinator = createSyncCoordinator(() => {});
		const jobs = resolvedJobs(async (name) => {
			ran.push(name);
			await blocked;
		});

		const full = coordinator.run(jobs);
		const tick = coordinator.run(jobs, ["handleInbox"]);
		assert.equal(tick.started, false);
		assert.equal(tick.promise, full.promise);
		release();
		await full.promise;
		assert.equal(ran.length, 4);

		let releaseTick = () => {};
		const tickBlocked = new Promise<void>((resolve) => {
			releaseTick = resolve;
		});
		ran.length = 0;
		const tickJobs = resolvedJobs(async (name) => {
			ran.push(name);
			await tickBlocked;
		});
		const inboxOnly = coordinator.run(tickJobs, ["handleInbox"]);
		const wider = coordinator.run(
			resolvedJobs(async (name) => {
				ran.push(name);
			}),
		);
		const again = coordinator.run(jobs);
		assert.equal(wider.started, true);
		assert.equal(again.started, false);
		assert.equal(again.promise, wider.promise);
		assert.deepEqual(ran, ["handleInbox"]);
		releaseTick();
		await inboxOnly.promise;
		assert.equal(await wider.promise, true);
		assert.deepEqual(ran, [
			"handleInbox",
			"addresses",
			"payments",
			"cosignDeliveries",
			"handleInbox",
		]);
	});

	it("keeps the timer's inbox run silent unless its outcome changes", async () => {
		const states: SyncTasksState[] = [];
		let clock = 1;
		const coordinator = createSyncCoordinator(
			(next) => {
				states.push(next);
			},
			() => clock,
		);
		let outcome = { processed: 0, failed: 0 };
		const jobs = {
			...resolvedJobs(async () => {}),
			handleInbox: async () => outcome,
		};
		await coordinator.run(jobs, ["handleInbox"], { silent: true }).promise;
		// Idle to succeeded is a change: published once, never as running.
		assert.equal(states.length, 1);
		assert.equal(states[0].handleInbox.status, "succeeded");
		assert.equal(states[0].handleInbox.lastRunAt, 1);

		clock = 2;
		await coordinator.run(jobs, ["handleInbox"], { silent: true }).promise;
		assert.equal(states.length, 1);

		outcome = { processed: 1, failed: 0 };
		clock = 3;
		await coordinator.run(jobs, ["handleInbox"], { silent: true }).promise;
		assert.equal(states.length, 2);
		assert.equal(states[1].handleInbox.processed, 1);
		assert.ok(
			states.every((state) =>
				Object.values(state).every((task) => task.status !== "running"),
			),
		);
	});

	it("drops a waiting full run when the identity resets", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ran: SyncTaskName[] = [];
		const coordinator = createSyncCoordinator(() => {});
		coordinator.run(
			resolvedJobs(() => blocked),
			["handleInbox"],
		);
		const wider = coordinator.run(
			resolvedJobs(async (name) => {
				ran.push(name);
			}),
		);
		coordinator.reset();
		release();
		assert.equal(await wider.promise, false);
		assert.deepEqual(ran, []);
	});

	it("records exact results and keeps failed work retryable", async () => {
		let state: SyncTasksState | undefined;
		const coordinator = createSyncCoordinator(
			(next) => {
				state = next;
			},
			() => 42,
		);

		await coordinator.run({
			...resolvedJobs(async () => {}),
			payments: async () => ({ processed: 4, failed: 1 }),
		}).promise;
		assert.deepEqual(state?.payments, {
			status: "failed",
			lastRunAt: 42,
			processed: 4,
			failed: 1,
			error: "1 item failed",
		});

		await Promise.resolve();
		await coordinator.run(resolvedJobs(async () => {})).promise;
		assert.equal(state?.payments.status, "succeeded");
		assert.equal(state?.payments.processed, 2);
		assert.equal(state?.payments.failed, 0);
	});

	it("does not publish stale results after an identity reset", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let state: SyncTasksState | undefined;
		let calls = 0;
		const coordinator = createSyncCoordinator((next) => {
			state = next;
		});
		const run = coordinator.run(
			resolvedJobs(async () => {
				calls += 1;
				await blocked;
			}),
		);

		coordinator.reset();
		release();
		assert.equal(await run.promise, false);
		assert.equal(state?.addresses.status, "idle");
		assert.equal(state?.payments.lastRunAt, null);
		assert.equal(calls, 1);
	});

	it("waits for in-flight work before teardown completes", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const coordinator = createSyncCoordinator(() => {});
		coordinator.run(resolvedJobs(() => blocked));
		let stopped = false;
		const stop = coordinator.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		assert.equal(stopped, false);
		release();
		await stop;
		assert.equal(stopped, true);
	});

	it("runs only for a visible website-owned built-in wallet", () => {
		const ready = {
			isInitialized: true,
			ownedByWebsite: true,
			isVisible: true,
			hasWallet: true,
			hasServices: true,
			hasIdentity: true,
			hasAddressManager: true,
		};
		assert.equal(shouldRunOwnedSync(ready), true);
		assert.equal(shouldRunOwnedSync({ ...ready, isVisible: false }), false);
		assert.equal(
			shouldRunOwnedSync({ ...ready, ownedByWebsite: false }),
			false,
		);
	});

	it("pins MessageBox acknowledgement after successful internalization", () => {
		for (const filename of ["syncMessages.js", "syncCosignDeliveries.js"]) {
			const source = installedSyncSource(filename);
			const internalized = source.indexOf("await ctx.wallet.internalizeAction");
			const queued = source.indexOf("acknowledgedIds.push", internalized);
			const acknowledged = source.indexOf(
				"await client.acknowledgeMessage",
				queued,
			);
			assert.ok(internalized >= 0, `${filename} internalizes a message`);
			assert.ok(queued > internalized, `${filename} queues only after success`);
			assert.ok(
				acknowledged > queued,
				`${filename} acknowledges queued successes`,
			);
		}
	});
});

describe("handle inbox wiring", () => {
	const engine = readFileSync(
		join(process.cwd(), "providers/hooks/use-sync-engine.ts"),
		"utf8",
	);

	it("runs on the color context with the overlay resolver where 1Color is offered", () => {
		assert.match(
			engine,
			/if \(oneColorChain\) \{\s*if \(!colorContext \|\| !colorOverlay\) return null;\s*return createHandleInboxSync\(colorContext, \{\s*overlayFor: \(assetId\) => colorOverlay\.resolveOrigin\(assetId\),/,
		);
	});

	it("still collects handle payments on the raw wallet elsewhere, with no overlay", () => {
		assert.match(
			engine,
			/return createHandleInboxSync\(\s*createActionContext\(wallet, \{ chain, services \}\),\s*\);/,
		);
	});

	it("collects on a timer while the owned sync may run, and refreshes 1Color holdings", () => {
		assert.match(engine, /HANDLE_INBOX_SYNC_INTERVAL_MS = 60_000/);
		assert.match(
			engine,
			/if \(!canRun\) return;\s*const timer = setInterval\(\s*\(\) => runSync\(HANDLE_INBOX_ONLY\),/,
		);
		assert.match(engine, /if \(oneColorReceived\) onOneColorReceived\(\);/);
		assert.match(engine, /\{ silent: names === HANDLE_INBOX_ONLY \}/);
		assert.match(
			engine,
			/if \(!handleInboxSync\) return \{ processed: 0, failed: 0 \};/,
		);
		const provider = readFileSync(
			join(process.cwd(), "providers/wallet-toolbox-provider.tsx"),
			"utf8",
		);
		assert.match(
			provider,
			/invalidateQueries\(\{ queryKey: \["one-color"\] \}\)/,
		);
	});
});
