import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

import { PHASE_SENTENCES, resolveLeaguePhase } from '../src/lib/server/phase.ts';

/**
 * A fake client backing an empty `auction_events` log, for the one place
 * this file needs to prove "no events folds to Setup" against the real
 * DB-backed `resolveLeaguePhase` rather than merely reading its source.
 */
function emptyEventsClient(): SupabaseClient {
	const query = {
		select: () => query,
		order: () => query,
		range: async () => ({ data: [], error: null })
	};
	return { from: () => query } as unknown as SupabaseClient;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const at = (...parts: string[]): string => join(ROOT, ...parts);

/**
 * Surface claims, asserted against source text.
 *
 * `vite.config.ts` sets `environment: 'node'` and includes `tests/**` only, so
 * no `.svelte` file can be rendered in a test (see the open component-harness
 * entry in deferred-work.md). These assertions therefore read the source, the
 * way `structure.test.ts` already does for the skeleton page. That is weaker
 * than a rendered assertion for layout, and exactly as strong for the claims
 * that matter here — "there is no email field anywhere" is a property of the
 * text, not of the render.
 */

// --- Every .svelte file in the repository -----------------------------------

function walk(directory: string, extension: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const full = join(directory, entry);
		if (statSync(full).isDirectory()) {
			found.push(...walk(full, extension));
			continue;
		}
		if (entry.endsWith(extension)) found.push(full);
	}
	return found;
}

const ROUTE_SVELTE = walk(at('src', 'routes'), '.svelte');
const SRC_SVELTE = walk(at('src'), '.svelte');
const ROUTE_SOURCES = walk(at('src', 'routes'), '.ts');
/** Every source file in the tree — the scope a repository-wide claim needs. */
const ALL_SOURCES = [...walk(at('src'), '.ts'), ...SRC_SVELTE];

const SIGNIN = readFileSync(at('src', 'routes', 'signin', '+page.svelte'), 'utf8');
const SIGNIN_SERVER = readFileSync(at('src', 'routes', 'signin', '+page.server.ts'), 'utf8');
const RECOVERY = readFileSync(at('src', 'routes', 'commissioner-recovery', '+page.svelte'), 'utf8');

// --- No email field anywhere ------------------------------------------------

describe('no email field exists anywhere in the product', () => {
	it('renders no route with an email input', () => {
		// This is a repository-wide claim (FR-4: no email field anywhere, and the
		// system sends no email for any purpose), so it is asserted
		// repository-wide rather than on the one surface that would obviously
		// have had one.
		expect(ROUTE_SVELTE.length).toBeGreaterThan(0);
		for (const file of SRC_SVELTE) {
			const source = readFileSync(file, 'utf8');
			const where = relative(ROOT, file);
			expect(source, `${where} carries type="email"`).not.toMatch(/type\s*=\s*["']email["']/i);
			expect(source, `${where} carries name="email"`).not.toMatch(/name\s*=\s*["']email["']/i);
			expect(source, `${where} carries inputmode="email"`).not.toMatch(
				/inputmode\s*=\s*["']email["']/i
			);
			expect(source, `${where} autocompletes an email`).not.toMatch(
				/autocomplete\s*=\s*["'][^"']*email[^"']*["']/i
			);
		}
	});

	it('offers no magic link, no password reset and no SMTP, anywhere in the tree', () => {
		// Repository-wide, not route-wide. "This system sends no email for any
		// purpose" is a claim about the whole product, and a helper module that
		// quietly grew an address path would satisfy a route-only scan.
		expect(ALL_SOURCES.length).toBeGreaterThan(ROUTE_SOURCES.length);
		for (const file of ALL_SOURCES) {
			const source = readFileSync(file, 'utf8');
			const where = relative(ROOT, file);
			expect(source, `${where} mentions a magic link`).not.toMatch(/magic.?link/i);
			expect(source, `${where} mentions a password reset`).not.toMatch(/password.?reset/i);
			expect(source, `${where} mentions SMTP`).not.toMatch(/\bsmtp\b/i);
			expect(source, `${where} mentions mailto:`).not.toMatch(/mailto:/i);
		}
	});

	it('offers no self-service registration', () => {
		for (const file of SRC_SVELTE) {
			const source = readFileSync(file, 'utf8');
			expect(source, `${relative(ROOT, file)} offers a sign-up`).not.toMatch(
				/sign[\s-]?up|create an account|register (an )?account/i
			);
		}
	});
});

// --- The sign-in surface ----------------------------------------------------

describe('the sign-in surface', () => {
	it('states the phase from the server-resolved source, not from a typed sentence', () => {
		expect(SIGNIN).toContain('data.phase.sentence');
		// The sentence itself must not be copied here. Two copies are two
		// sources, and they drift the first time one is edited.
		expect(SIGNIN).not.toContain('folds to Setup');
		expect(SIGNIN_SERVER).toContain('locals.phase');
	});

	it('names the phase the same page the rest of the app does', async () => {
		const home = readFileSync(at('src', 'routes', '+page.svelte'), 'utf8');
		const homeServer = readFileSync(at('src', 'routes', '+page.server.ts'), 'utf8');
		expect(home).toContain('data.phase.sentence');
		expect(homeServer).toContain('locals.phase');
		// And that one source currently folds to Setup, because there are no
		// events yet and no events folds to Setup.
		const resolved = await resolveLeaguePhase(emptyEventsClient());
		expect(resolved.name).toBe('Setup');
		expect(resolved.sentence).toBe(PHASE_SENTENCES.Setup);
		expect(resolved.sentence).toContain('Setup');
	});

	it('offers exactly one action, and it is Discord', () => {
		const forms = SIGNIN.match(/<form\b/g) ?? [];
		expect(forms.length, 'the sign-in surface must offer exactly one form').toBe(1);

		const buttons = SIGNIN.match(/<button\b/g) ?? [];
		expect(buttons.length, 'the sign-in surface must offer exactly one control').toBe(1);

		expect(SIGNIN).toContain('action="?/discord"');
		expect(SIGNIN).toMatch(/Sign in with Discord/);
	});

	it('states exactly one sentence, and which sentence it is carries the state', () => {
		// The four states are one string slot, not four blocks — so no state can
		// be rendered with another state's words by accident.
		expect(SIGNIN).toContain('id="signin-notice"');
		expect((SIGNIN.match(/id="signin-notice"/g) ?? []).length).toBe(1);
	});

	it('takes its sentence from the tested mapping rather than choosing one here', () => {
		// This used to grep the route for the four constant names, which proved
		// only that all four were mentioned somewhere — swapping two cases kept it
		// green. The mapping itself is `noticeFor`, asserted state-by-state in
		// tests/auth.test.ts; what belongs here is that the route uses it and
		// holds no second copy.
		expect(SIGNIN_SERVER).toContain('noticeFor(locals.session)');
		expect(SIGNIN_SERVER, 'the route re-derives a sentence of its own').not.toMatch(
			/case '(unregistered|expired|discord-unavailable)':/
		);
	});

	it('never links, names or hints at the break-glass path', () => {
		// AD-27's path is unadvertised. A link here, or even the word, would
		// advertise it — and the secret is the control, not the obscurity, so
		// advertising it is a real loss rather than a theoretical one.
		expect(SIGNIN).not.toMatch(/commissioner-recovery/i);
		expect(SIGNIN).not.toMatch(/break.?glass/i);
		expect(SIGNIN).not.toMatch(/recovery/i);
		expect(SIGNIN_SERVER).not.toMatch(/commissioner-recovery/i);
		expect(SIGNIN_SERVER).not.toMatch(/break.?glass/i);
	});

	it('offers no retry prompt for a refused account', () => {
		expect(SIGNIN).not.toMatch(/try another account|try again/i);
	});

	it('offers the action in two states only — a live button under a refusal is a probe loop', () => {
		// AD-15 refuses an unregistered account "without a retry loop to probe
		// with". A refusal rendered above a working Sign-in button IS that loop,
		// so the control is offered to a signed-out visitor and to an expired
		// session, and to nobody else.
		expect(SIGNIN).toMatch(/state === 'signed-out'/);
		expect(SIGNIN).toMatch(/state === 'expired'/);
		expect(SIGNIN).toMatch(/disabled=\{!actionable\}/);
		expect(SIGNIN).not.toMatch(/state === 'unregistered'/);
	});

	it('is excluded from indexing at the document level as well as at the edge', () => {
		expect(SIGNIN).toMatch(/name="robots"[^>]*noindex/);
		expect(RECOVERY).toMatch(/name="robots"[^>]*noindex/);
	});
});

// --- Each control sits in the block its class belongs to ---------------------

describe('every control sits in the block its class belongs to', () => {
	// Swapping a Commissioner control to `control-manager` left every Story 1.1
	// test green: commissioner.test.ts reads the stylesheet, not the markup. The
	// same trap applies to every surface this story adds, so the check moves
	// from one page to all of them.
	//
	// Extended for Story 1.6: `src/lib/components/DestinationsList.svelte` is
	// the first role-visible markup in the repo that wraps a block in `<div>`
	// rather than `<section>` — the original regex, `<section ...>`, could not
	// see it at all, the exact class of regression this suite exists to catch,
	// reaching a file it had never walked. The tag is now captured and
	// backreferenced so a `<div>` block only ever matches its own `</div>`,
	// never a `<section>`'s close tag or vice versa. (This markup-structure
	// guard cannot, by itself, prove the *filter deciding which entry lands in
	// which block* is correct — `tests/destinations-view.test.ts` proves that
	// half, by calling `classifyDestinations` directly.)
	function blocksOf(source: string, className: string): string[] {
		return [
			...source.matchAll(new RegExp(`<(section|div) class="${className}"[\\s\\S]*?</\\1>`, 'g'))
		].map((match) => match[0]);
	}

	it.each(SRC_SVELTE.map((file) => [relative(ROOT, file), file] as const))(
		'%s keeps referee and player controls apart',
		(_where: string, file: string) => {
			const source = readFileSync(file, 'utf8');

			for (const block of blocksOf(source, 'manager-block')) {
				expect(block, 'a Commissioner control must never sit in a Manager block').not.toContain(
					'control-commissioner'
				);
			}
			for (const block of blocksOf(source, 'commissioner-block')) {
				expect(block, 'a Manager control must never sit in a Commissioner block').not.toContain(
					'control-manager'
				);
			}

			// And no control may be rendered outside a block that declares which
			// kind of control it is.
			for (const control of source.match(/class="control-(manager|commissioner)"/g) ?? []) {
				const kind = control.includes('commissioner') ? 'commissioner' : 'manager';
				expect(
					blocksOf(source, `${kind}-block`).join('\n'),
					`a ${kind} control sits outside a ${kind}-block`
				).toContain(control);
			}
		}
	);

	it('renders the break-glass control as a Commissioner control', () => {
		expect(RECOVERY).toContain('class="commissioner-block"');
		expect(RECOVERY).toContain('class="control-commissioner"');
		expect(RECOVERY).not.toContain('control-manager');
	});

	it('renders the sign-in control as a Manager control', () => {
		expect(SIGNIN).toContain('class="manager-block"');
		expect(SIGNIN).toContain('class="control-manager"');
		expect(SIGNIN).not.toContain('control-commissioner');
	});

	it('states every disabled control’s reason and associates it with the control', () => {
		for (const file of ROUTE_SVELTE) {
			const source = readFileSync(file, 'utf8');
			const where = relative(ROOT, file);
			for (const control of source.match(/<button\b[\s\S]*?>/g) ?? []) {
				if (!/\bdisabled\b/.test(control)) continue;
				const described = /aria-describedby="([^"]+)"/.exec(control);
				expect(described, `${where}: a disabled control states no reason`).not.toBeNull();
				for (const id of (described?.[1] ?? '').split(/\s+/)) {
					expect(source, `${where}: aria-describedby="${id}" points at nothing`).toContain(
						`id="${id}"`
					);
				}
			}
		}
	});
});

// --- Server-only stays server-only ------------------------------------------

describe('no client surface reaches a server-only module or secret', () => {
	it('imports nothing from $lib/server or $env/*/private into a .svelte file', () => {
		for (const file of SRC_SVELTE) {
			const source = readFileSync(file, 'utf8');
			const where = relative(ROOT, file);
			expect(source, `${where} imports a server-only module`).not.toMatch(/\$lib\/server/);
			expect(source, `${where} imports a private env`).not.toMatch(/\$env\/(static|dynamic)\/private/);
		}
	});

	it('names no secret in any route source', () => {
		for (const file of [...SRC_SVELTE, ...ROUTE_SOURCES]) {
			const source = readFileSync(file, 'utf8');
			const where = relative(ROOT, file);
			expect(source, `${where} names a PUBLIC_ secret`).not.toMatch(
				/PUBLIC_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|WEBHOOK)/
			);
		}
		for (const file of SRC_SVELTE) {
			const source = readFileSync(file, 'utf8');
			expect(source, `${relative(ROOT, file)} names the recovery secret`).not.toContain(
				'COMMISSIONER_RECOVERY_SECRET'
			);
			expect(source, `${relative(ROOT, file)} names the service-role key`).not.toContain(
				'SUPABASE_SERVICE_ROLE_KEY'
			);
		}
	});

	it('holds the service-role key in exactly one module', () => {
		const holders = walk(at('src'), '.ts').filter((file) =>
			readFileSync(file, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY')
		);
		expect(holders.map((file) => relative(ROOT, file).replaceAll('\\', '/'))).toEqual([
			'src/lib/server/supabase.ts'
		]);
	});
});
