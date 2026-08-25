import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

import { promotionRefusalDetail } from '../../src/lib/core/rules/import-preview.ts';
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
	pool: {
		status: 'outstanding',
		fileName: null,
		refusalDetail: null,
		updatedAt: null,
		playerCount: 0
	} as Record<string, unknown>,
	outcomes: [] as unknown[],
	poolOutcomes: [] as unknown[],
	/** When set, the call for this exact file name throws instead of resolving. */
	throwOnFileName: null as string | null,
	throwMessage: 'stageRosterFile failed',
	preview: { teams: [] as unknown[], poolSize: 0 } as Record<string, unknown>,
	/** What the faked `promoteImport` answers. */
	promotionOutcome: { kind: 'accepted', events: [] as unknown[] } as Record<string, unknown>
}));

vi.mock('$lib/server/import-status.ts', () => ({
	loadImportStatus: async () => stub.statuses,
	loadPoolStatus: async () => stub.pool,
	outstandingSourceNames: (
		statuses: Array<{ status: string; teamName: string }>,
		pool: { status: string }
	) => [
		...statuses.filter((s) => s.status !== 'staged').map((s) => s.teamName),
		...(pool.status === 'staged' ? [] : ['Free Agent pool'])
	]
}));

const stageCalls = vi.hoisted(() => [] as Array<{ fileName: string; csvText: string }>);
const poolCalls = vi.hoisted(() => [] as Array<{ fileName: string; csvText: string }>);

vi.mock('$lib/server/import-preview.ts', () => ({
	loadImportPreview: async () => stub.preview
}));

const promoteCalls = vi.hoisted(() => [] as Array<{ managerId: string; teamId: string }>);

vi.mock('$lib/server/import-promotion.ts', () => ({
	promoteImport: vi.fn(async (_gateway: unknown, actor: { managerId: string; teamId: string }) => {
		promoteCalls.push(actor);
		return stub.promotionOutcome;
	})
}));

// `isPoolFileName` is NOT mocked — the route's routing decision is the thing
// under test here, so it runs against the real rule.
vi.mock('$lib/server/pool-import.ts', () => ({
	stagePoolFile: vi.fn(
		async (
			_gateway: unknown,
			fileName: string,
			csvText: string,
			_claimed: { claimed: boolean }
		) => {
			poolCalls.push({ fileName, csvText });
			if (stub.throwOnFileName !== null && fileName === stub.throwOnFileName) {
				throw new Error(stub.throwMessage);
			}
			return stub.poolOutcomes.shift();
		}
	)
}));

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
	stub.pool = {
		status: 'outstanding',
		fileName: null,
		refusalDetail: null,
		updatedAt: null,
		playerCount: 0
	};
	stub.outcomes = [];
	stub.poolOutcomes = [];
	poolCalls.length = 0;
	stub.throwOnFileName = null;
	stub.throwMessage = 'stageRosterFile failed';
	stageCalls.length = 0;
	stub.preview = { teams: [], poolSize: 0 };
	stub.promotionOutcome = { kind: 'accepted', events: [] };
	promoteCalls.length = 0;
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
		stub.preview = {
			teams: [{ teamId: 't-1', teamName: 'Lakers', rosterCount: 2, capSpace: 1, capHitTotal: 1, breaches: [] }],
			poolSize: 7
		};
		const result = (await route.load({
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		} as never)) as {
			statuses: unknown[];
			pool: Record<string, unknown>;
			preview: Record<string, unknown>;
			outstanding: string[];
		};

		expect(result.statuses).toEqual(stub.statuses);
		expect(result.pool).toEqual(stub.pool);
		// The preview travels with the status list — one `load`, one render.
		expect(result.preview).toEqual(stub.preview);
		// One list, thirty-one sources: outstanding Teams plus the pool.
		expect(result.outstanding).toEqual(['Lakers', 'Free Agent pool']);
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
			{ kind: 'error', source: 'unknown', fileName: 'Celtics.csv', detail: 'connection refused' },
			warriorsOutcome
		]);
	});
});

describe('actions.upload — pool routing (Story 1.8)', () => {
	function uploadEvent(files: File[]) {
		const form = new FormData();
		for (const file of files) form.append('files', file);
		return {
			request: new Request('https://app.example/import', { method: 'POST', body: form }),
			locals: locals({ kind: 'registered', manager: COMMISSIONER })
		};
	}

	const uploadAction = route.actions.upload as unknown as (event: unknown) => unknown;

	it('routes the pool file to stagePoolFile and every other file to stageRosterFile', async () => {
		const poolOutcome = {
			kind: 'staged',
			source: 'pool',
			fileName: 'free-agents.csv',
			rowCount: 214
		};
		const teamOutcome = {
			kind: 'staged',
			source: 'team',
			teamId: 't-1',
			teamName: 'Lakers',
			fileName: 'Lakers.csv',
			rowCount: 15
		};
		stub.poolOutcomes = [poolOutcome];
		stub.outcomes = [teamOutcome];

		const result = (await uploadAction(
			uploadEvent([
				new File(['x'], 'free-agents.csv', { type: 'text/csv' }),
				new File(['x'], 'Lakers.csv', { type: 'text/csv' })
			])
		)) as { results: unknown[] };

		expect(poolCalls.map((c) => c.fileName)).toEqual(['free-agents.csv']);
		expect(stageCalls.map((c) => c.fileName)).toEqual(['Lakers.csv']);
		expect(result.results).toEqual([poolOutcome, teamOutcome]);
	});

	it('shares one pool batch claim across the drop, so a second pool file sees it', async () => {
		stub.poolOutcomes = [
			{ kind: 'staged', source: 'pool', fileName: 'pool.csv', rowCount: 3 },
			{
				kind: 'refused_file',
				source: 'unknown',
				fileName: 'free-agents-copy.csv',
				detail: 'already supplied'
			}
		];

		await uploadAction(
			uploadEvent([
				new File(['x'], 'pool.csv', { type: 'text/csv' }),
				new File(['x'], 'free-agents-copy.csv', { type: 'text/csv' })
			])
		);

		expect(poolCalls.map((c) => c.fileName)).toEqual(['pool.csv', 'free-agents-copy.csv']);
		expect(stageCalls).toEqual([]);
	});

	it('a throw from stagePoolFile becomes that file result, not an aborted batch', async () => {
		const teamOutcome = {
			kind: 'staged',
			source: 'team',
			teamId: 't-1',
			teamName: 'Lakers',
			fileName: 'Lakers.csv',
			rowCount: 1
		};
		stub.outcomes = [teamOutcome];
		stub.throwOnFileName = 'free-agents.csv';
		stub.throwMessage = 'pool connection reset';

		const result = (await uploadAction(
			uploadEvent([
				new File(['x'], 'free-agents.csv', { type: 'text/csv' }),
				new File(['x'], 'Lakers.csv', { type: 'text/csv' })
			])
		)) as { results: unknown[] };

		expect(result.results).toEqual([
			{
				kind: 'error',
				source: 'unknown',
				fileName: 'free-agents.csv',
				detail: 'pool connection reset'
			},
			teamOutcome
		]);
	});
});


describe('actions.promote — Story 1.9', () => {
	const promoteAction = route.actions.promote as unknown as (event: unknown) => unknown;

	function promoteEvent(
		fields: Record<string, string>,
		session: SessionState = { kind: 'registered', manager: COMMISSIONER },
		phase: ResolvedPhase = SETUP_PHASE
	) {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.append(key, value);
		return {
			request: new Request('https://app.example/import', { method: 'POST', body: form }),
			locals: locals(session, phase)
		};
	}

	it('refuses a non-Commissioner session with 403, before promoting anything', async () => {
		await expectRefusal(
			() => promoteAction(promoteEvent({ confirm: 'yes' }, { kind: 'registered', manager: MANAGER })),
			COMMISSIONER_ONLY_STATUS
		);
		expect(promoteCalls).toEqual([]);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => promoteAction(promoteEvent({ confirm: 'yes' }, { kind: 'signed-out' })),
			COMMISSIONER_ONLY_STATUS
		);
		expect(promoteCalls).toEqual([]);
	});

	it('refuses outside Setup — the destination guard runs on this action too', async () => {
		await expectRefusal(
			() =>
				promoteAction(
					promoteEvent({ confirm: 'yes' }, { kind: 'registered', manager: COMMISSIONER }, AUCTION_PHASE)
				),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(promoteCalls).toEqual([]);
	});

	it('refuses with 400 and writes nothing when the confirm field is missing', async () => {
		const result = (await promoteAction(promoteEvent({}))) as {
			status: number;
			data: { promoteNotice: string };
		};
		expect(result.status).toBe(400);
		expect(result.data.promoteNotice).toContain('not confirmed');
		expect(promoteCalls).toEqual([]);
	});

	it('refuses with 400 when the confirm field carries anything but the expected value', async () => {
		const result = (await promoteAction(promoteEvent({ confirm: 'no' }))) as { status: number };
		expect(result.status).toBe(400);
		expect(promoteCalls).toEqual([]);
	});

	it('refuses with 400 when the acting Commissioner is bound to no Team', async () => {
		// `auction_events.manager_id` and `team_id` are both NOT NULL (AD-4),
		// so an unbound actor has no event to append. It must be refused before
		// the transaction opens, not by a constraint violation inside it — and
		// the sentence comes from the pure core like every other refusal here.
		const unbound: RegisteredManager = { ...COMMISSIONER, teamId: null };
		const result = (await promoteAction(
			promoteEvent({ confirm: 'yes' }, { kind: 'registered', manager: unbound })
		)) as { status: number; data: { promoteNotice: string } };

		expect(result.status).toBe(400);
		expect(result.data.promoteNotice).toBe(promotionRefusalDetail({ kind: 'unbound_actor' }));
		expect(result.data.promoteNotice).toContain('not bound to a Team');
		expect(promoteCalls).toEqual([]);
	});

	it('promotes with the actor resolved server-side from the session, never from the form', async () => {
		stub.promotionOutcome = {
			kind: 'accepted',
			events: [{ seq: '11', occurredAt: '2026-08-25T09:00:00.000Z' }]
		};
		const result = (await promoteAction(
			promoteEvent({ confirm: 'yes', managerId: 'not-me', teamId: 'not-mine' })
		)) as { promoted: { seq: string | null }; promoteNotice: string };

		expect(promoteCalls).toEqual([{ managerId: COMMISSIONER.id, teamId: COMMISSIONER.teamId }]);
		expect(result.promoted.seq).toBe('11');
		expect(result.promoteNotice).toContain('Promoted');
	});

	it('renders the refusal sentence the transaction produced, without rewording it', async () => {
		stub.promotionOutcome = {
			kind: 'rejected',
			reason: {
				refusal: { kind: 'outstanding', sourceNames: ['Lakers'] },
				detail: 'Promotion was refused: every one of the thirty-one sources must be staged first. Outstanding: Lakers.'
			}
		};
		const result = (await promoteAction(promoteEvent({ confirm: 'yes' }))) as {
			status: number;
			data: { promoteNotice: string };
		};
		expect(result.status).toBe(409);
		expect(result.data.promoteNotice).toBe(
			'Promotion was refused: every one of the thirty-one sources must be staged first. Outstanding: Lakers.'
		);
	});
});
