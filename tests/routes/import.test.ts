import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { COMMISSIONER_ONLY_STATUS } from '../../src/lib/server/commissioner-guard.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

/**
 * The `/import` route handlers, exercised through the REAL
 * `requireCommissioner`/`requireLiveDestination` guards (nothing about them
 * is mocked) so this proves the route actually calls them, refusing
 * server-side regardless of what a client renders — hiding the upload form
 * is never the check. Only the I/O-touching layer (`loadImportStatus`,
 * `stageRosterFile`, `writeGateway`) is faked.
 */

const stub = vi.hoisted(() => ({
	statuses: [] as unknown[],
	outcomes: [] as unknown[],
	/** When set, the call for this exact file name throws instead of resolving. */
	throwOnFileName: null as string | null,
	throwMessage: 'stageRosterFile failed'
}));

vi.mock('$lib/server/import-status.ts', () => ({
	loadImportStatus: async () => stub.statuses,
	outstandingTeamNames: (statuses: Array<{ status: string; teamName: string }>) =>
		statuses.filter((s) => s.status !== 'staged').map((s) => s.teamName)
}));

const stageCalls = vi.hoisted(() => [] as Array<{ fileName: string; csvText: string }>);

vi.mock('$lib/server/roster-import.ts', () => ({
	stageRosterFile: vi.fn(
		async (
			_gateway: unknown,
			fileName: string,
			csvText: string,
			_claimed: Set<string>
		) => {
			stageCalls.push({ fileName, csvText });
			if (stub.throwOnFileName !== null && fileName === stub.throwOnFileName) {
				throw new Error(stub.throwMessage);
			}
			return stub.outcomes.shift();
		}
	)
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({ connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) })
}));

const route = await import('../../src/routes/import/+page.server.ts');

const COMMISSIONER: RegisteredManager = {
	id: 'm-1',
	discordUserId: '111',
	displayName: 'Commissioner Bob',
	teamId: 't-1',
	teamName: 'Celtics',
	isCommissioner: true
};

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.' };
const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.' };

function locals(session: SessionState, phase: ResolvedPhase = SETUP_PHASE) {
	return { session, phase };
}

async function expectRefusal(run: () => unknown, status: number): Promise<void> {
	let thrown: unknown;
	try {
		await run();
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, 'the call did not throw').toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	if (isHttpError(thrown)) expect(thrown.status).toBe(status);
}

beforeEach(() => {
	stub.statuses = [];
	stub.outcomes = [];
	stub.throwOnFileName = null;
	stub.throwMessage = 'stageRosterFile failed';
	stageCalls.length = 0;
});

describe('load — Commissioner-only, gated on both the guard and the destination', () => {
	it('refuses a non-Commissioner registered session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'registered', manager: MANAGER }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			COMMISSIONER_ONLY_STATUS
		);
	});

	it('refuses a Commissioner outside Setup — import is not live in Auction', async () => {
		await expectRefusal(
			() =>
				route.load({
					locals: locals({ kind: 'registered', manager: COMMISSIONER }, AUCTION_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('loads status for a Commissioner in Setup', async () => {
		stub.statuses = [
			{ teamId: 't-1', teamName: 'Lakers', status: 'outstanding' },
			{ teamId: 't-2', teamName: 'Celtics', status: 'staged' }
		];
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as { statuses: unknown[]; outstanding: string[] };

		expect(result.statuses).toEqual(stub.statuses);
		expect(result.outstanding).toEqual(['Lakers']);
	});
});

describe('actions.upload — Commissioner-only, gated the same way as load', () => {
	function uploadEvent(files: File[], session: SessionState, phase: ResolvedPhase = SETUP_PHASE) {
		const form = new FormData();
		for (const file of files) form.append('files', file);
		return {
			request: new Request('https://app.example/import', { method: 'POST', body: form }),
			locals: locals(session, phase)
		};
	}

	const uploadAction = route.actions.upload as unknown as (event: unknown) => unknown;

	it('refuses a non-Commissioner session with 403, before touching any file', async () => {
		const file = new File(['a,b\n1,2'], 'Lakers.csv', { type: 'text/csv' });
		await expectRefusal(
			() => uploadAction(uploadEvent([file], { kind: 'registered', manager: MANAGER })),
			COMMISSIONER_ONLY_STATUS
		);
		expect(stageCalls).toEqual([]);
	});

	it('refuses outside Setup', async () => {
		const file = new File(['a,b\n1,2'], 'Lakers.csv', { type: 'text/csv' });
		await expectRefusal(
			() =>
				uploadAction(
					uploadEvent([file], { kind: 'registered', manager: COMMISSIONER }, AUCTION_PHASE)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
	});

	it('reports a form failure when no files were supplied', async () => {
		const result = (await uploadAction(
			uploadEvent([], { kind: 'registered', manager: COMMISSIONER })
		)) as { status: number; data: { notice: string } };
		expect(result.status).toBe(400);
		expect(stageCalls).toEqual([]);
	});

	it('stages every file in the batch, in order, sharing one claimedInBatch set', async () => {
		const outcomes = [
			{ kind: 'staged', teamId: 't-1', teamName: 'Lakers', fileName: 'Lakers.csv', rowCount: 1 },
			{ kind: 'refused_file', fileName: 'Lakers2.csv', detail: 'already supplied' }
		];
		stub.outcomes = [...outcomes];
		const files = [
			new File(['a,b\n1,2'], 'Lakers.csv', { type: 'text/csv' }),
			new File(['a,b\n1,2'], 'Lakers2.csv', { type: 'text/csv' })
		];

		const result = (await uploadAction(
			uploadEvent(files, { kind: 'registered', manager: COMMISSIONER })
		)) as { results: unknown[] };

		expect(stageCalls.map((c) => c.fileName)).toEqual(['Lakers.csv', 'Lakers2.csv']);
		expect(result.results).toEqual(outcomes);
	});

	it('does not filter out a zero-byte file — it reaches stageRosterFile and gets its own result', async () => {
		const emptyFile = new File([], 'Empty.csv', { type: 'text/csv' });
		const emptyOutcome = {
			kind: 'refused_content',
			teamId: 't-4',
			teamName: 'Grizzlies',
			fileName: 'Empty.csv',
			detail: 'The file has no data rows.'
		};
		stub.outcomes = [emptyOutcome];

		const result = (await uploadAction(
			uploadEvent([emptyFile], { kind: 'registered', manager: COMMISSIONER })
		)) as { results: unknown[] };

		expect(stageCalls.map((c) => c.fileName)).toEqual(['Empty.csv']);
		expect(result.results).toEqual([emptyOutcome]);
	});

	it('contains a per-file error: one file throwing does not abort the rest of the batch', async () => {
		const lakersOutcome = {
			kind: 'staged',
			teamId: 't-1',
			teamName: 'Lakers',
			fileName: 'Lakers.csv',
			rowCount: 1
		};
		const warriorsOutcome = {
			kind: 'staged',
			teamId: 't-3',
			teamName: 'Warriors',
			fileName: 'Warriors.csv',
			rowCount: 1
		};
		stub.outcomes = [lakersOutcome, warriorsOutcome];
		stub.throwOnFileName = 'Celtics.csv';
		stub.throwMessage = 'connection refused';

		const files = [
			new File(['a,b\n1,2'], 'Lakers.csv', { type: 'text/csv' }),
			new File(['a,b\n1,2'], 'Celtics.csv', { type: 'text/csv' }),
			new File(['a,b\n1,2'], 'Warriors.csv', { type: 'text/csv' })
		];

		const result = (await uploadAction(
			uploadEvent(files, { kind: 'registered', manager: COMMISSIONER })
		)) as { results: unknown[] };

		// All three files got processed — the throw on the second did not abort
		// the batch — and each has its own result.
		expect(stageCalls.map((c) => c.fileName)).toEqual(['Lakers.csv', 'Celtics.csv', 'Warriors.csv']);
		expect(result.results).toEqual([
			lakersOutcome,
			{ kind: 'error', fileName: 'Celtics.csv', detail: 'connection refused' },
			warriorsOutcome
		]);
	});
});
