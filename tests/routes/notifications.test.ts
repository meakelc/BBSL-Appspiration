/**
 * The `/notifications` handlers, executed (Story 5.4).
 *
 * The REAL `requireLiveDestination` drives both `load` and the action —
 * nothing about it is mocked — so this proves the route actually calls it, and
 * calls it BEFORE any read. A source-text check could say the call is present;
 * it could not say it runs first, because `toContain` is not position-aware and
 * would stay green if the read were hoisted above the guard. The stubbed
 * preferences module counts its calls precisely so "was it reached at all?" is
 * answerable.
 *
 * The SURFACE assertions are source-text ones, `tests/routes/positions.test.ts`'s
 * idiom for its stated reason: `vite.config.ts` runs tests under
 * `environment: 'node'` and no `.svelte` file can be rendered under this suite.
 * The absence claim — no `$lib/server` import reachable from the page — is
 * provable that way and is the whole point.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';

import {
	MUTABLE_NOTIFICATION_CATEGORY,
	NOTIFICATION_CATEGORIES,
	notificationMuteOutcomeDetail,
	notificationMuteRefusalDetail
} from '../../src/lib/core/notification-categories.ts';
import { LIVE_DESTINATION_REFUSAL_STATUS } from '../../src/lib/server/destinations.ts';
import type { RegisteredManager, SessionState } from '../../src/lib/server/auth.ts';
import type { ResolvedPhase } from '../../src/lib/server/phase.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

const PAGE = readFileSync(at('src', 'routes', 'notifications', '+page.svelte'), 'utf8');

/**
 * The page with every comment stripped — `tests/structure.test.ts`'s
 * discipline for the reason it states there: prose ABOUT a forbidden thing is
 * not that thing.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const PAGE_CODE = stripComments(PAGE);

const stub = vi.hoisted(() => ({
	/** What the stored preference currently is, as `load` would read it. */
	stored: false,
	/** Every read, so "did the guard run first?" is answerable. */
	reads: [] as string[],
	/** Every write, so a refusal can be shown to have written NOTHING. */
	writes: [] as Array<{ managerId: string; muted: boolean }>
}));

vi.mock('$lib/server/notification-preferences.ts', () => ({
	DEFAULT_NOTIFICATION_PREFERENCES: { slotReleaseMuted: false },
	loadNotificationPreferences: async (_gateway: unknown, managerId: string) => {
		stub.reads.push(managerId);
		return { slotReleaseMuted: stub.stored };
	},
	setSlotReleaseMuted: async (_gateway: unknown, managerId: string, muted: boolean) => {
		stub.writes.push({ managerId, muted });
		stub.stored = muted;
		return { slotReleaseMuted: muted };
	}
}));

vi.mock('$lib/shell/db.ts', () => ({
	writeGateway: () => ({
		connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
	})
}));

const route = await import('../../src/routes/notifications/+page.server.ts');

const MANAGER: RegisteredManager = {
	id: 'm-2',
	discordUserId: '222',
	displayName: 'Alice',
	teamId: 't-2',
	teamName: 'Lakers',
	isCommissioner: false
};

const AUCTION_PHASE: ResolvedPhase = { name: 'Auction', sentence: 'Auction.', announcement: null };
const SETUP_PHASE: ResolvedPhase = { name: 'Setup', sentence: 'Setup.', announcement: null };

function locals(session: SessionState, phase: ResolvedPhase = AUCTION_PHASE) {
	return { session, phase };
}

const REGISTERED: SessionState = { kind: 'registered', manager: MANAGER };

/** One form post, as SvelteKit hands an action its request. */
function post(fields: Record<string, string>): { request: { formData(): Promise<FormData> } } {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.append(key, value);
	return { request: { formData: async () => form } };
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
	stub.stored = false;
	stub.reads.length = 0;
	stub.writes.length = 0;
});

describe('load — gated on the destination, before any read', () => {
	it('refuses a registered Manager outside the Auction phase with 403', async () => {
		// The catalog carries `notification-settings` in the Auction phase only,
		// so Setup is a refusal and not an empty page.
		await expectRefusal(
			() => route.load({ locals: locals(REGISTERED, SETUP_PHASE) } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		// **Before any read.** A guard that ran after the read would have
		// disclosed the preference and still returned 403.
		expect(stub.reads).toEqual([]);
	});

	it('refuses a signed-out session with 403', async () => {
		await expectRefusal(
			() => route.load({ locals: locals({ kind: 'signed-out' }) } as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.reads).toEqual([]);
	});

	it('reads THIS Manager’s preference, resolved from the session', async () => {
		stub.stored = true;
		const result = (await route.load({ locals: locals(REGISTERED) } as never)) as {
			slotReleaseMuted: boolean;
		};

		expect(result.slotReleaseMuted).toBe(true);
		// The actor comes from the session and from nowhere else (AD-4/AD-15).
		expect(stub.reads).toEqual([MANAGER.id]);
	});

	it('reads a Manager with no preference row as NOT muted', async () => {
		const result = (await route.load({ locals: locals(REGISTERED) } as never)) as {
			slotReleaseMuted: boolean;
		};

		expect(result.slotReleaseMuted).toBe(false);
	});
});

describe('the mute action — the one mutable category, and only it', () => {
	/** The action, as `minor-league-eligibility.test.ts` reaches its own. */
	const muteAction = route.actions.mute as unknown as (event: unknown) => unknown;

	it('is gated on the destination too, and writes nothing when refused', async () => {
		await expectRefusal(
			() =>
				muteAction({
					...post({ category: MUTABLE_NOTIFICATION_CATEGORY, muted: 'yes' }),
					locals: locals(REGISTERED, SETUP_PHASE)
				} as never),
			LIVE_DESTINATION_REFUSAL_STATUS
		);
		expect(stub.writes).toEqual([]);
	});

	it('accepts a mute of the one mutable category and states the outcome', async () => {
		const result = (await muteAction({
			...post({ category: MUTABLE_NOTIFICATION_CATEGORY, muted: 'yes' }),
			locals: locals(REGISTERED)
		} as never)) as { notice: string; slotReleaseMuted: boolean };

		expect(stub.writes).toEqual([{ managerId: MANAGER.id, muted: true }]);
		expect(result.slotReleaseMuted).toBe(true);
		// Worded in the pure core, printed by the route — never re-worded here.
		expect(result.notice).toBe(notificationMuteOutcomeDetail(true));
	});

	it('accepts an unmute the same way', async () => {
		stub.stored = true;
		const result = (await muteAction({
			...post({ category: MUTABLE_NOTIFICATION_CATEGORY, muted: 'no' }),
			locals: locals(REGISTERED)
		} as never)) as { notice: string; slotReleaseMuted: boolean };

		expect(stub.writes).toEqual([{ managerId: MANAGER.id, muted: false }]);
		expect(result.slotReleaseMuted).toBe(false);
		expect(result.notice).toBe(notificationMuteOutcomeDetail(false));
	});

	/** Every category the story refuses to make mutable, by id. */
	const UNMUTABLE = NOTIFICATION_CATEGORIES.filter(
		(category) => category.unmutableReason !== null
	).map((category) => category.id);

	it('names all four unmutable categories, so this suite cannot silently shrink', () => {
		expect(UNMUTABLE).toEqual(['outbid', 'led_at_close', 'contender', 'contract_assignment']);
	});

	it.each(UNMUTABLE)(
		'refuses a direct request to mute %s, server-side, and writes nothing',
		async (category: string) => {
			// The acceptance criterion, asserted WITHOUT going through the page:
			// the control's absence from the surface is not the check.
			const result = (await muteAction({
				...post({ category, muted: 'yes' }),
				locals: locals(REGISTERED)
			} as never)) as { status: number; data: { notice: string } };

			expect(result.status).toBe(400);
			expect(result.data.notice).toBe(
				notificationMuteRefusalDetail({
					kind: 'unmutable_category',
					category: category as 'outbid'
				})
			);
			expect(stub.writes).toEqual([]);
		}
	);

	it('refuses an id no module names, with the same shape', async () => {
		const result = (await muteAction({
			...post({ category: 'nomination_warning', muted: 'yes' }),
			locals: locals(REGISTERED)
		} as never)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(
			notificationMuteRefusalDetail({ kind: 'unknown_category', requested: 'nomination_warning' })
		);
		expect(stub.writes).toEqual([]);
	});

	it('refuses a submission naming no category at all', async () => {
		const result = (await muteAction({
			...post({ muted: 'yes' }),
			locals: locals(REGISTERED)
		} as never)) as { status: number; data: { notice: string } };

		expect(result.status).toBe(400);
		expect(result.data.notice).toBe(
			notificationMuteRefusalDetail({ kind: 'unknown_category', requested: '' })
		);
		expect(stub.writes).toEqual([]);
	});

	it('refuses a submission that states neither direction', async () => {
		// `muted=toString` specifically: a lookup object would have resolved it
		// to an inherited `Object.prototype` member and passed an "is this a
		// known direction?" check with a Function bound as the value.
		for (const muted of ['', 'maybe', 'toString', 'true']) {
			const result = (await muteAction({
				...post({ category: MUTABLE_NOTIFICATION_CATEGORY, muted }),
				locals: locals(REGISTERED)
			} as never)) as { status: number; data: { notice: string } };

			expect(result.status).toBe(400);
			expect(result.data.notice).toBe(
				notificationMuteRefusalDetail({ kind: 'unstated_target' })
			);
		}
		expect(stub.writes).toEqual([]);
	});

	it('refuses the unmutable category BEFORE the direction, so the sentence names the real cause', async () => {
		const result = (await muteAction({
			...post({ category: 'outbid' }),
			locals: locals(REGISTERED)
		} as never)) as { data: { notice: string } };

		expect(result.data.notice).toContain('cannot be muted');
	});
});

describe('the surface', () => {
	it('imports nothing from $lib/server', () => {
		// Server-only modules must never be reachable from a `.svelte` file.
		expect(PAGE_CODE).not.toContain('$lib/server');
	});

	it('words no CATEGORY copy of its own: those sentences come from the pure core', () => {
		expect(PAGE_CODE).toContain("from '$lib/core/notification-categories.ts'");
		// Every per-category sentence — each statement, each reason, and what
		// muting does and does not do — is PRINTED from the core and never
		// spelled here, so the page cannot drift from the refusal a direct POST
		// receives. The page's own framing paragraph is a different thing and is
		// its to word, exactly as `/minor-league-eligibility`'s is.
		expect(PAGE_CODE).not.toContain('fairness premise');
		expect(PAGE_CODE).not.toContain('Nomination Slot your Team was holding');
		expect(PAGE_CODE).not.toContain('Muting withholds your mention, never the post');
		expect(PAGE_CODE).not.toContain('a Contract is decided');
	});

	it('carries no exclamation mark in anything it renders', () => {
		// The voice rule. Comments are stripped first — `<!--` is punctuation
		// belonging to HTML and not to the copy — and `!==`, `!=` and Svelte's
		// `{!x}` are excluded, being operators rather than punctuation.
		expect(PAGE_CODE.replace(/!==?/g, '').replace(/\{!/g, '{')).not.toContain('!');
	});

	it('renders the unmutable categories rather than hiding them', () => {
		expect(PAGE_CODE).toContain('unmutableReason');
		expect(PAGE_CODE).toContain('unmutable-categories');
	});

	it('states the direction in the form rather than inferring it', () => {
		expect(PAGE_CODE).toContain('name="category"');
		expect(PAGE_CODE).toContain('name="muted"');
	});

	it('spells no tokenised value as a literal, and declares no second layout', () => {
		// Single-column at 375px is the BASE and the only layout: the one
		// breakpoint in this codebase is `@media (min-width: 640px)`, and this
		// page declares none.
		expect(PAGE_CODE).not.toContain('@media');
		expect(PAGE_CODE).not.toContain('44px');
		expect(PAGE_CODE).not.toContain('46px');
	});
});
