Conduct a review of CONTENT.
Look for what's missing, not only what's wrong.
Find at least ten issues to fix or improve.
Output a Markdown list of findings only — no severity, priority, or ranking.
If the content is empty, stop and say so.
If you have zero findings, re-check and keep thinking; do not stop with an empty list.

CONTENT:
NOTE: this is a GAP-FILL pass. An earlier review of this same story already covered the tracked-file changes. The content below is the portion that was omitted from that pass — four files that were new and untracked, and therefore invisible to it. Review this content on its own terms; do not assume the rest of the story is shown.

diff --git a/scripts/check-core-purity.js b/scripts/check-core-purity.js
new file mode 100644
index 0000000..4dca555
--- /dev/null
+++ b/scripts/check-core-purity.js
@@ -0,0 +1,283 @@
+/**
+ * Pure-core boundary gate (AD-1, AD-2).
+ *
+ * `src/lib/core/**` is loaded by two runtimes — Node under SvelteKit and Deno
+ * inside the Supabase Edge Function — and is the one directory in this
+ * repository where an import of anything outside the TypeScript standard
+ * library, or a read of a clock, is a defect rather than a style question. An
+ * auction that closes under different rules than it bids under is the most
+ * dangerous divergence available in this design, and this file is what makes
+ * it unreachable rather than merely discouraged.
+ *
+ * This runs as part of `npm run build`, after the pin gate and before Vite, and
+ * again under `npm test` through tests/purity.test.ts.
+ *
+ * **Why the TypeScript parser and not a regex.** The core's own doc comments
+ * name the forbidden constructs — `Date.now()`, `Math.random()` — so a scanner
+ * reading raw text fails on the very files it protects. Stripping comments and
+ * strings by regex then has to solve regex-literal detection and template
+ * interpolation to avoid both false positives and false negatives. The
+ * compiler is already a pinned devDependency and answers all of that exactly:
+ * a comment is not an identifier and a string's contents are not references.
+ *
+ * The checking logic is exported as a pure function so the test suite can drive
+ * it with synthetic inputs; the CLI entry point at the bottom reads the real
+ * files and sets the exit code.
+ */
+
+import { readFileSync, readdirSync } from 'node:fs';
+import { dirname, join, relative, sep } from 'node:path';
+import { fileURLToPath, pathToFileURL } from 'node:url';
+
+import ts from 'typescript';
+
+/** Repository root, resolved from this file rather than the caller's cwd. */
+export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
+
+/** The sealed directory. Everything below it, recursively, is the core. */
+export const CORE_DIRECTORY = 'src/lib/core';
+
+/**
+ * Globals a pure rule may not reference. `Date` is forbidden outright, not just
+ * `Date.now` — AD-3 injects the current instant as a parameter, so a core file
+ * has no legitimate use for the constructor either. The set covers the AC's
+ * named cases plus their obvious siblings; a false positive here is a rename,
+ * a false negative is a rule that silently depends on ambient state.
+ * @type {ReadonlySet<string>}
+ */
+export const FORBIDDEN_GLOBALS = new Set([
+	'Date',
+	'fetch',
+	'process',
+	'require',
+	'globalThis',
+	'crypto',
+	'performance',
+	'setTimeout',
+	'setInterval',
+	'setImmediate',
+	'queueMicrotask',
+	'Deno',
+	'Buffer',
+	'__dirname',
+	'__filename',
+	'window',
+	'document',
+	'navigator',
+	'localStorage',
+	'sessionStorage',
+	'XMLHttpRequest',
+	'WebSocket'
+]);
+
+/**
+ * Property accesses a pure rule may not make, as `object.property`. `Math` is
+ * otherwise fine — `Math.abs` and `Math.trunc` are stdlib arithmetic.
+ * @type {ReadonlyArray<[object: string, property: string]>}
+ */
+export const FORBIDDEN_MEMBERS = [['Math', 'random']];
+
+/** A relative specifier: the only kind the core may use (AD-2). */
+const RELATIVE_SPECIFIER = /^\.\.?\//;
+
+/**
+ * Collect every TypeScript source under the core, recursively.
+ *
+ * The recursion is the point: a hardcoded file list stops covering the core the
+ * moment `core/rules/` or `core/projection/` gains its first file.
+ *
+ * @param {string} [root] absolute path to the core directory
+ * @returns {Array<{ path: string, source: string }>} repo-relative paths, POSIX separators
+ */
+export function readCoreSources(root = join(ROOT, ...CORE_DIRECTORY.split('/'))) {
+	/** @type {Array<{ path: string, source: string }>} */
+	const sources = [];
+
+	/** @param {string} directory */
+	function walk(directory) {
+		const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
+			a.name < b.name ? -1 : a.name > b.name ? 1 : 0
+		);
+		for (const entry of entries) {
+			const full = join(directory, entry.name);
+			if (entry.isDirectory()) {
+				walk(full);
+			} else if (entry.isFile() && entry.name.endsWith('.ts')) {
+				sources.push({
+					path: relative(root, full).split(sep).join('/'),
+					source: readFileSync(full, 'utf8')
+				});
+			}
+		}
+	}
+
+	walk(root);
+	return sources;
+}
+
+/**
+ * @typedef {object} Violation
+ * @property {string} file    path as supplied by the caller
+ * @property {number} line    1-based
+ * @property {string} rule    short machine-readable rule name
+ * @property {string} detail  what was found, in words
+ */
+
+/**
+ * Check every supplied source against the core's boundary rules.
+ *
+ * Returns every violation rather than the first, so one run tells you
+ * everything that has to change — the same contract as the pin gate.
+ *
+ * @param {ReadonlyArray<{ path: string, source: string }>} sources
+ * @returns {{ ok: boolean, violations: Violation[] }}
+ */
+export function checkCorePurity(sources) {
+	/** @type {Violation[]} */
+	const violations = [];
+
+	for (const { path, source } of sources) {
+		const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
+
+		/**
+		 * @param {ts.Node} node
+		 * @param {string} rule
+		 * @param {string} detail
+		 */
+		const report = (node, rule, detail) => {
+			const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
+			violations.push({ file: path, line: line + 1, rule, detail });
+		};
+
+		/**
+		 * @param {ts.Node} node
+		 * @param {ts.Expression | undefined} specifier
+		 */
+		const checkSpecifier = (node, specifier) => {
+			if (specifier === undefined || !ts.isStringLiteral(specifier)) {
+				report(node, 'dynamic-specifier', 'import specifier is not a literal string');
+				return;
+			}
+			const text = specifier.text;
+			if (!RELATIVE_SPECIFIER.test(text)) {
+				const kind = text.startsWith('$')
+					? 'an alias'
+					: text.startsWith('node:')
+						? 'a Node built-in'
+						: 'a bare specifier';
+				report(
+					node,
+					'non-relative-import',
+					`imports ${JSON.stringify(text)} — ${kind}; the core may import nothing outside the TypeScript standard library, and only by relative path`
+				);
+				return;
+			}
+			if (!text.endsWith('.ts')) {
+				report(
+					node,
+					'missing-ts-extension',
+					`imports ${JSON.stringify(text)} without an explicit .ts extension — Deno will not resolve it`
+				);
+			}
+		};
+
+		/** @param {ts.Node} node */
+		const visit = (node) => {
+			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
+				// A bare `export { x }` has no specifier and is not an import.
+				if (node.moduleSpecifier !== undefined) checkSpecifier(node, node.moduleSpecifier);
+			} else if (ts.isImportTypeNode(node)) {
+				const argument = node.argument;
+				checkSpecifier(
+					node,
+					ts.isLiteralTypeNode(argument) ? argument.literal : /** @type {any} */ (undefined)
+				);
+			} else if (ts.isCallExpression(node)) {
+				if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
+					report(
+						node,
+						'dynamic-import',
+						'uses dynamic import(); the core is statically resolvable or it is not portable'
+					);
+				}
+			} else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
+				const object = node.expression.text;
+				const property = node.name.text;
+				for (const [forbiddenObject, forbiddenProperty] of FORBIDDEN_MEMBERS) {
+					if (object === forbiddenObject && property === forbiddenProperty) {
+						report(
+							node,
+							'forbidden-reference',
+							`references ${object}.${property} — the core takes no clock, no randomness and no ambient state (AD-1, AD-3)`
+						);
+					}
+				}
+			} else if (ts.isMetaProperty(node)) {
+				report(node, 'forbidden-reference', 'references import.meta — not portable across runtimes');
+			} else if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isReference(node)) {
+				report(
+					node,
+					'forbidden-reference',
+					`references ${node.text} — the core takes no clock, no randomness and no ambient state (AD-1, AD-3)`
+				);
+			}
+
+			ts.forEachChild(node, visit);
+		};
+
+		ts.forEachChild(file, visit);
+	}
+
+	violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
+	return { ok: violations.length === 0, violations };
+}
+
+/**
+ * Is this identifier a value reference, rather than a property name, a member
+ * name, or the name being declared? `row.process` and `{ process: 1 }` are not
+ * references to the ambient `process`.
+ *
+ * @param {ts.Identifier} node
+ * @returns {boolean}
+ */
+function isReference(node) {
+	const parent = node.parent;
+	if (parent === undefined) return true;
+	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
+	if (ts.isQualifiedName(parent) && parent.right === node) return false;
+	if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
+	if (ts.isPropertySignature(parent) && parent.name === node) return false;
+	if (ts.isMethodSignature(parent) && parent.name === node) return false;
+	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
+	// A declaration introducing the name shadows nothing that matters here, but
+	// declaring `const process = ...` inside the core is still worth refusing,
+	// so declarations deliberately count as references.
+	return true;
+}
+
+/**
+ * Render violations for a terminal, one per line, path first so the editor can
+ * link them.
+ *
+ * @param {ReadonlyArray<Violation>} violations
+ * @returns {string}
+ */
+export function formatViolations(violations) {
+	return violations
+		.map((v) => `${CORE_DIRECTORY}/${v.file}:${v.line} — [${v.rule}] ${v.detail}`)
+		.join('\n');
+}
+
+// CLI entry point. The comparison is case-insensitive because on Windows the
+// drive letter's case differs between `node scripts/x.js` and an npm-script
+// invocation, and a case-sensitive check silently skips the gate entirely.
+const invoked = process.argv[1];
+if (invoked !== undefined && import.meta.url.toLowerCase() === pathToFileURL(invoked).href.toLowerCase()) {
+	const result = checkCorePurity(readCoreSources());
+	if (!result.ok) {
+		process.stderr.write(
+			`The pure core boundary is broken (AD-1, AD-2):\n${formatViolations(result.violations)}\n`
+		);
+		process.exitCode = 1;
+	}
+}
diff --git a/tests/constants.test.ts b/tests/constants.test.ts
new file mode 100644
index 0000000..c87a557
--- /dev/null
+++ b/tests/constants.test.ts
@@ -0,0 +1,95 @@
+import { describe, expect, it } from 'vitest';
+import { readFileSync, readdirSync, statSync } from 'node:fs';
+import { join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+import * as constants from '../src/lib/core/constants.ts';
+
+const ROOT = fileURLToPath(new URL('..', import.meta.url));
+const CONSTANTS_SOURCE = readFileSync(join(ROOT, 'src', 'lib', 'core', 'constants.ts'), 'utf8');
+
+describe('every league constant is a named value in the core', () => {
+	it('holds the money figures PRD §11 fixes', () => {
+		expect(constants.SALARY_CAP).toBe(165_000_000);
+		expect(constants.MINIMUM_BID).toBe(1_000_000);
+		expect(constants.MINIMUM_INCREMENT).toBe(500_000);
+	});
+
+	it('serves the Minimum Increment and the grid from one constant', () => {
+		// Two constants holding 500_000 could drift, and the abbreviated
+		// rendering is lossless only while every figure sits on this one grid.
+		const declarations = CONSTANTS_SOURCE.match(/^export const \w+ = 500_000;$/gm) ?? [];
+		expect(declarations).toHaveLength(1);
+		expect(declarations[0]).toContain('MINIMUM_INCREMENT');
+	});
+
+	it('holds both clocks, as durations rather than instants', () => {
+		expect(constants.AUCTION_CLOCK).toBe(24 * 60 * 60 * 1000);
+		expect(constants.LEAGUE_CLOCK).toBe(48 * 60 * 60 * 1000);
+	});
+
+	it('holds the freshness windows AD-29 names, in the order it names them', () => {
+		expect(constants.FRESHNESS_WINDOW).toBe(30 * 1000);
+		expect(constants.STALE_WINDOW).toBe(120 * 1000);
+		expect(constants.FRESHNESS_WINDOW).toBeLessThan(constants.STALE_WINDOW);
+	});
+
+	it('holds every slot count', () => {
+		expect(constants.ACTIVE_BENCH_SLOTS).toBe(12);
+		expect(constants.INJURY_RESERVE_SLOTS).toBe(2);
+		expect(constants.MINOR_LEAGUE_SLOTS).toBe(3);
+	});
+
+	it('holds the Year Allotment, with one-year deals deliberately uncounted', () => {
+		expect(constants.YEAR_ALLOTMENT).toEqual({ fourYear: 1, threeYear: 1, twoYear: 2 });
+		expect(Object.isFrozen(constants.YEAR_ALLOTMENT)).toBe(true);
+		expect(constants.YEAR_ALLOTMENT).not.toHaveProperty('oneYear');
+	});
+});
+
+describe('the AD-6 advisory lock key', () => {
+	it('is a single bigint, so every caller uses the one-argument form', () => {
+		// pg_advisory_xact_lock(bigint) and pg_advisory_xact_lock(int, int)
+		// occupy disjoint lock spaces. A two-element key would invite the
+		// two-argument form, and a mixed arity excludes nothing at all.
+		expect(typeof constants.GLOBAL_WRITE_LOCK_KEY).toBe('bigint');
+		expect(Array.isArray(constants.GLOBAL_WRITE_LOCK_KEY)).toBe(false);
+	});
+
+	it('fits Postgres int8', () => {
+		expect(constants.GLOBAL_WRITE_LOCK_KEY).toBeLessThan(2n ** 63n);
+		expect(constants.GLOBAL_WRITE_LOCK_KEY).toBeGreaterThan(-(2n ** 63n));
+	});
+
+	it('is declared exactly once', () => {
+		expect(CONSTANTS_SOURCE.match(/GLOBAL_WRITE_LOCK_KEY/g)).toHaveLength(1);
+	});
+});
+
+describe('no administrative surface can edit any of them', () => {
+	it('reads no environment variable and no configuration file', () => {
+		expect(CONSTANTS_SOURCE).not.toMatch(/process\.env|import\.meta\.env|readFileSync|JSON\.parse/);
+		// The leaf of the core: it imports nothing, which is also what lets
+		// money.ts import the grid from here without a cycle.
+		expect(CONSTANTS_SOURCE).not.toMatch(/^import\s/m);
+	});
+
+	it('exports only constants — nothing that could set one', () => {
+		for (const [name, value] of Object.entries(constants)) {
+			expect(typeof value, `${name} is not a value`).not.toBe('function');
+		}
+	});
+
+	it('is not shadowed by a second constants module anywhere in src/', () => {
+		const found: string[] = [];
+		const walk = (directory: string): void => {
+			for (const entry of readdirSync(directory)) {
+				const full = join(directory, entry);
+				if (statSync(full).isDirectory()) walk(full);
+				else if (entry === 'constants.ts') found.push(full);
+			}
+		};
+		walk(join(ROOT, 'src'));
+		expect(found).toHaveLength(1);
+	});
+});
diff --git a/tests/money.test.ts b/tests/money.test.ts
new file mode 100644
index 0000000..7f177b2
--- /dev/null
+++ b/tests/money.test.ts
@@ -0,0 +1,227 @@
+import { describe, expect, it } from 'vitest';
+import { readFileSync } from 'node:fs';
+import { join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+import ts from 'typescript';
+
+import {
+	addMoney,
+	compareMoney,
+	formatMoney,
+	multiplyMoney,
+	parseMoney,
+	subtractMoney,
+	toExportDollars,
+	type ExportCell,
+	type Money
+} from '../src/lib/core/money.ts';
+
+const ROOT = fileURLToPath(new URL('..', import.meta.url));
+const MONEY_SOURCE = readFileSync(join(ROOT, 'src', 'lib', 'core', 'money.ts'), 'utf8');
+
+/** U+2212, the character the renderer must use. The codepoint is asserted
+ *  separately below, so this still fails if an editor silently normalises
+ *  either file's minus sign to a hyphen. */
+const MINUS = '−';
+
+describe('money crosses a runtime boundary exactly once', () => {
+	it('parses the string node-postgres delivers for an int8', () => {
+		expect(parseMoney('8500000')).toBe(8500000);
+	});
+
+	it('parses the number PostgREST delivers for the same column', () => {
+		expect(parseMoney(8500000)).toBe(8500000);
+	});
+
+	it('converges both wire shapes on one value', () => {
+		expect(parseMoney('8500000')).toBe(parseMoney(8500000));
+	});
+
+	it('parses negatives and zero', () => {
+		expect(parseMoney('-4000000')).toBe(-4000000);
+		expect(parseMoney(0)).toBe(0);
+		expect(Object.is(parseMoney('-0'), 0)).toBe(true);
+	});
+
+	const REFUSED: ReadonlyArray<[string, unknown]> = [
+		['a fractional number', 8500000.5],
+		['exponent notation', '8.5e6'],
+		['a decimal point in text', '8500000.0'],
+		['a thousands separator', '8,500,000'],
+		['leading zeros', '008500000'],
+		['whitespace-only', '   '],
+		['the empty string', ''],
+		['NaN', Number.NaN],
+		['Infinity', Number.POSITIVE_INFINITY],
+		['null', null],
+		['undefined', undefined],
+		['a boolean', true],
+		['an object', { amount: 8500000 }],
+		['a bigint', 8500000n]
+	];
+
+	it.each(REFUSED)('refuses %s', (_name: string, value: unknown) => {
+		expect(() => parseMoney(value)).toThrow();
+	});
+
+	it('refuses a value beyond safe-integer range rather than rounding it', () => {
+		// Number("9007199254740993") is 9007199254740992 — a silent one-dollar
+		// loss, which is exactly the class of bug the branded type exists for.
+		expect(() => parseMoney('9007199254740993')).toThrow(/safe-integer/);
+	});
+
+	it('names what it received, so a bad column is findable', () => {
+		expect(() => parseMoney(null)).toThrow(/object/);
+		expect(() => parseMoney('8.5e6')).toThrow(/digits/);
+	});
+});
+
+describe('arithmetic keeps the brand', () => {
+	const cap = parseMoney(165_000_000);
+	const bid = parseMoney(1_000_000);
+
+	it('adds, subtracts and scales', () => {
+		expect(addMoney(cap, bid)).toBe(166_000_000);
+		expect(subtractMoney(cap, bid)).toBe(164_000_000);
+		expect(multiplyMoney(bid, 12)).toBe(12_000_000);
+	});
+
+	it('allows a negative difference — Available Cap Space legitimately goes under', () => {
+		expect(subtractMoney(bid, cap)).toBe(-164_000_000);
+	});
+
+	it('orders explicitly, for sequences a rule may depend on', () => {
+		expect(compareMoney(bid, cap)).toBe(-1);
+		expect(compareMoney(cap, cap)).toBe(0);
+		expect(compareMoney(cap, bid)).toBe(1);
+	});
+
+	it('refuses a fractional scale factor', () => {
+		expect(() => multiplyMoney(bid, 1.5)).toThrow(/whole count/);
+	});
+});
+
+describe('the renderer is lossless or it is loud', () => {
+	const RENDERINGS: ReadonlyArray<[number, string]> = [
+		[14_500_000, '$14.5M'],
+		[12_000_000, '$12.0M'],
+		[165_000_000, '$165.0M'],
+		[1_000_000, '$1.0M'],
+		[500_000, '$0.5M'],
+		[0, '$0.0M']
+	];
+
+	it.each(RENDERINGS)('renders %d as %s', (amount: number, expected: string) => {
+		expect(formatMoney(parseMoney(amount))).toBe(expected);
+	});
+
+	it('never drops the decimal, even on a whole million', () => {
+		expect(formatMoney(parseMoney(12_000_000))).not.toBe('$12M');
+	});
+
+	it('uses a true minus sign, not a hyphen', () => {
+		const rendered = formatMoney(parseMoney(-4_000_000));
+		expect(rendered).toBe(`${MINUS}$4.0M`);
+		expect(rendered.startsWith('-')).toBe(false);
+		expect(rendered.codePointAt(0)).toBe(0x2212);
+	});
+
+	it.each([4_250_000, 250_000, -1_250_000, 1])(
+		'refuses %d rather than rounding it onto the grid',
+		(amount: number) => {
+			expect(() => formatMoney(parseMoney(amount))).toThrow(/grid/);
+		}
+	);
+});
+
+describe('the export path emits integers, never a rendering', () => {
+	it('encodes exact dollars', () => {
+		expect(toExportDollars(parseMoney(14_500_000))).toBe('14500000');
+		expect(toExportDollars(parseMoney(-4_000_000))).toBe('-4000000');
+	});
+
+	it('never abbreviates', () => {
+		expect(toExportDollars(parseMoney(14_500_000))).not.toContain('M');
+		expect(toExportDollars(parseMoney(14_500_000))).not.toContain('$');
+	});
+
+	it('round-trips back through the parser', () => {
+		const amount = parseMoney(14_500_000);
+		expect(parseMoney(toExportDollars(amount))).toBe(amount);
+	});
+});
+
+describe('the compile-time guarantees', () => {
+	// These assertions are verified by `npm run check`, which type-checks
+	// tests/**. Vitest itself strips types without checking them, so the
+	// function below is never called — its value is that svelte-check reports
+	// an error if any @ts-expect-error stops being an error.
+	function neverRun(): void {
+		// @ts-expect-error — an unparsed string is not Money; "8500000" + 500000
+		// is the concatenation AD-8 exists to make impossible to write.
+		const concatenated: Money = '8500000' + 500000;
+
+		// @ts-expect-error — a bare number has not crossed the parser.
+		const unparsed: Money = 8500000;
+
+		// @ts-expect-error — arithmetic helpers take Money, not numbers.
+		addMoney(1_000_000, 500_000);
+
+		// @ts-expect-error — the CSV path cannot be handed a rendering.
+		const cell: ExportCell = formatMoney(parseMoney(14_500_000));
+
+		// @ts-expect-error — nor can it be handed an ordinary string.
+		const rawCell: ExportCell = '14500000';
+
+		void concatenated;
+		void unparsed;
+		void cell;
+		void rawCell;
+	}
+
+	it('are declared, and checked by svelte-check rather than by vitest', () => {
+		expect(neverRun).toBeTypeOf('function');
+	});
+});
+
+describe('no float reaches the money path', () => {
+	it('declares no fractional numeric literal', () => {
+		// Parsed rather than grepped: `$14.5M` appears in this module's own doc
+		// comments, and a text search would flag them.
+		const file = ts.createSourceFile(
+			'money.ts',
+			MONEY_SOURCE,
+			ts.ScriptTarget.Latest,
+			true,
+			ts.ScriptKind.TS
+		);
+		const fractional: string[] = [];
+		const visit = (node: ts.Node): void => {
+			if (ts.isNumericLiteral(node) && node.getText(file).includes('.')) {
+				fractional.push(node.getText(file));
+			}
+			ts.forEachChild(node, visit);
+		};
+		ts.forEachChild(file, visit);
+		expect(fractional).toEqual([]);
+	});
+
+	it.each(['toFixed', 'parseFloat', 'toPrecision', 'toLocaleString', 'Intl.NumberFormat'])(
+		'never reaches for %s',
+		(construct: string) => {
+			expect(MONEY_SOURCE).not.toContain(construct);
+		}
+	);
+
+	it('carries no decimal library or cents representation', () => {
+		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
+			dependencies?: Record<string, string>;
+			devDependencies?: Record<string, string>;
+		};
+		const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
+		for (const name of ['decimal.js', 'big.js', 'bignumber.js', 'dinero.js', 'currency.js']) {
+			expect(installed, `${name} must not be a dependency`).not.toContain(name);
+		}
+	});
+});
diff --git a/tests/purity.test.ts b/tests/purity.test.ts
new file mode 100644
index 0000000..d380bc9
--- /dev/null
+++ b/tests/purity.test.ts
@@ -0,0 +1,161 @@
+import { describe, expect, it } from 'vitest';
+import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+import { checkCorePurity, readCoreSources } from '../scripts/check-core-purity.js';
+
+const ROOT = fileURLToPath(new URL('..', import.meta.url));
+
+/** Check one synthetic file and return its violation rules, in order. */
+function rulesFor(source: string, path = 'sample.ts'): string[] {
+	return checkCorePurity([{ path, source }]).violations.map((v) => v.rule);
+}
+
+describe('the core may import nothing outside the standard library', () => {
+	it.each([
+		["import { x } from '$lib/server/db';", 'an alias'],
+		["import { readFileSync } from 'node:fs';", 'a Node built-in'],
+		["import { z } from 'zod';", 'a bare specifier'],
+		["export { x } from 'svelte';", 're-export of a bare specifier'],
+		["import type { T } from 'node:stream';", 'a type-only Node built-in']
+	])('refuses %s — %s', (source: string) => {
+		expect(rulesFor(source)).toEqual(['non-relative-import']);
+	});
+
+	it('names the specifier and what kind it is, so the message is actionable', () => {
+		const [violation] = checkCorePurity([
+			{ path: 'rules/bid.ts', source: "import { x } from '$lib/db';" }
+		]).violations;
+		expect(violation?.detail).toContain('"$lib/db"');
+		expect(violation?.detail).toContain('an alias');
+		expect(violation?.line).toBe(1);
+	});
+});
+
+describe('every relative import carries an explicit .ts extension', () => {
+	it.each([
+		"import { MINIMUM_INCREMENT } from './constants';",
+		"import { MINIMUM_INCREMENT } from './constants.js';",
+		"import { x } from '../rules/bid';",
+		"export * from './money';"
+	])('refuses %s — Deno would not resolve it', (source: string) => {
+		expect(rulesFor(source)).toEqual(['missing-ts-extension']);
+	});
+
+	it.each([
+		"import { MINIMUM_INCREMENT } from './constants.ts';",
+		"import type { Money } from '../money.ts';",
+		"export { formatMoney } from './money.ts';"
+	])('accepts %s', (source: string) => {
+		expect(rulesFor(source)).toEqual([]);
+	});
+});
+
+describe('the core takes no clock, no randomness and no ambient state', () => {
+	it.each([
+		['Date.now()', 'const t = Date.now();'],
+		['new Date()', 'const t = new Date();'],
+		['Math.random()', 'const r = Math.random();'],
+		['fetch', 'const r = fetch("/x");'],
+		['process', 'const e = process.env.KEY;'],
+		['crypto', 'const id = crypto.randomUUID();'],
+		['setTimeout', 'setTimeout(() => {}, 1);'],
+		['globalThis', 'const g = globalThis;'],
+		['import.meta', 'const u = import.meta.url;'],
+		['dynamic import', 'const m = await import("./money.ts");']
+	])('refuses %s', (_name: string, source: string) => {
+		expect(rulesFor(source).length).toBeGreaterThan(0);
+	});
+
+	it('permits the stdlib arithmetic a money renderer actually needs', () => {
+		expect(
+			rulesFor('export const f = (n: number) => Math.abs(Math.trunc(n)) % 5 === 0;')
+		).toEqual([]);
+	});
+
+	it('does not mistake a property of the same name for the global', () => {
+		// `row.process` and `{ process: 1 }` are not the ambient process.
+		expect(rulesFor('export const f = (row: { process: number }) => row.process + 1;')).toEqual([]);
+	});
+});
+
+describe('comments and strings are not code', () => {
+	// The core's own doc comments name every forbidden construct, so a scanner
+	// reading raw text fails on the files it exists to protect. This is the
+	// regression test for that: it is the reason the checker parses rather than
+	// pattern-matches.
+	const source = [
+		'/**',
+		' * This module never calls Date.now(), Math.random() or fetch, and never',
+		" * imports from 'node:fs' or '$lib/server'. Relative .ts imports only.",
+		' */',
+		"export const NOTE = 'do not use Date.now() here';",
+		"export const SPECIFIER_EXAMPLE = 'node:fs';",
+		'export const PATTERN = /process|fetch/;'
+	].join('\n');
+
+	it('passes a file whose comments and strings are full of forbidden words', () => {
+		expect(rulesFor(source)).toEqual([]);
+	});
+});
+
+describe('the walk covers the whole core, not a file list', () => {
+	it('reaches a violating file nested under rules/', () => {
+		const fixture = mkdtempSync(join(tmpdir(), 'bbsl-core-'));
+		try {
+			mkdirSync(join(fixture, 'rules'), { recursive: true });
+			writeFileSync(join(fixture, 'money.ts'), 'export const clean = 1;\n', 'utf8');
+			writeFileSync(join(fixture, 'rules', 'bid.ts'), "import { x } from 'zod';\n", 'utf8');
+			writeFileSync(join(fixture, 'rules', 'notes.md'), 'import { y } from "zod";\n', 'utf8');
+
+			const sources = readCoreSources(fixture);
+			expect(sources.map((s) => s.path)).toEqual(['money.ts', 'rules/bid.ts']);
+
+			const result = checkCorePurity(sources);
+			expect(result.ok).toBe(false);
+			expect(result.violations).toHaveLength(1);
+			expect(result.violations[0]?.file).toBe('rules/bid.ts');
+		} finally {
+			rmSync(fixture, { recursive: true, force: true });
+		}
+	});
+});
+
+describe('the core as committed', () => {
+	it('passes the purity gate', () => {
+		const result = checkCorePurity(readCoreSources());
+		expect(result.violations).toEqual([]);
+		expect(result.ok).toBe(true);
+	});
+
+	it('actually reads the three AR-2 core files', () => {
+		// Guards against a walk that silently finds nothing and reports success.
+		expect(readCoreSources().map((s) => s.path)).toEqual(
+			expect.arrayContaining(['constants.ts', 'money.ts', 'types.ts'])
+		);
+	});
+});
+
+describe('the second runtime is checked where it exists', () => {
+	// The static walk proves the core does not reach for anything forbidden;
+	// only Deno proves the core actually resolves and type-checks under the
+	// runtime the tick function runs in (AD-2). Deno is not installed locally,
+	// so CI is the only place that step can run — which makes its presence in
+	// the workflow a thing worth asserting.
+	const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
+
+	it('installs Deno from an action pinned by commit', () => {
+		expect(workflow).toMatch(/denoland\/setup-deno@[0-9a-f]{40}/);
+	});
+
+	it('type-checks the core under Deno', () => {
+		expect(workflow).toContain('deno check');
+		expect(workflow).toContain('src/lib/core');
+	});
+
+	it('runs the purity gate through the test suite', () => {
+		expect(workflow).toContain('npm test');
+	});
+});


Do not invoke any skill. Return only the review result.