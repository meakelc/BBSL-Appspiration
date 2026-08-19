import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

const AR2_FILES: Array<[path: string, purpose: string]> = [
	['src/lib/core/money.ts', 'branded integer-dollar type and parsers (AD-8)'],
	['src/lib/core/constants.ts', 'league constants AND the AD-6 lock key'],
	['src/lib/core/types.ts', 'commands, events, rejections, state']
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
		const wouldBeEmpty = [
			'src/lib/core/rules',
			'src/lib/core/projection',
			'src/lib/shell',
			'src/lib/adapters/fantrax',
			'src/lib/adapters/discord',
			'src/lib/server',
			'supabase/migrations',
			'supabase/functions/tick',
			'tests/examples'
		];
		for (const path of wouldBeEmpty) {
			const marker = at(...path.split('/'), '.gitkeep');
			expect(existsSync(marker), `${path}/.gitkeep is missing — git will not track it`).toBe(true);
		}
	});
});

describe('the pure core boundary is not pre-broken', () => {
	it.each(AR2_FILES)('%s takes no framework or aliased import', (path: string) => {
		const source = readFileSync(at(...path.split('/')), 'utf8');
		expect(source, `${path} must not import through $lib`).not.toMatch(/from\s+['"]\$/);
		expect(source, `${path} must not import a node builtin`).not.toMatch(/from\s+['"]node:/);
		expect(source, `${path} must use relative .ts imports only`).not.toMatch(
			/from\s+['"](?!\.)[^'"]+['"]/
		);
	});
});

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
