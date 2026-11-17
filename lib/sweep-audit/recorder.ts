import {
	createSweepAuditRecord,
	finishSweepAudit,
	type SweepAuditInit,
	type SweepAuditRecord,
	withSweepProgress,
	withSweepStage,
} from "@/lib/sweep-audit/record";
import type { SweepAuditStore } from "@/lib/sweep-audit/store";
import {
	emptySweepResult,
	type SweepProgress,
	type SweepResult,
} from "@/lib/sweep-migration";

/** Runs this page is running now; any other "running" record was interrupted. */
const runningHere = new Set<string>();

export function sweepAuditRunsHere(): ReadonlySet<string> {
	return runningHere;
}

export const SWEEP_AUDIT_SAVE_ERROR =
	"Couldn't save this run's support report in this browser.";

/** One run's audit trail: every change is saved as it happens. */
export interface SweepAuditRun {
	readonly id: string;
	record(): SweepAuditRecord;
	/** A run stage before the sweep (cancel, transfer, persist, reroot...) */
	stage(stage: string): void;
	/** The sweep's progress; saved when steps, txids or errors change */
	progress(progress: SweepProgress): void;
	finish(result: SweepResult | null, progress?: SweepProgress | null): void;
	/** The run threw: why, and whatever it had done by then */
	fail(error: unknown, partial?: Partial<SweepResult> | null): void;
	/** Resolves once every save so far has been tried */
	flushed(): Promise<void>;
}

export interface SweepAuditDeps {
	store: SweepAuditStore;
	now?: () => Date;
	newId?: () => string;
	/** Every new state of the record, saved or not */
	onChange?: (record: SweepAuditRecord) => void;
	/** A save failed; it was logged with console.error */
	onSaveError?: (message: string, error: unknown) => void;
}

/**
 * Start a run's audit record and save it at once, so a tab closed mid-sweep
 * still leaves the record and every txid broadcast up to the last step.
 * Saves are queued in order; a failed save is logged and reported, and the
 * next change tries again.
 */
export function startSweepAudit(
	init: SweepAuditInit,
	deps: SweepAuditDeps,
): SweepAuditRun {
	const now = deps.now ?? (() => new Date());
	const id = deps.newId?.() ?? crypto.randomUUID();
	let current = createSweepAuditRecord(init, id, now());
	let lastSaved = "";
	let lastProgress: SweepProgress | null = null;
	let queue: Promise<void> = Promise.resolve();
	runningHere.add(id);

	const save = () => {
		const json = JSON.stringify(current);
		if (json === lastSaved) return;
		lastSaved = json;
		const record = current;
		deps.onChange?.(record);
		queue = queue.then(() =>
			deps.store.put(record).catch((error: unknown) => {
				console.error("[sweep-audit] could not save the run record", {
					runId: record.id,
					error,
				});
				// The next change saves the whole record again.
				lastSaved = "";
				deps.onSaveError?.(SWEEP_AUDIT_SAVE_ERROR, error);
			}),
		);
	};

	save();

	return {
		id,
		record: () => current,
		stage(stage) {
			current = withSweepStage(current, stage, now());
			save();
		},
		progress(progress) {
			lastProgress = progress;
			current = withSweepProgress(current, progress);
			save();
		},
		finish(result, progress) {
			const last = progress ?? lastProgress;
			current = finishSweepAudit(
				current,
				{ result, steps: last?.steps },
				now(),
			);
			runningHere.delete(id);
			save();
		},
		fail(error, partial) {
			const failure = error instanceof Error ? error.message : String(error);
			// partialRunResult: listing cancels and pay-key moves made before
			// the run stopped, with their errors
			const result: SweepResult | null = partial
				? emptySweepResult(partial)
				: null;
			current = finishSweepAudit(
				current,
				{ result, steps: lastProgress?.steps, failure },
				now(),
			);
			runningHere.delete(id);
			save();
		},
		flushed: () => queue,
	};
}
