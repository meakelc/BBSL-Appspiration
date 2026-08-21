You are an Acceptance Auditor. Review the provided diff against `_bmad-output/implementation-artifacts/spec-1-2-the-pure-core-boundary-and-integer-money.md` and any loaded context docs. Check for: violations of acceptance criteria, deviations from spec intent, missing implementation of specified behavior, contradictions between spec constraints and actual code. Output findings as a Markdown list. Each finding: one-line title, which AC/constraint it violates, and evidence from the diff.

Read `_bmad-output/implementation-artifacts/spec-1-2-the-pure-core-boundary-and-integer-money.md` completely first — it is the authority you are auditing against. Its `<frozen-after-approval>` Intent section and its Boundaries & Constraints (Always / Ask First) sections are the binding requirements. Also read `_bmad-output/implementation-artifacts/epic-1-context.md` if it is referenced by the spec frontmatter.

Report only spec-versus-code conformance. "The spec required X and the code does not do X" is your finding. "The code does X and I would have done Y" is not — drop it. Do not assign severity, priority, or ranking; the orchestrating workflow owns triage and will discard any severity you set.

Diff:

diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 386d5c6..b8e637a 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -57,3 +57,20 @@ jobs:
       # does not typecheck.
       - name: Typecheck
         run: npm run check
+
+      # AD-2: the rules core is loaded by two runtimes and must never be copied
+      # per runtime. The static purity gate above proves the core reaches for
+      # nothing forbidden; only Deno proves it actually resolves and
+      # type-checks under the runtime the tick Edge Function runs in. Deno is
+      # not installed on a developer machine, so this is the only place the
+      # second half of that guarantee is checked.
+      - name: Set up Deno
+        uses: denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5
+        with:
+          deno-version: v2.9.5
+
+      # --no-config so a stray deno.json cannot change what is being proved,
+      # and --no-lock because nothing here resolves a remote dependency: a core
+      # file that needs one is already a purity-gate failure.
+      - name: Type-check the core under Deno
+        run: find src/lib/core -name '*.ts' -print0 | xargs -0 --no-run-if-empty deno check --no-config --no-lock
diff --git a/package.json b/package.json
index 20650f3..cd9d79a 100644
--- a/package.json
+++ b/package.json
@@ -9,11 +9,12 @@
   },
   "scripts": {
     "dev": "vite dev",
-    "build": "node scripts/check-pins.js && vite build",
+    "build": "node scripts/check-pins.js && node scripts/check-core-purity.js && vite build",
     "preview": "vite preview",
     "prepare": "svelte-kit sync",
     "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
     "check:pins": "node scripts/check-pins.js",
+    "check:purity": "node scripts/check-core-purity.js",
     "test": "vitest run"
   },
   "devDependencies": {
diff --git a/src/lib/core/constants.ts b/src/lib/core/constants.ts
index cfa2833..5c480a1 100644
--- a/src/lib/core/constants.ts
+++ b/src/lib/core/constants.ts
@@ -1,20 +1,96 @@
 /**
  * League constants and the AD-6 advisory lock key.
  *
- * Stub. Story 1.2 fills this in.
+ * These live in code and no admin UI, configuration file or environment
+ * variable can edit them (PRD §7.2, §11). The league is not multi-tenant and
+ * these values are not settings.
  *
- * These live in code and no admin UI can edit them (PRD §7.2). The set is
- * already settled: the salary cap, the minimum bid, the increment — which is
- * also the granularity, one constant serving both — the two clock durations,
- * the Active, Bench, Injury Reserve and Minor League slot counts, the allotment
- * counts, and the single lock key.
- *
- * One global advisory transaction lock, one named constant, one arity. The one-
- * and two-argument forms of pg_advisory_xact_lock occupy disjoint lock spaces,
- * so mixing them is a silent total failure.
+ * This module is the leaf of the core: it imports nothing, so `money.ts` can
+ * import the $500,000 grid from here without a cycle. Money amounts below are
+ * plain integer dollars; brand them with `parseMoney()` where they enter a
+ * calculation.
  *
  * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
  * only, relative .ts imports only so Deno can load it (AD-2).
  */
 
-export {};
+/** The Salary Cap. PRD §3 glossary; §11 "$165M cap". */
+export const SALARY_CAP = 165_000_000;
+
+/**
+ * The least an Opening Bid may be. PRD §3 "Opening Bid — Minimum $1,000,000",
+ * and the per-hole figure Roster Reserve holds back (PRD §3 "Roster Reserve").
+ */
+export const MINIMUM_BID = 1_000_000;
+
+/**
+ * **One constant, two jobs.** The Minimum Increment a Bid in Standard
+ * Contention must exceed the current high by (PRD §3), *and* the granularity
+ * every money value in the product sits on. They are the same $500,000 and the
+ * epic AC requires one named value serving both — two constants could drift,
+ * and the abbreviated `$14.5M` rendering is lossless only while every figure
+ * sits on this grid (AD-8).
+ */
+export const MINIMUM_INCREMENT = 500_000;
+
+/**
+ * Durations, in milliseconds.
+ *
+ * These are lengths, never instants — nothing here reads a clock (AD-3). The
+ * shell adds a duration to the database's transaction-start time to get an
+ * absolute close timestamp; the core never learns what time it is.
+ *
+ * `FRESHNESS_WINDOW` and `STALE_WINDOW` are named verbatim as AD-29 and the
+ * epic AC require. No planning artifact assigned them a number; 30s and 120s
+ * are a human decision of 2026-08-20, taken against CAP-10's 5-second board
+ * floor. Story 4.1 consumes them and may renegotiate.
+ */
+
+/** The Auction Clock: 24 hours. Its expiry closes an Auction (PRD §3). */
+export const AUCTION_CLOCK = 24 * 60 * 60 * 1000;
+
+/** The League Clock: 48 hours. Its expiry ends the Auction Phase (PRD §3). */
+export const LEAGUE_CLOCK = 48 * 60 * 60 * 1000;
+
+/** Live requires a liveness check succeeding within this window (AD-29). */
+export const FRESHNESS_WINDOW = 30 * 1000;
+
+/** No successful liveness check within this window is Stale (AD-29). */
+export const STALE_WINDOW = 120 * 1000;
+
+/** Active/Bench Slots per Team. The Roster Capacity ceiling (FR-37). */
+export const ACTIVE_BENCH_SLOTS = 12;
+
+/** Injury Reserve Slots per Team. */
+export const INJURY_RESERVE_SLOTS = 2;
+
+/** Minor League Slots per Team. Only a Minor League Eligible Player may fill one. */
+export const MINOR_LEAGUE_SLOTS = 3;
+
+/**
+ * The Year Allotment: each Team's per-offseason budget of contract lengths
+ * (PRD §3). One-year deals are unlimited and therefore have no count — the
+ * absence is deliberate, not an omission.
+ */
+export const YEAR_ALLOTMENT = Object.freeze({
+	fourYear: 1,
+	threeYear: 1,
+	twoYear: 2
+});
+
+/**
+ * The single global write lock (AD-6). Every mutating transaction takes this
+ * before reading any state.
+ *
+ * **One key, one arity.** Postgres' `pg_advisory_xact_lock(bigint)` and
+ * `pg_advisory_xact_lock(int, int)` occupy disjoint lock spaces and do not
+ * exclude one another, so a caller using the two-argument form while another
+ * uses the one-argument form takes a lock that excludes nothing — a silent,
+ * total failure of this AD. This value is a single `bigint` and is passed to
+ * the one-argument form, verbatim, by every caller in both runtimes.
+ *
+ * The value is ASCII `BBSL` in the high 32 bits and a sequence number in the
+ * low, so it is recognisable in `pg_locks` and cannot collide by accident with
+ * a key anyone else picks.
+ */
+export const GLOBAL_WRITE_LOCK_KEY = 0x4242534c00000001n;
diff --git a/src/lib/core/money.ts b/src/lib/core/money.ts
index 7a1f961..18025d0 100644
--- a/src/lib/core/money.ts
+++ b/src/lib/core/money.ts
@@ -1,22 +1,167 @@
 /**
  * Branded integer-dollar money type and its edge parsers (AD-8).
  *
- * Stub. Story 1.2 fills this in.
- *
- * Constraints already fixed for that story:
- *  - Integer dollars end to end. Never a float, never an unparsed string, never
- *    formatted before the view.
- *  - Branded at every runtime boundary — the same int8 arrives as a string
- *    through one client and a number through the other, so both parse at the
- *    edge.
- *  - Rendered $14.5M: always exactly one decimal, never dropped; a true minus
- *    sign (U+2212) for negatives; fails loudly rather than rounding off the
- *    $500,000 grid.
- *  - The renderer must be structurally unable to reach a CSV cell — exports emit
- *    integers, never the rendering.
+ * Integer dollars end to end: no float, no decimal library, no cents. The same
+ * `int8` column deserialises as a `string` through node-postgres and as a
+ * `number` through PostgREST, so every runtime boundary parses explicitly into
+ * `Money` before anything arithmetic happens to it.
+ *
+ * Three brands, deliberately mutually unassignable:
+ *
+ *  - `Money`        an integer-dollar amount the core will accept
+ *  - `DisplayMoney` the abbreviated rendering; permitted in the UI and in
+ *                   Discord payloads, which are a view of the same figures for
+ *                   the same readers
+ *  - `ExportCell`   an exact integer for a CSV cell
+ *
+ * `DisplayMoney` is not assignable to `ExportCell`, so the CSV export path is
+ * structurally unable to emit a rendering — which would silently corrupt the
+ * Fantrax round-trip. That is a compile error, not a code-review convention.
  *
  * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
  * only, relative .ts imports only so Deno can load it (AD-2).
  */
 
-export {};
+import { MINIMUM_INCREMENT } from './constants.ts';
+
+declare const MoneyBrand: unique symbol;
+declare const DisplayBrand: unique symbol;
+declare const ExportBrand: unique symbol;
+
+/** An amount in whole dollars, parsed at a boundary and never a bare number. */
+export type Money = number & { readonly [MoneyBrand]: never };
+
+/** The abbreviated rendering. UI and Discord only — never a CSV cell. */
+export type DisplayMoney = string & { readonly [DisplayBrand]: never };
+
+/** An exact integer-dollar string bound for a CSV cell. Never a rendering. */
+export type ExportCell = string & { readonly [ExportBrand]: never };
+
+/** Dollars per rendered tenth. One tenth of a million. */
+const DOLLARS_PER_TENTH = 100_000;
+
+/** Dollars per rendered whole unit. */
+const DOLLARS_PER_MILLION = 1_000_000;
+
+/** U+2212 MINUS SIGN. Not a hyphen — DESIGN.md is explicit about this. */
+const MINUS_SIGN = '−';
+
+/** Exactly an optionally-signed run of digits. No exponent, no decimal point. */
+const INTEGER_TEXT = /^-?[0-9]+$/;
+
+/**
+ * Parse a value arriving from any runtime boundary into `Money`.
+ *
+ * Accepts the two shapes an `int8` actually arrives as — a `string` from
+ * node-postgres, a `number` from PostgREST — and refuses everything else
+ * loudly. A money value that cannot be parsed is corruption or a wiring
+ * mistake, never a rule violation, so this throws rather than returning a
+ * refusal (AD-1: a thrown exception signals a bug and nothing else).
+ */
+export function parseMoney(value: unknown): Money {
+	if (typeof value === 'number') {
+		if (!Number.isSafeInteger(value)) {
+			throw new TypeError(
+				`money must be a whole number of dollars within safe-integer range, received ${String(value)}`
+			);
+		}
+		return (value === 0 ? 0 : value) as Money;
+	}
+
+	if (typeof value === 'string') {
+		const text = value.trim();
+		if (!INTEGER_TEXT.test(text)) {
+			throw new TypeError(
+				`money text must be an optionally-signed run of digits, received ${JSON.stringify(value)}`
+			);
+		}
+		const parsed = Number(text) === 0 ? 0 : Number(text);
+		if (!Number.isSafeInteger(parsed)) {
+			throw new TypeError(
+				`money text ${JSON.stringify(text)} exceeds safe-integer range and would be rounded`
+			);
+		}
+		// Round-trip: rejects leading zeros and any value the Number conversion
+		// altered. `String(-0)` is `"0"`, which is why -0 is normalised above.
+		if (String(parsed) !== (text.startsWith('-') && parsed === 0 ? '0' : text)) {
+			throw new TypeError(`money text ${JSON.stringify(text)} does not round-trip as an integer`);
+		}
+		return parsed as Money;
+	}
+
+	throw new TypeError(`money must arrive as a string or a number, received ${typeof value}`);
+}
+
+/** Re-brand a computed amount, refusing anything that left integer range. */
+function brand(result: number, operation: string): Money {
+	if (!Number.isSafeInteger(result)) {
+		throw new RangeError(`${operation} left safe-integer range: ${String(result)}`);
+	}
+	return (result === 0 ? 0 : result) as Money;
+}
+
+/** Sum. Brand-preserving, so the result stays usable as `Money`. */
+export function addMoney(a: Money, b: Money): Money {
+	return brand(a + b, 'addMoney');
+}
+
+/** Difference. May be negative — Available Cap Space legitimately is. */
+export function subtractMoney(a: Money, b: Money): Money {
+	return brand(a - b, 'subtractMoney');
+}
+
+/**
+ * Scale by a whole count — Roster Reserve is `MINIMUM_BID × holes`. The factor
+ * is a count, not money, which is why it is a plain integer.
+ */
+export function multiplyMoney(amount: Money, factor: number): Money {
+	if (!Number.isSafeInteger(factor)) {
+		throw new TypeError(`money may only be scaled by a whole count, received ${String(factor)}`);
+	}
+	return brand(amount * factor, 'multiplyMoney');
+}
+
+/** Ordering, for explicitly sorted sequences (AD-1 forbids incidental order). */
+export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
+	if (a < b) return -1;
+	if (a > b) return 1;
+	return 0;
+}
+
+/**
+ * Render for display: `$14.5M`, always exactly one decimal, never dropped.
+ *
+ * Lossless rather than rounded, and only because every BBSL figure sits on the
+ * `MINIMUM_INCREMENT` grid: an amount on that grid has a tenths digit of
+ * exactly 0 or 5 and nothing else, so the digits are taken by remainder and
+ * exact division and concatenated. Nothing here is a floating-point operation
+ * to be rounded — an off-grid amount is refused rather than made to fit.
+ */
+export function formatMoney(amount: Money): DisplayMoney {
+	const negative = amount < 0;
+	const magnitude = negative ? -amount : amount;
+
+	if (magnitude % MINIMUM_INCREMENT !== 0) {
+		throw new RangeError(
+			`${String(amount)} is not on the $${String(MINIMUM_INCREMENT)} grid and cannot be rendered at one decimal place`
+		);
+	}
+
+	const remainder = magnitude % DOLLARS_PER_MILLION;
+	const millions = (magnitude - remainder) / DOLLARS_PER_MILLION;
+	const tenths = remainder / DOLLARS_PER_TENTH;
+
+	return `${negative ? MINUS_SIGN : ''}$${String(millions)}.${String(tenths)}M` as DisplayMoney;
+}
+
+/**
+ * Encode for a CSV cell: exact integer dollars, never a rendering (AD-24).
+ *
+ * The distinct brand is the whole point. A CSV writer accepting `ExportCell`
+ * cannot be handed `formatMoney()`'s output, so `$14.5M` reaching a Fantrax
+ * round-trip is a compile error rather than a silent data corruption found
+ * next offseason.
+ */
+export function toExportDollars(amount: Money): ExportCell {
+	return String(amount) as ExportCell;
+}
diff --git a/src/lib/core/types.ts b/src/lib/core/types.ts
index 7fad886..4714452 100644
--- a/src/lib/core/types.ts
+++ b/src/lib/core/types.ts
@@ -1,7 +1,9 @@
 /**
  * Commands, events, rejections and state for the pure core.
  *
- * Stub. Story 1.2 fills this in.
+ * Stub. Epic 2 fills this in, with the rules engine that gives these
+ * shapes meaning; Story 1.2 deliberately left it alone rather than declaring
+ * a gate set before any gate existed.
  *
  * Shape already settled: commands are present-tense imperatives (PlaceBid,
  * NominatePlayer). A rule violation is a returned Rejected value carrying a
diff --git a/tests/structure.test.ts b/tests/structure.test.ts
index 1cc5f06..f3c7b5c 100644
--- a/tests/structure.test.ts
+++ b/tests/structure.test.ts
@@ -62,16 +62,10 @@ describe('the AR-2 source tree', () => {
 	});
 });
 
-describe('the pure core boundary is not pre-broken', () => {
-	it.each(AR2_FILES)('%s takes no framework or aliased import', (path: string) => {
-		const source = readFileSync(at(...path.split('/')), 'utf8');
-		expect(source, `${path} must not import through $lib`).not.toMatch(/from\s+['"]\$/);
-		expect(source, `${path} must not import a node builtin`).not.toMatch(/from\s+['"]node:/);
-		expect(source, `${path} must use relative .ts imports only`).not.toMatch(
-			/from\s+['"](?!\.)[^'"]+['"]/
-		);
-	});
-});
+// The pure-core boundary was checked here against a hardcoded three-file list,
+// and its stated ".ts imports only" rule did not hold — `from './money'` passed
+// it and fails to load under Deno. Story 1.2 replaced it with a recursive walk;
+// see scripts/check-core-purity.js and tests/purity.test.ts.
 
 describe('the stack configuration', () => {
 	it('runs the Netlify adapter with edge: false', () => {
diff --git a/tsconfig.json b/tsconfig.json
index 7899aa0..dbedf49 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -2,6 +2,11 @@
 	"extends": "./.svelte-kit/tsconfig.json",
 	"compilerOptions": {
 		"allowJs": true,
+		// AD-2: the core writes `from './constants.ts'` so Deno resolves the
+		// same files Node does. TypeScript rejects an explicit .ts specifier
+		// without this, and the option is only legal because the generated
+		// config sets noEmit — nothing here emits JavaScript.
+		"allowImportingTsExtensions": true,
 		"checkJs": true,
 		"esModuleInterop": true,
 		"forceConsistentCasingInFileNames": true,
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
