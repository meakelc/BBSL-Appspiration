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
 * landed 1, 2, 15 and 26; Story 2.6 added 3, 4, 5 and 23; Story 2.7 adds 24 —
 * so a file deleted or renamed away fails here rather than silently reducing
 * the executable specification.
 */
const SECTION_10_EXAMPLES: Array<[file: string, example: string]> = [
	['example-01-ordinary-raise.test.ts', '1 — Ordinary raise'],
	['example-02-insufficient-increment.test.ts', '2 — Insufficient increment, and off-grid'],
	['example-03-roster-reserve-bites.test.ts', '3 — Roster reserve bites'],
	['example-04-reserve-clears.test.ts', '4 — Reserve clears as commitments accumulate'],
	['example-05-outbid-frees-capital.test.ts', '5 — Outbid frees capital immediately'],
	['example-15-co-manager-race.test.ts', '15 — Co-manager race'],
	['example-23-ir-does-not-fill-the-twelve.test.ts', '23 — IR does not fill the twelve'],
	[
		'example-24-full-roster-ends-non-eligible-bidding.test.ts',
		'24 — A full roster ends non-eligible bidding, money or not'
	],
	['example-26-off-grid-everywhere.test.ts', '26 — Off-grid amounts are refused everywhere']
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
		const wouldBeEmpty = [
			'src/lib/adapters/discord',
			'src/lib/server',
			'supabase/migrations',
			'supabase/functions/tick'
		];
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
			'tests/examples'
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

	it('names open_nominations in exactly one module — the claim table has one owner', () => {
		const naming = sources().filter((path) =>
			/open_nominations|OPEN_NOMINATIONS_TABLE/.test(code(path))
		);
		expect(naming).toEqual(['src/lib/server/nomination.ts']);
	});

	it('issues exactly one INSERT and one DELETE against it, and never a SELECT', () => {
		// "Nothing reads `open_nominations` to answer a question" (Story 2.2's
		// Always, carried into 2.3): it is a write-side constraint, and the
		// answer to "is this Slot held" is the fold over `auction_events`.
		const statements = [
			...code('src/lib/server/nomination.ts').matchAll(
				/\b(select|insert into|update|delete from)\b[^;`]*?\$\{OPEN_NOMINATIONS_TABLE\}/gi
			)
		].map((match) => (match[1] ?? '').toLowerCase());

		expect(statements.sort()).toEqual(['delete from', 'insert into']);
	});

	it('folds exactly two events — a close releases, and nothing else does', () => {
		const nominations = code('src/lib/core/projection/nominations.ts');
		const cases = [...nominations.matchAll(/case\s+([A-Z_]+):/g)].map((match) => match[1]);

		expect(cases).toEqual(['NOMINATION_PLACED_EVENT', 'AUCTION_CLOSED_EVENT']);
		// No timer, no elapsed time, no wall clock: the trigger is the event.
		expect(nominations).not.toMatch(/Date\.now|new Date\(|setTimeout|setInterval/);
	});
});
