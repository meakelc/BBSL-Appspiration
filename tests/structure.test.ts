import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const at = (...parts: string[]): string => join(ROOT, ...parts);

/**
 * The AR-2 source tree, verbatim from ARCHITECTURE-SPINE.md. Later stories fill
 * these directories; this story's job is that they exist and are named exactly
 * right, so nobody has to re-decide where a module lives.
 */
const AR2_DIRECTORIES: Array<[path: string, purpose: string]> = [
	['src/lib/core', 'PURE — no I/O, no clock, no randomness, stdlib only'],
	['src/lib/core/rules', 'evaluate() -> GateResults; decide() -> Accepted | Rejected'],
	['src/lib/core/projection', 'event folds -> current state, ordered by seq'],
	['src/lib/shell', 'lock -> load -> decide -> persist -> enqueue'],
	['src/lib/adapters/fantrax', 'the ONLY module that knows CSV column names'],
	['src/lib/adapters/discord', 'webhook posts and @mention payloads'],
	['src/lib/server', 'supabase clients, Discord OAuth, service-role access'],
	['src/routes', 'SvelteKit pages and form actions'],
	['supabase/migrations', 'the only way schema changes (AD-26)'],
	['supabase/functions/tick', 'ONE cron-invoked function: sweep then drain'],
	['tests/examples', 'PRD §10 examples 1-28, one test each']
];

/**
 * The §10 examples that exist as named tests today (AD-25).
 *
 * AD-25 requires all 28 eventually; the epics assign them story by story, and
 * a directory that merely EXISTS proves nothing about whether the examples in
 * it were written. This list grows as each story lands its own — Story 2.5
 * landed 1, 2, 15 and 26; Story 2.6 added 3, 4, 5 and 23; Story 2.7 added 24;
 * Story 2.8 added 18, 19, 20 and 25, the Minors Exposure set — so a file
 * deleted or renamed away fails here rather than silently reducing the
 * executable specification.
 *
 * **Story 3.1 added NONE, and that is recorded rather than left to look like
 * a miss.** Expiry-as-authority owns no §10 example of its own.
 *
 * **Story 3.2 added FIVE — 6, 7, 10, 21 and 22** — the Minimum-Bid Contention
 * set: the lottery opening, three joins that do not move the clock, the dead
 * zone between the two thresholds, and the two capital examples that are the
 * whole of what widening `teamMoneyStateFor` from the leader to every
 * Contender changed.
 *
 * **Story 3.3 added ONE — 9** — the dissolution: the conversion at
 * $1,500,000 that releases every Contender, resets the clock, reveals the
 * sealed seed and returns the Auction to ordinary ascending rules.
 *
 * **Story 3.4 added TWO — 16 and 17** — the Slot Placement pair: the stash
 * into the third Minor League Slot at a $0 Cap Hit, and the second win that
 * overflows into Active/Bench because the FIRST close was committed before it
 * was evaluated. 17 imports 16's produced state rather than restating its
 * numbers, which is AD-11's sequential ordering as an executable claim.
 *
 * **Story 3.5 added NONE, and that is recorded rather than left to look like a
 * miss.** The tick is mechanism, not a rule a §10 example states: the sweep's
 * AD-11 ordering claim is proven directly in
 * `tests/server/sweep-sequential.test.ts`, which asserts both that the
 * sequential shape produces example 17's answer AND that the batch shape fails.
 *
 * **Story 3.6 added TWO — 8 and 11** — the draw pair: the four-Contender
 * lottery whose seed selects Team G and releases the other three alongside
 * Team D's Nomination Slot, and the single-Contender lottery that resolves to
 * its one Contender with no special case and records a one-team list. 8 picks
 * up the log examples 6 and 7 built rather than restating it.
 *
 * **Story 3.7 added the last TWO of Epic 3's — 13 and 27** — the League Clock
 * pair, which 3.6's note above named as 3.7's before either existed: the close
 * that does not reset the clock, and the voided Bid that shortens it. 27 is
 * driven against a STATE LITERAL carrying both the `BidPlaced` and the
 * `BidVoided`, because nothing in this codebase appends a void — Story 7.2
 * owns that, and this test is what lets it append one against a fold already
 * proven to survive it.
 *
 * **Story 4.6 added ONE — 28** — the League Median, and it is the first §10
 * example that is not about a gate at all. It drives `core/money.ts`'
 * `medianMoney` and `medianCount` directly, because the median is a read-model
 * aggregate that authorises nothing and therefore lives with the money
 * arithmetic rather than behind `evaluate()` (`ARCHITECTURE-SPINE.md:122`).
 * Both halves — the money and the slots — are in the one file, because they
 * are one rule with two comparators and the file is where they would be caught
 * disagreeing.
 */
const SECTION_10_EXAMPLES: Array<[file: string, example: string]> = [
	['example-01-ordinary-raise.test.ts', '1 — Ordinary raise'],
	['example-02-insufficient-increment.test.ts', '2 — Insufficient increment, and off-grid'],
	['example-03-roster-reserve-bites.test.ts', '3 — Roster reserve bites'],
	['example-04-reserve-clears.test.ts', '4 — Reserve clears as commitments accumulate'],
	['example-05-outbid-frees-capital.test.ts', '5 — Outbid frees capital immediately'],
	['example-06-lottery-opens.test.ts', '6 — Lottery opens'],
	[
		'example-07-lottery-grows-clock-unmoved.test.ts',
		'7 — Lottery grows, clock unmoved'
	],
	['example-08-lottery-draws.test.ts', '8 — Lottery draws'],
	['example-09-the-lottery-dissolves.test.ts', '9 — Lottery dissolves'],
	['example-10-the-dead-zone.test.ts', '10 — The dead zone'],
	[
		'example-11-single-contender-lottery.test.ts',
		'11 — Single-contender lottery'
	],
	['example-13-league-clock.test.ts', '13 — A close is not a League Clock reset'],
	[
		'example-14-allotment-exhaustion.test.ts',
		'14 — Allotment exhaustion'
	],
	['example-15-co-manager-race.test.ts', '15 — Co-manager race'],
	[
		'example-16-retired-the-win-that-cannot-land-in-minors.test.ts',
		'16 — The win that cannot land in minors (retired 2026-09-18)'
	],
	[
		'example-17-retired-there-is-no-minors-overflow.test.ts',
		'17 — There is no minors overflow (retired 2026-09-18)'
	],
	[
		'example-18-retired-stashing-no-longer-beats-the-cap.test.ts',
		'18 — Stashing no longer beats the cap (retired 2026-09-18)'
	],
	[
		'example-19-retired-the-cheap-bid-is-still-refused.test.ts',
		'19 — The cheap bid is still refused (retired 2026-09-18)'
	],
	[
		'example-20-retired-a-resolved-win-stops-being-a-commitment.test.ts',
		'20 — A resolved win stops being a commitment (retired 2026-09-18)'
	],
	[
		'example-21-retired-every-lottery-entry-commits.test.ts',
		'21 — Every lottery entry commits (retired 2026-09-18)'
	],
	[
		'example-22-retired-the-lottery-was-already-committed.test.ts',
		'22 — The lottery was already committed (retired 2026-09-18)'
	],
	['example-23-ir-does-not-fill-the-twelve.test.ts', '23 — IR does not fill the twelve'],
	[
		'example-24-full-roster-ends-non-eligible-bidding.test.ts',
		'24 — A full roster ends non-eligible bidding, money or not'
	],
	[
		'example-25-retired-the-full-roster-cannot-stash.test.ts',
		'25 — The full roster cannot stash (retired 2026-09-18)'
	],
	['example-26-off-grid-everywhere.test.ts', '26 — Off-grid amounts are refused everywhere'],
	[
		'example-27-a-voided-bid-shortens-the-clock.test.ts',
		'27 — A voided Bid shortens the League Clock'
	],
	[
		'example-28-the-median-lands-between-two-grid-values.test.ts',
		'28 — The median lands between two grid values'
	],
	// Added 2026-09-08 with the Outstanding Bid Allowance (FR-37) and Bid
	// Cancellation (FR-40). Story 10.1 lands the first two.
	[
		'example-29-the-allowance-in-the-ordinary-case.test.ts',
		'29 — The allowance, in the ordinary case'
	],
	[
		'example-30-the-allowance-needs-a-slot-to-extend.test.ts',
		'30 — The allowance needs a slot to extend'
	],
	// Story 10.3 landed the cancellation cascade, and 31 with it; Story 10.4
	// added the restoration its last sentences narrate, and 32 and 33 beside
	// it — the skipped candidate and the Auction with nothing to restore.
	[
		'example-31-the-cascade-fires-only-as-far-as-it-must.test.ts',
		'31 — The cascade fires, and only as far as it must'
	],
	[
		'example-32-a-restoration-that-is-skipped-not-undone.test.ts',
		'32 — A restoration that is skipped, not undone'
	],
	[
		'example-33-a-restoration-with-nothing-to-restore.test.ts',
		'33 — A restoration with nothing to restore'
	],
	// Story 10.2 landed the bidding half of the two below and Story 10.3 the
	// close half of each. The draws they narrate belong to Story 10.5.
	[
		'example-34-unlimited-lotteries.test.ts',
		'34 — Unlimited lotteries, and the one win that ends them'
	],
	[
		'example-35-retired-a-full-roster-enters-no-lottery.test.ts',
		'35 — A full roster enters no lottery (retired 2026-09-18)'
	],
	// 36-39 and 42 are Story 7.7's Roster Trade examples (FR-41), landed with
	// the `RecordRosterTrade` command. 42 sits out of sequence below because
	// 40 and 41 landed first with Story 7.6's rookie-scale designation; Story
	// 7.8 landed the `RecordDrop` command those two describe, and 43 with it.
	[
		'example-36-the-trade-that-clears-the-room.test.ts',
		'36 — The trade that clears the room'
	],
	[
		'example-37-the-team-pushed-over-by-giving-something-away.test.ts',
		'37 — The Team pushed over by giving something away'
	],
	[
		'example-38-the-stash-that-becomes-expensive-by-moving.test.ts',
		'38 — The stash that becomes expensive by moving'
	],
	['example-39-one-act-evaluated-once.test.ts', '39 — One act, evaluated once'],
	[
		'example-40-a-drop-lowers-the-maximum-bid.test.ts',
		'40 — A Drop lowers the Maximum Bid'
	],
	[
		'example-41-retired-the-three-characters-decide-nothing.test.ts',
		'41 — The three characters that decide nothing (retired 2026-09-16)'
	],
	[
		'example-42-a-won-player-traded-after-the-auction-phase.test.ts',
		'42 — A won Player traded after the Auction Phase'
	],
	// Story 7.8's Drop command (FR-43). 43 is new with it, and 40 and 41 gain
	// a command-driven derivation beside 7.6's hand-built fixtures — 43 is the
	// one that moves Maximum Bid in the OPPOSITE direction from 40, which is
	// the test that stops FR-43 being read as a flat rule.
	[
		'example-43-a-stashed-drop-moves-the-maximum-bid-the-other-way.test.ts',
		'43 — A stashed Drop moves the Maximum Bid the other way'
	],
	// Story 7.11's Roster Move (FR-44) lands the last THREE. 44 is example 39's
	// lesson reached by a different act — a swap that is legal as one act and
	// refused one leg at a time, so the file runs the sequenced order as the
	// regression test. 45 is the mirror of 40 on the Move side: Cap Space falls
	// and Maximum Bid RISES, which is why the sheet computes the direction
	// rather than asserting it. 46 is the first §10 example about what the app
	// KNOWS rather than what it can compute — two roster rows that are
	// indistinguishable in `team_rosters` and are told apart by the log alone.
	[
		'example-44-the-optimization-after-the-trade.test.ts',
		'44 — The optimization after the trade'
	],
	[
		'example-45-the-move-that-costs-bidding-power-by-spending-cap.test.ts',
		'45 — The Move that costs bidding power by spending cap'
	],
	[
		'example-46-the-promotion-the-app-must-refuse-and-the-one-it-must-allow.test.ts',
		'46 — The promotion the app must refuse, and the one it must allow'
	]
];

const AR2_FILES: Array<[path: string, purpose: string]> = [
	['src/lib/core/money.ts', 'branded integer-dollar type and parsers (AD-8)'],
	['src/lib/core/constants.ts', 'league constants AND the AD-6 lock key'],
	['src/lib/core/types.ts', 'commands, events, rejections, state'],
	['src/lib/core/projection/fold.ts', 'the generic fold/rebuild reducer, ordered by seq (AD-5)'],
	['src/lib/shell/db.ts', 'the pooled direct-Postgres connection (AD-6)'],
	['src/lib/shell/write.ts', 'lock -> load -> decide -> persist -> enqueue (AD-4, AD-6)']
];

describe('the AR-2 source tree', () => {
	it.each(AR2_DIRECTORIES)('has %s — %s', (path: string) => {
		const full = at(...path.split('/'));
		expect(existsSync(full), `${path} is missing`).toBe(true);
		expect(statSync(full).isDirectory(), `${path} is not a directory`).toBe(true);
	});

	it.each(AR2_FILES)('has %s — %s', (path: string) => {
		expect(existsSync(at(...path.split('/'))), `${path} is missing`).toBe(true);
	});

	it('keeps every otherwise-empty AR-2 directory in git', () => {
		// src/lib/core/projection and src/lib/shell moved to the real-file
		// assertion below in Story 1.5; src/lib/core/rules and
		// src/lib/adapters/fantrax move there too in Story 1.7, which is the
		// first to write into either — a .gitkeep the directory no longer needs
		// is what deferred-work.md's own entry flagged: "each marker should be
		// deleted the moment a real file lands there."
		const wouldBeEmpty = ['src/lib/server', 'supabase/migrations'];
		for (const path of wouldBeEmpty) {
			const marker = at(...path.split('/'), '.gitkeep');
			expect(existsSync(marker), `${path}/.gitkeep is missing — git will not track it`).toBe(true);
		}
	});

	it.each(SECTION_10_EXAMPLES)('holds tests/examples/%s — §10 example %s', (file: string) => {
		expect(existsSync(at('tests', 'examples', file)), `tests/examples/${file} is missing`).toBe(
			true
		);
	});

	it('holds nothing in tests/examples but real example tests', () => {
		// The marker is gone and every file left is one of the examples above:
		// a stray fixture or a leftover .gitkeep both fail here.
		const entries = readdirSync(at('tests', 'examples')).sort();
		expect(entries).toEqual(SECTION_10_EXAMPLES.map(([file]) => file).sort());
	});

	it('deletes the .gitkeep from every directory that now holds a real file', () => {
		for (const path of [
			'src/lib/core/projection',
			'src/lib/shell',
			'src/lib/core/rules',
			'src/lib/adapters/fantrax',
			// Story 2.5 writes the first real files into tests/examples — the
			// §10 examples AD-25 calls the executable specification. AGENTS.md
			// named this exact trap: leaving the marker fails the assertion
			// above, and deleting it without moving the entry here fails this
			// one. Both halves move together or neither does.
			'tests/examples',
			// Story 3.5 writes the first real files into
			// supabase/functions/tick — the Deno half of "one sweep module,
			// two runtimes" (AD-2): index.ts, gateway.ts, adapt.ts, auth.ts,
			// deno.json and deno.lock. The same trap, moved the same way.
			// (adapt.ts and auth.ts are the pieces held structurally typed and
			// import-free so `npm test` can execute them; gateway.ts and
			// index.ts are what genuinely needs Deno.)
			'supabase/functions/tick',
			// Story 5.1 writes the first real file into
			// src/lib/adapters/discord — `webhook.ts`, AR-2's "webhook posts +
			// @mention payloads (allowed_mentions)". The last of the AR-2
			// directories to be filled, and the same trap moved the same way:
			// the entry leaves `wouldBeEmpty` above and the marker is deleted in
			// the one change, or the suite fails either way.
			'src/lib/adapters/discord'
		]) {
			const marker = at(...path.split('/'), '.gitkeep');
			expect(existsSync(marker), `${path}/.gitkeep should be gone now that it holds real files`).toBe(
				false
			);
		}
	});
});

// The pure-core boundary was checked here against a hardcoded three-file list,
// and its stated ".ts imports only" rule did not hold — `from './money'` passed
// it and fails to load under Deno. Story 1.2 replaced it with a recursive walk;
// see scripts/check-core-purity.js and tests/purity.test.ts.

describe('the stack configuration', () => {
	it('runs the Netlify adapter with edge: false', () => {
		const config = readFileSync(at('svelte.config.js'), 'utf8');
		expect(config).toContain('@sveltejs/adapter-netlify');
		expect(config).toMatch(/edge\s*:\s*false/);
		expect(config, 'edge functions are not this stack').not.toMatch(/edge\s*:\s*true/);
	});

	it('turns on strict and noUncheckedIndexedAccess', () => {
		const tsconfig = readFileSync(at('tsconfig.json'), 'utf8');
		expect(tsconfig).toMatch(/"strict"\s*:\s*true/);
		expect(tsconfig).toMatch(/"noUncheckedIndexedAccess"\s*:\s*true/);
	});

	it('points Vitest at tests/', () => {
		const vite = readFileSync(at('vite.config.ts'), 'utf8');
		expect(vite).toContain('sveltekit()');
		expect(vite).toContain('tests/**/*.test.ts');
	});

	it('has src/lib/components — a natural SvelteKit addition, not in the original AR-2 tree', () => {
		// Story 1.6 is the first to render a Svelte component reused across
		// surfaces (DestinationsList, HeaderMenu). AR-2's tree, fixed before any
		// UI component existed, names no directory for it; this is not a spine
		// violation, just the tree growing the way a SvelteKit app does.
		const full = at('src', 'lib', 'components');
		expect(existsSync(full), 'src/lib/components is missing').toBe(true);
		expect(statSync(full).isDirectory(), 'src/lib/components is not a directory').toBe(true);
	});

	it('has src/lib/client — the browser-only counterpart to src/lib/server', () => {
		// Story 4.1 is the first to need browser-only code that is not a
		// component: the Realtime subscription, the liveness poll and the runes
		// that hold their result. AR-2's tree names `lib/server` and `lib/shell`
		// but no browser side, because before this story there was none. This
		// follows `src/lib/components`' precedent above exactly — the tree
		// growing the way a SvelteKit app does, not a spine violation.
		const full = at('src', 'lib', 'client');
		expect(existsSync(full), 'src/lib/client is missing').toBe(true);
		expect(statSync(full).isDirectory(), 'src/lib/client is not a directory').toBe(true);
	});

	it('keeps src/lib/client free of anything server-only', () => {
		// The mirror of the rule `lib/server` enforces in the other direction: a
		// module reachable from the browser bundle must never import the
		// service-role client or read a non-PUBLIC_ variable (AD-16).
		const walk = (directory: string): string[] =>
			readdirSync(directory).flatMap((entry) => {
				const full = join(directory, entry);
				return statSync(full).isDirectory() ? walk(full) : [full];
			});
		for (const file of walk(at('src', 'lib', 'client'))) {
			const source = readFileSync(file, 'utf8');
			expect(source, `${file} imports server-only code`).not.toMatch(
				/\$lib\/server|\$env\/dynamic\/private|\$env\/static\/private/
			);
			expect(source, `${file} names a non-public variable`).not.toMatch(
				/SERVICE_ROLE|SUPABASE_DB_URL|DISCORD_WEBHOOK/
			);
		}
	});

	it('states rather than hides an empty destination list — AC7', () => {
		// The behaviour itself (`hasNothingLive`) is proven directly in
		// tests/destinations-view.test.ts; no .svelte file can be rendered
		// under this suite's vite.config (see tests/signin-surface.test.ts's
		// own note), so this proves the component actually renders the
		// sentence for that state the same way tests/signin-surface.test.ts
		// proves other markup claims — by reading source text.
		const list = readFileSync(at('src', 'lib', 'components', 'DestinationsList.svelte'), 'utf8');
		expect(list).toContain('classified.hasNothingLive');
		expect(list).toContain('Nothing is live for you right now.');
	});

	/**
	 * Dead Money renders labelled and SEPARATE, and its two absences are
	 * deliberate (Story 7.6, UX-DR40).
	 *
	 * Both claims live in markup a `.svelte` file cannot be rendered under
	 * this suite's vite.config, so they are proven the way every other markup
	 * claim in this file is proven — by reading source text. The behaviour
	 * behind them is proven directly in tests/team-view.test.ts and
	 * tests/teams-index.test.ts; what is at stake HERE is that the two
	 * conditionals cannot be deleted, or quietly inverted into always-render,
	 * without a test going red.
	 */
	it('suppresses the EMPTY Dead Money group and the absent Dead Money figure', () => {
		const teamPage = readFileSync(at('src', 'routes', 'teams', '[teamId]', '+page.svelte'), 'utf8');
		// `groupRoster` produces all four groups always — that is the AD-32
		// fix and it must stay — so the page is what declines to print a
		// heading over zero rows. The other three groups still render empty:
		// an absent Minor League group and an empty one say different things.
		expect(teamPage).toContain(
			"{#if group.slotKind !== 'dead_money' || group.entries.length > 0}"
		);
		// And the figure beside Injury Reserve, absent rather than $0.0M.
		expect(teamPage).toContain('{#if team.deadMoneyHalves !== null}');
		expect(teamPage).toContain('id="team-dead-money"');

		const index = readFileSync(at('src', 'routes', 'teams', '+page.svelte'), 'utf8');
		// A card lists no rows, so this line is the only thing on it that
		// reconciles a Cap Space reduced by released Contracts.
		expect(index).toContain('{#if row.deadMoneyHalves !== null}');
		expect(index).toContain('teams-dead-money-');
	});

	it('serves a real page from a layout that loads the design tokens', () => {
		expect(existsSync(at('src', 'app.html'))).toBe(true);
		expect(existsSync(at('src', 'app.d.ts'))).toBe(true);
		expect(existsSync(at('src', 'routes', '+page.svelte'))).toBe(true);
		const layout = readFileSync(at('src', 'routes', '+layout.svelte'), 'utf8');
		expect(layout).toContain('global.css');
	});
});

describe('the page uses the control classes it establishes', () => {
	// Swapping the Commissioner control's class to `control-manager` left every
	// test green: commissioner.test.ts reads the stylesheet, not the markup, so a
	// referee control rendered as a player control was invisible to the suite —
	// the exact confusion the class exists to prevent.
	const page = readFileSync(at('src', 'routes', '+page.svelte'), 'utf8');

	function blockFor(className: string): string {
		const pattern = new RegExp(`<section class="${className}"[\\s\\S]*?</section>`);
		const match = pattern.exec(page);
		expect(match, `+page.svelte has no <section class="${className}">`).not.toBeNull();
		return match?.[0] ?? '';
	}

	it('renders the Commissioner control inside a Commissioner block', () => {
		const block = blockFor('commissioner-block');
		expect(block, 'the Commissioner block carries no Commissioner control').toContain(
			'class="control-commissioner"'
		);
		expect(block, 'a Manager control must never sit in a Commissioner block').not.toContain(
			'control-manager'
		);
	});

	it('renders the Manager control inside a Manager block', () => {
		const block = blockFor('manager-block');
		expect(block).toContain('class="control-manager"');
		expect(block, 'a Commissioner control must never sit in a Manager block').not.toContain(
			'control-commissioner'
		);
	});

	it('states every disabled control’s reason and associates it with the control', () => {
		// A disabled control always carries its reason beside it — that association
		// is the entire justification for text-disabled being exempt from WCAG
		// 1.4.3, so it has to be a real association, not mere adjacency.
		const controls = [...page.matchAll(/<button\b[\s\S]*?>/g)].map((match) => match[0]);
		expect(controls.length, '+page.svelte renders no controls').toBeGreaterThan(0);

		for (const control of controls) {
			if (!/\bdisabled\b/.test(control)) continue;
			const described = /aria-describedby="([^"]+)"/.exec(control);
			expect(described, `a disabled control states no reason: ${control}`).not.toBeNull();
			for (const id of (described?.[1] ?? '').split(/\s+/)) {
				expect(page, `aria-describedby="${id}" points at nothing`).toContain(`id="${id}"`);
			}
		}
	});
});

describe('secrets', () => {
	it('names every required variable and separates server-only from client-inlined', () => {
		const example = readFileSync(at('.env.example'), 'utf8');
		for (const name of [
			'SUPABASE_URL',
			'SUPABASE_SERVICE_ROLE_KEY',
			'SUPABASE_DB_URL',
			'DISCORD_CLIENT_ID',
			'DISCORD_CLIENT_SECRET',
			'DISCORD_WEBHOOK_URL',
			'PUBLIC_SUPABASE_ANON_KEY'
		]) {
			expect(example, `${name} is not named in .env.example`).toContain(name);
		}
		expect(example).toContain('NO SECRET MAY TAKE A PUBLIC_ PREFIX');
	});

	it('puts no secret behind a PUBLIC_ prefix', () => {
		const example = readFileSync(at('.env.example'), 'utf8');
		const publicNames = [...example.matchAll(/^(PUBLIC_[A-Z0-9_]+)=/gm)].map((m) => m[1] ?? '');
		expect(publicNames.length).toBeGreaterThan(0);
		for (const name of publicNames) {
			expect(name, `${name} looks like a secret behind a PUBLIC_ prefix`).not.toMatch(
				/SECRET|SERVICE_ROLE|PASSWORD|TOKEN|WEBHOOK|PRIVATE|JWT/
			);
		}
	});

	it('carries no value in the committed example', () => {
		const example = readFileSync(at('.env.example'), 'utf8');
		for (const line of example.split(/\r?\n/)) {
			if (line.trim().startsWith('#') || line.trim() === '') continue;
			expect(line, `"${line}" carries a value`).toMatch(/^[A-Z0-9_]+=$/);
		}
	});

	it('ignores .env but keeps the example', () => {
		const gitignore = readFileSync(at('.gitignore'), 'utf8');
		for (const entry of ['node_modules', '.svelte-kit', 'build', '.env']) {
			expect(gitignore, `${entry} is not ignored`).toMatch(
				new RegExp(`^${entry.replace('.', '\\.')}`, 'm')
			);
		}
		expect(gitignore).toMatch(/^!\.env\.example$/m);
	});
});

/**
 * Story 2.3's AC2, as a gate rather than a grep.
 *
 * The criterion is a NEGATIVE invariant — the Slot's release "is computed by
 * the fold with no stored flag toggled by a handler, nothing reading
 * `open_nominations`, and no trigger but a close — not a timer, not being
 * outbid, not elapsed time". That spec's Verification section proves it by
 * hand with `rg`, which proves it once, on the day somebody runs it. These
 * are the same three checks, executed.
 *
 * Comments are stripped before matching: prose ABOUT the claim table (the
 * migration's reasoning, `pg-errors.ts`'s note) is not a read of it.
 */
describe('AC2 — the Nomination Slot is released by the fold, never by a stored flag', () => {
	const SOURCE = /\.(ts|svelte)$/;

	/** Every source file under src/, recursively. */
	function sources(dir = 'src', found: string[] = []): string[] {
		for (const entry of readdirSync(at(...dir.split('/')), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) sources(path, found);
			else if (SOURCE.test(entry.name)) found.push(path);
		}
		return found;
	}

	/** A file's code with every comment removed. */
	function code(path: string): string {
		return readFileSync(at(...path.split('/')), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
	}

	it.each([
		['open_nominations', /open_nominations|OPEN_NOMINATIONS_TABLE/],
		['nomination_slots', /nomination_slots|NOMINATION_SLOTS_TABLE/]
	])('names %s in exactly one module — each claim table has one owner', (_table, pattern) => {
		const naming = sources().filter((path) => pattern.test(code(path)));
		expect(naming).toEqual(['src/lib/server/nomination.ts']);
	});

	it.each([
		// The board seat: one INSERT, and TWO deletes since Story 3.7 — a close
		// and a termination end an Auction alike, and both return the Player to
		// the pool.
		['OPEN_NOMINATIONS_TABLE', ['delete from', 'delete from', 'insert into']],
		// The Nomination Slot: one INSERT, and exactly ONE delete, because only
		// a win frees a Slot (FR-9 amended). A second delete here would be a
		// second way to free one, and the termination path is precisely the one
		// that must not have it.
		['NOMINATION_SLOTS_TABLE', ['delete from', 'insert into']]
	])('issues only INSERTs and DELETEs against %s, and never a SELECT', (table, expected) => {
		// "Nothing reads the claim tables to answer a question" (Story 2.2's
		// Always, carried into 2.3): they are write-side constraints, and the
		// answer to "is this Slot held" is the fold over `auction_events`.
		const statements = [
			...code('src/lib/server/nomination.ts').matchAll(
				new RegExp(
					String.raw`\b(select|insert into|update|delete from)\b[^;\`]*?\$\{${table}\}`,
					'gi'
				)
			)
		].map((match) => (match[1] ?? '').toLowerCase());

		expect(statements.sort()).toEqual(expected);
	});

	it('folds exactly three events — two of them release, and nothing else does', () => {
		// Story 3.7 added the third: an `AuctionTerminated` frees the board seat
		// a close frees, because the League Clock ran out with that Player still
		// Awaiting an Opening Bid. It frees no Nomination Slot — since FR-8 was
		// amended only a win does that, and a termination has no winner. There
		// is still no fourth case, and in particular no timer of any kind.
		const nominations = code('src/lib/core/projection/nominations.ts');
		const cases = [...nominations.matchAll(/case\s+([A-Z_]+):/g)].map((match) => match[1]);

		expect(cases).toEqual([
			'NOMINATION_PLACED_EVENT',
			'AUCTION_TERMINATED_EVENT',
			'AUCTION_CLOSED_EVENT'
		]);
		// No timer, no elapsed time, no wall clock: the trigger is the event.
		expect(nominations).not.toMatch(/Date\.now|new Date\(|setTimeout|setInterval/);
	});
});
