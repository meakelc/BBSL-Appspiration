import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const UX_DESIGNS = join(ROOT, '_bmad-output', 'planning-artifacts', 'ux-designs');

/**
 * Find DESIGN.md rather than hardcoding its date-stamped directory.
 *
 * The design lives in `ux-designs/ux-<project>-<date>/DESIGN.md`, and a revision
 * lands in a NEW dated directory. A hardcoded path would not just fail — it
 * would throw at module load, outside any `it()`, collapsing every assertion in
 * this file at once and reporting a missing file rather than the token drift the
 * suite exists to catch. The newest directory wins, which is the one the design
 * says is current.
 */
function findDesignDoc(): string {
	if (!existsSync(UX_DESIGNS)) {
		throw new Error(`No ux-designs directory at ${relative(ROOT, UX_DESIGNS)} — cannot verify tokens.`);
	}
	const candidates = readdirSync(UX_DESIGNS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(UX_DESIGNS, entry.name, 'DESIGN.md'))
		.filter((path) => existsSync(path))
		.sort();

	const newest = candidates.at(-1);
	if (newest === undefined) {
		throw new Error(
			`No DESIGN.md found in any subdirectory of ${relative(ROOT, UX_DESIGNS)}. ` +
				`Token parity cannot be verified without the design document that owns the values. ` +
				`Looked in: ${readdirSync(UX_DESIGNS).join(', ') || '(empty)'}`
		);
	}
	return newest;
}

const DESIGN_MD = findDesignDoc();
const TOKENS_CSS = join(ROOT, 'src', 'lib', 'styles', 'tokens.css');

// --- Reading the two sides -------------------------------------------------

/**
 * Read the two-level YAML frontmatter of DESIGN.md.
 *
 * Deliberately not a general YAML parser — this handles exactly the shape
 * DESIGN.md uses (top-level keys, two-space-indented scalar children, optional
 * double quotes) and nothing else. A dependency here would be a dependency the
 * story is not allowed to add, and a general parser would hide a malformed
 * frontmatter rather than surface it.
 */
function readFrontmatter(source: string): Map<string, Map<string, string>> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
	if (match === null) throw new Error('DESIGN.md has no frontmatter block');

	const sections = new Map<string, Map<string, string>>();
	let current: Map<string, string> | undefined;

	for (const line of (match[1] ?? '').split(/\r?\n/)) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue;

		const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (top !== null) {
			const key = top[1] ?? '';
			const inline = (top[2] ?? '').trim();
			current = new Map<string, string>();
			sections.set(key, current);
			if (inline !== '') current.set('', unquote(inline));
			continue;
		}

		const child = /^\s{2}([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
		if (child !== null && current !== undefined) {
			current.set(child[1] ?? '', unquote((child[2] ?? '').trim()));
		}
	}

	return sections;
}

function unquote(value: string): string {
	const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
	return quoted?.[1] ?? value;
}

/** Read every custom property declared on :root in tokens.css. */
function readCustomProperties(source: string): Map<string, string> {
	const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
	const declared = new Map<string, string>();
	for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
		declared.set((match[1] ?? '').trim(), (match[2] ?? '').trim());
	}
	return declared;
}

const frontmatter = readFrontmatter(readFileSync(DESIGN_MD, 'utf8'));
const tokens = readCustomProperties(readFileSync(TOKENS_CSS, 'utf8'));

function section(name: string): Map<string, string> {
	const found = frontmatter.get(name);
	if (found === undefined) throw new Error(`DESIGN.md frontmatter has no "${name}" section`);
	return found;
}

/**
 * The naming rule, stated once. A frontmatter key maps to exactly one custom
 * property name, mechanically — so a new token in DESIGN.md has one and only
 * one correct name here.
 */
function expectedName(sectionName: string, key: string): string {
	switch (sectionName) {
		case 'colors':
			return `--color-${key}`;
		case 'rounded':
			return `--rounded-${key}`;
		case 'spacing':
			return `--space-${key}`;
		case 'components':
			return `--${key}`;
		default:
			throw new Error(`no naming rule for section "${sectionName}"`);
	}
}

/**
 * Every colour whose declared value disagrees with DESIGN.md, named with both
 * values. This is the parity comparison itself — the real assertion and the
 * drift tests both call it, so a drift test can no longer pass by agreeing with
 * a re-implementation of the check it is supposed to be exercising.
 */
function colourDrift(
	design: Map<string, string>,
	declared: Map<string, string>
): string[] {
	const failures: string[] = [];
	for (const [key, value] of design) {
		const name = expectedName('colors', key);
		const found = declared.get(name);
		// Absence is reported by missingColourTokens, so it is not double-counted.
		if (found === undefined || found === value) continue;
		failures.push(`${name}: DESIGN.md ${value}, tokens.css ${found}`);
	}
	return failures;
}

/** Frontmatter colours with no corresponding custom property, by key. */
function missingColourTokens(design: Map<string, string>, declared: Map<string, string>): string[] {
	return [...design.keys()].filter((key) => !declared.has(expectedName('colors', key)));
}

// --- Parity ----------------------------------------------------------------

describe('token parity with DESIGN.md frontmatter', () => {
	it('declares all twenty colours and no fewer', () => {
		const colours = section('colors');
		expect(colours.size).toBe(20);
		const missing = missingColourTokens(colours, tokens);
		expect(missing, `colour tokens missing from tokens.css: ${missing.join(', ')}`).toEqual([]);
	});

	it('declares every colour at the value DESIGN.md gives it', () => {
		const drift = colourDrift(section('colors'), tokens);
		expect(drift, drift.join('\n')).toEqual([]);
	});

	it.each([...section('colors').entries()])(
		'declares colour %s verbatim',
		(key: string, value: string) => {
			const name = expectedName('colors', key);
			const found = tokens.get(name);
			expect(found, `${name} is missing from tokens.css (DESIGN.md declares ${value})`).toBeDefined();
			expect(found, `${name}: DESIGN.md says ${value}, tokens.css says ${found}`).toBe(value);
		}
	);

	it.each([...section('rounded').entries()])(
		'declares radius %s verbatim',
		(key: string, value: string) => {
			const name = expectedName('rounded', key);
			expect(tokens.get(name), `${name}: DESIGN.md says ${value}`).toBe(value);
		}
	);

	it.each([...section('spacing').entries()])(
		'declares spacing %s verbatim',
		(key: string, value: string) => {
			const name = expectedName('spacing', key);
			expect(tokens.get(name), `${name}: DESIGN.md says ${value}`).toBe(value);
		}
	);

	it.each([...section('components').entries()])(
		'declares component dimension %s verbatim',
		(key: string, value: string) => {
			const name = expectedName('components', key);
			expect(tokens.get(name), `${name}: DESIGN.md says ${value}`).toBe(value);
		}
	);

	it('declares both type families verbatim and no third', () => {
		const typography = section('typography');
		expect(tokens.get('--font-display')).toBe(typography.get('display'));
		expect(tokens.get('--font-ui')).toBe(typography.get('ui'));
		const families = [...tokens.keys()].filter((name) => name.startsWith('--font-'));
		expect(families.sort()).toEqual(['--font-display', '--font-ui']);
	});

	it('declares tabular numerals as a token', () => {
		expect(tokens.get('--numerals')).toBe(section('typography').get('numerals'));
		expect(tokens.get('--numerals')).toBe('tabular-nums');
	});

	it('declares the ten-step type scale, every step and no extra', () => {
		const scale = (section('typography').get('scale') ?? '')
			.split('/')
			.map((step) => step.trim())
			.filter((step) => step !== '');
		expect(scale).toHaveLength(10);

		const declared = [...tokens.keys()].filter((name) => name.startsWith('--size-'));
		expect(declared).toHaveLength(10);

		for (const step of scale) {
			const name = `--size-${step.replace('.', '-')}`;
			expect(tokens.get(name), `${name} is missing from tokens.css`).toBe(`${step}px`);
		}
	});
});

describe('token drift is caught in both directions', () => {
	// These drive the SAME functions the real assertions above drive. Asserting
	// against a local re-implementation would prove only that the copy agrees
	// with itself, and would keep passing if the real parity check were deleted.

	it('names the token and both values when a colour is edited in tokens.css only', () => {
		const drifted = new Map(tokens);
		drifted.set('--color-brand', '#00FF00');

		const failures = colourDrift(section('colors'), drifted);

		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain('--color-brand');
		expect(failures[0]).toContain('#6FD3A0');
		expect(failures[0]).toContain('#00FF00');
	});

	it('names the token when a frontmatter token is absent from tokens.css', () => {
		const drifted = new Map(tokens);
		drifted.delete('--color-admin-ground');

		expect(missingColourTokens(section('colors'), drifted)).toEqual(['admin-ground']);
		// And absence is not double-reported as a value mismatch.
		expect(colourDrift(section('colors'), drifted)).toEqual([]);
	});
});

describe('additions beyond the frontmatter', () => {
	it('declares the Manager control fill as a token rather than a hardcoded hex', () => {
		// DESIGN.md:229 gives this as a raw #223028 that is not one of the twenty
		// frontmatter colours. Declared, not invented — see the story's Design Notes.
		//
		// The value is #1D2922, a deliberate correction: #223028 measures 2.77:1
		// against the control boundary that bounds it, below the 3:1 WCAG 1.4.11
		// requires. tests/commissioner.test.ts measures both. Recorded here so the
		// divergence from DESIGN.md is never mistaken for a transcription slip.
		expect(tokens.get('--control-fill')).toBe('#1D2922');
		expect(tokens.get('--control-fill')).not.toBe('#223028');
	});
});

// --- Dark only -------------------------------------------------------------

const LIGHT_SCHEME_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
	{ pattern: /prefers-color-scheme/i, what: 'a prefers-color-scheme query' },
	{ pattern: /color-scheme\s*:\s*[^;]*\blight\b/i, what: 'a light color-scheme declaration' },
	{ pattern: /\blight-dark\s*\(/i, what: 'a light-dark() colour function' },
	{ pattern: /\[data-theme\s*=\s*["']?light/i, what: 'a light data-theme selector' },
	{ pattern: /(?::root|html|body)\s*\.\s*light\b/i, what: 'a .light theme class' },
	{ pattern: /--[\w-]*\blight-theme\b/i, what: 'a light theme token' }
];

/**
 * Strip comments before scanning. A comment explaining that light themes are
 * banned is not a light theme, and this file, tokens.css and global.css all
 * contain exactly such comments — without this the ban would forbid documenting
 * itself.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
}

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(full));
		else found.push(full);
	}
	return found;
}

/**
 * Scan one file's source for a light-scheme declaration, reporting each offence
 * named by file and by what was found. The real scan and the "would it actually
 * report?" test both call this, so the reporting cannot pass by agreeing with a
 * copy of itself.
 */
function scanForLightScheme(label: string, source: string): string[] {
	const offences: string[] = [];
	const scannable = stripComments(source);
	for (const { pattern, what } of LIGHT_SCHEME_PATTERNS) {
		if (pattern.test(scannable)) offences.push(`${label} contains ${what}`);
	}
	return offences;
}

describe('dark only', () => {
	it('declares no light theme anywhere in src/', () => {
		const files = walk(join(ROOT, 'src')).filter((file) =>
			/\.(css|svelte|ts|js|html)$/.test(file)
		);
		expect(files.length, 'src/ must contain files to scan').toBeGreaterThan(0);

		const offences = files.flatMap((file) =>
			scanForLightScheme(relative(ROOT, file), readFileSync(file, 'utf8'))
		);

		expect(offences, offences.join('\n')).toEqual([]);
	});

	it.each([
		['a media query', '@media (prefers-color-scheme: light) { :root { --color-ground: #fff } }'],
		['a dual color-scheme', ':root { color-scheme: light dark; }'],
		['light-dark()', ':root { --color-ground: light-dark(#fff, #0D1712); }'],
		['a theme attribute', '[data-theme="light"] { --color-ground: #fff; }']
	])('names the offending file when %s reintroduces a light theme', (_label: string, source: string) => {
		const offences = scanForLightScheme('src/lib/styles/tokens.css', source);
		expect(offences.length).toBeGreaterThan(0);
		expect(offences[0]).toContain('src/lib/styles/tokens.css');
	});

	it('does not flag a comment that merely mentions the ban', () => {
		// Otherwise the rule would forbid documenting itself, which is how this
		// scanner failed the first time it was run.
		expect(
			scanForLightScheme('src/lib/styles/global.css', '/* No prefers-color-scheme block. */')
		).toEqual([]);
	});

	it('commits to a dark colour scheme explicitly', () => {
		expect(readFileSync(TOKENS_CSS, 'utf8')).toContain('color-scheme: dark');
	});
});
