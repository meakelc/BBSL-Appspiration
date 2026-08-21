import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	FORBIDDEN_GLOBALS,
	FORBIDDEN_MEMBERS,
	checkCorePurity,
	readCoreSources
} from '../scripts/check-core-purity.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Check one synthetic file and return its violation rules, in order. */
function rulesFor(source: string, path = 'sample.ts'): string[] {
	return checkCorePurity([{ path, source }]).violations.map((v) => v.rule);
}

describe('the core may import nothing outside the standard library', () => {
	it.each([
		["import { x } from '$lib/server/db';", 'an alias'],
		["import { readFileSync } from 'node:fs';", 'a Node built-in'],
		["import { z } from 'zod';", 'a bare specifier'],
		["export { x } from 'svelte';", 're-export of a bare specifier'],
		["import type { T } from 'node:stream';", 'a type-only Node built-in']
	])('refuses %s — %s', (source: string) => {
		expect(rulesFor(source)).toEqual(['non-relative-import']);
	});

	it('names the specifier and what kind it is, so the message is actionable', () => {
		const [violation] = checkCorePurity([
			{ path: 'rules/bid.ts', source: "import { x } from '$lib/db';" }
		]).violations;
		expect(violation?.detail).toContain('"$lib/db"');
		expect(violation?.detail).toContain('an alias');
		expect(violation?.line).toBe(1);
	});
});

describe('every relative import carries an explicit .ts extension', () => {
	it.each([
		"import { MINIMUM_INCREMENT } from './constants';",
		"import { MINIMUM_INCREMENT } from './constants.js';",
		"import { x } from '../rules/bid';",
		"export * from './money';"
	])('refuses %s — Deno would not resolve it', (source: string) => {
		expect(rulesFor(source)).toEqual(['missing-ts-extension']);
	});

	it.each([
		"import { MINIMUM_INCREMENT } from './constants.ts';",
		"import type { Money } from '../money.ts';",
		"export { formatMoney } from './money.ts';"
	])('accepts %s', (source: string) => {
		expect(rulesFor(source)).toEqual([]);
	});
});

describe('the core takes no clock, no randomness and no ambient state', () => {
	// The expected rule is asserted, not merely "something fired" — a checker
	// that reported `crypto` as a non-relative-import would otherwise pass.
	const FORBIDDEN: ReadonlyArray<[string, string, string]> = [
		['Date.now()', 'const t = Date.now();', 'forbidden-reference'],
		['new Date()', 'const t = new Date();', 'forbidden-reference'],
		['Math.random()', 'const r = Math.random();', 'forbidden-reference'],
		["Math['random']()", "const r = Math['random']();", 'forbidden-reference'],
		['fetch', 'const r = fetch("/x");', 'forbidden-reference'],
		['process', 'const e = process.env.KEY;', 'forbidden-reference'],
		['crypto', 'const id = crypto.randomUUID();', 'forbidden-reference'],
		['setTimeout', 'setTimeout(() => {}, 1);', 'forbidden-reference'],
		['globalThis', 'const g = globalThis;', 'forbidden-reference'],
		["globalThis['Date']", "const d = globalThis['Date'];", 'forbidden-reference'],
		['eval', 'const r = eval("Date.now()");', 'forbidden-reference'],
		['Function', 'const r = new Function("return 1")();', 'forbidden-reference'],
		['Intl', 'const s = new Intl.NumberFormat().format(1);', 'forbidden-reference'],
		['WeakRef', 'const w = new WeakRef({});', 'forbidden-reference'],
		['import.meta', 'const u = import.meta.url;', 'forbidden-reference'],
		['new.target', 'function f() { const t = new.target; }', 'forbidden-reference'],
		['dynamic import', 'const m = await import("./money.ts");', 'dynamic-import'],
		['import equals', 'import x = require("node:fs");', 'import-equals']
	];

	it.each(FORBIDDEN)('refuses %s', (_name: string, source: string, rule: string) => {
		expect(rulesFor(source)).toContain(rule);
	});

	it.each([
		["Math['random']()", "const r = Math['random']();"],
		['eval', 'const r = eval("1");'],
		['new Function', 'const r = new Function("return 1")();']
	])('closes the %s evasion, which a name-only dot check would miss', (_n: string, src: string) => {
		expect(rulesFor(src).length).toBeGreaterThan(0);
	});

	it('names the right construct for new.target rather than import.meta', () => {
		const [violation] = checkCorePurity([
			{ path: 'p.ts', source: 'function f() { const t = new.target; }' }
		]).violations;
		expect(violation?.detail).toContain('new.target');
		expect(violation?.detail).not.toContain('import.meta');
	});

	it('permits the stdlib arithmetic a money renderer actually needs', () => {
		expect(
			rulesFor('export const f = (n: number) => Math.abs(Math.trunc(n)) % 5 === 0;')
		).toEqual([]);
	});

	it.each([
		['a property read', 'export const f = (row: { process: number }) => row.process + 1;'],
		['a class method', 'export class C { process(): number { return 1; } }'],
		['an accessor', 'export class C { get crypto(): number { return 1; } }'],
		['a property declaration', 'export class C { process = 1; }'],
		['an object literal key', 'export const o = { process: 1, Date: 2 };']
	])('does not mistake %s of the same name for the global', (_name: string, source: string) => {
		expect(rulesFor(source)).toEqual([]);
	});
});

describe('comments and strings are not code', () => {
	// The core's own doc comments name every forbidden construct, so a scanner
	// reading raw text fails on the files it exists to protect. This is the
	// regression test for that: it is the reason the checker parses rather than
	// pattern-matches.
	const source = [
		'/**',
		' * This module never calls Date.now(), Math.random() or fetch, and never',
		" * imports from 'node:fs' or '$lib/server'. Relative .ts imports only.",
		' */',
		"export const NOTE = 'do not use Date.now() here';",
		"export const SPECIFIER_EXAMPLE = 'node:fs';",
		'export const PATTERN = /process|fetch/;'
	].join('\n');

	it('passes a file whose comments and strings are full of forbidden words', () => {
		expect(rulesFor(source)).toEqual([]);
	});
});

describe('the walk covers the whole core, not a file list', () => {
	it('reaches a violating file nested under rules/', () => {
		const fixture = mkdtempSync(join(tmpdir(), 'bbsl-core-'));
		try {
			mkdirSync(join(fixture, 'rules'), { recursive: true });
			writeFileSync(join(fixture, 'money.ts'), 'export const clean = 1;\n', 'utf8');
			writeFileSync(join(fixture, 'rules', 'bid.ts'), "import { x } from 'zod';\n", 'utf8');
			writeFileSync(join(fixture, 'rules', 'notes.md'), 'import { y } from "zod";\n', 'utf8');

			const sources = readCoreSources(fixture);
			expect(sources.map((s) => s.path)).toEqual(['money.ts', 'rules/bid.ts']);

			const result = checkCorePurity(sources);
			expect(result.ok).toBe(false);
			expect(result.violations).toHaveLength(1);
			expect(result.violations[0]?.file).toBe('rules/bid.ts');
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});

describe('the core as committed', () => {
	it('passes the purity gate', () => {
		const result = checkCorePurity(readCoreSources());
		expect(result.violations).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('actually reads the three AR-2 core files', () => {
		// Guards against a walk that silently finds nothing and reports success.
		expect(readCoreSources().map((s) => s.path)).toEqual(
			expect.arrayContaining(['constants.ts', 'money.ts', 'types.ts'])
		);
	});
});

describe('the CLI entry point, which is what actually fails a build', () => {
	// Every other test here calls checkCorePurity() directly, which never touches
	// the module-identity guard, the stderr write or the exit code — the three
	// things that make `npm run build` stop. The guard's own comment records that
	// this exact comparison already broke once on Windows drive-letter casing, so
	// it is spawned for real rather than re-implemented in a probe.
	function runCliAgainst(files: Record<string, string>): ReturnType<typeof spawnSync> {
		const fixture = mkdtempSync(join(tmpdir(), 'bbsl-cli-'));
		try {
			for (const [name, source] of Object.entries(files)) {
				const full = join(fixture, name);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, source, 'utf8');
			}
			return spawnSync(
				process.execPath,
				[join(ROOT, 'scripts', 'check-core-purity.js'), fixture],
				{ encoding: 'utf8' }
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}

	it('exits non-zero and names the violation on stderr', () => {
		const run = runCliAgainst({ 'rules/bid.ts': "import { x } from 'node:fs';" });
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('rules/bid.ts');
		expect(run.stderr).toContain('node:fs');
	});

	it('exits zero on a clean core', () => {
		const run = runCliAgainst({ 'money.ts': 'export const clean = 1;' });
		expect(run.status).toBe(0);
		expect(run.stderr).toBe('');
	});

	it('uses process.exitCode rather than process.exit so stderr can drain', () => {
		const source = readFileSync(join(ROOT, 'scripts', 'check-core-purity.js'), 'utf8');
		// Strip comments — the comment explaining why process.exit() is wrong is
		// not a call to process.exit().
		const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/.*/g, '$1');
		expect(code).toContain('process.exitCode = 1');
		expect(code).not.toMatch(/process\.exit\(/);
	});

	it('is wired into the build ahead of Vite, not only into the test suite', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			scripts?: Record<string, string>;
		};
		const build = pkg.scripts?.['build'] ?? '';
		expect(build, 'the build must run the purity gate').toContain('check-core-purity.js');
		expect(
			build.indexOf('check-core-purity.js'),
			'the gate must run before Vite compiles anything'
		).toBeLessThan(build.indexOf('vite build'));
		expect(pkg.scripts?.['check:purity']).toContain('check-core-purity.js');
	});

	it('cannot be disarmed by an importer mutating the forbidden lists', () => {
		// Object.freeze on a Set does not stop .delete(), so the exported tables
		// are frozen arrays and the working Set is built from them privately.
		expect(Object.isFrozen(FORBIDDEN_GLOBALS)).toBe(true);
		expect(Object.isFrozen(FORBIDDEN_MEMBERS)).toBe(true);
		expect(Array.isArray(FORBIDDEN_GLOBALS)).toBe(true);
	});
});

describe('the second runtime is checked where it exists', () => {
	// The static walk proves the core does not reach for anything forbidden;
	// only Deno proves the core actually resolves and type-checks under the
	// runtime the tick function runs in (AD-2). Deno is not installed locally,
	// so CI is the only place that step can run — which makes its presence in
	// the workflow a thing worth asserting.
	const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

	it('installs Deno from an action pinned by commit', () => {
		expect(workflow).toMatch(/denoland\/setup-deno@[0-9a-f]{40}/);
	});

	it('type-checks the core under Deno', () => {
		expect(workflow).toContain('deno check');
		expect(workflow).toContain('src/lib/core');
	});

	it('runs the purity gate through the test suite', () => {
		expect(workflow).toContain('npm test');
	});
});
