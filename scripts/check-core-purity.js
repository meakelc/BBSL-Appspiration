/**
 * Pure-core boundary gate (AD-1, AD-2).
 *
 * `src/lib/core/**` is loaded by two runtimes — Node under SvelteKit and Deno
 * inside the Supabase Edge Function — and is the one directory in this
 * repository where an import of anything outside the TypeScript standard
 * library, or a read of a clock, is a defect rather than a style question. An
 * auction that closes under different rules than it bids under is the most
 * dangerous divergence available in this design, and this file is what makes
 * it unreachable rather than merely discouraged.
 *
 * This runs as part of `npm run build`, after the pin gate and before Vite, and
 * again under `npm test` through tests/purity.test.ts.
 *
 * **Why the TypeScript parser and not a regex.** The core's own doc comments
 * name the forbidden constructs — `Date.now()`, `Math.random()` — so a scanner
 * reading raw text fails on the very files it protects. Stripping comments and
 * strings by regex then has to solve regex-literal detection and template
 * interpolation to avoid both false positives and false negatives. The
 * compiler is already a pinned devDependency and answers all of that exactly:
 * a comment is not an identifier and a string's contents are not references.
 *
 * The checking logic is exported as a pure function so the test suite can drive
 * it with synthetic inputs; the CLI entry point at the bottom reads the real
 * files and sets the exit code.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

/** Repository root, resolved from this file rather than the caller's cwd. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The sealed directory. Everything below it, recursively, is the core. */
export const CORE_DIRECTORY = 'src/lib/core';

/**
 * Globals a pure rule may not reference. `Date` is forbidden outright, not just
 * `Date.now` — AD-3 injects the current instant as a parameter, so a core file
 * has no legitimate use for the constructor either. The list covers the AC's
 * named cases plus their obvious siblings; a false positive here is a rename,
 * a false negative is a rule that silently depends on ambient state.
 *
 * `eval` and `Function` are here because either one turns a string into code
 * the AST cannot see, which would defeat this entire file. `Intl` is here
 * because ICU data differs across runtimes and versions — the precise class of
 * Node/Deno divergence AD-2 exists to close. `WeakRef` and
 * `FinalizationRegistry` expose garbage-collection timing, which is not
 * deterministic and therefore not repayable under AD-5.
 *
 * Frozen, and the working Set is built from it privately: `Object.freeze` on a
 * Set does not prevent `.delete()`, so exporting a live Set would let an
 * importer disarm the gate.
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_GLOBALS = Object.freeze([
	'Date',
	'fetch',
	'process',
	'require',
	'globalThis',
	'crypto',
	'performance',
	'setTimeout',
	'setInterval',
	'setImmediate',
	'queueMicrotask',
	'eval',
	'Function',
	'Intl',
	'WeakRef',
	'FinalizationRegistry',
	'Deno',
	'Buffer',
	'__dirname',
	'__filename',
	'window',
	'document',
	'navigator',
	'localStorage',
	'sessionStorage',
	'XMLHttpRequest',
	'WebSocket'
]);

const FORBIDDEN_GLOBAL_SET = new Set(FORBIDDEN_GLOBALS);

/**
 * Property accesses a pure rule may not make. `Math` is otherwise fine —
 * `Math.abs` and `Math.trunc` are stdlib arithmetic — so only the one member
 * is refused. Checked through dot access *and* bracket access; `Math['random']`
 * is the same call written to slip a name-based check.
 */
export const FORBIDDEN_MEMBERS =
	/** @type {ReadonlyArray<readonly [object: string, property: string]>} */ (
		Object.freeze([Object.freeze(['Math', 'random'])])
	);

/** A relative specifier: the only kind the core may use (AD-2). */
const RELATIVE_SPECIFIER = /^\.\.?\//;

/**
 * Collect every TypeScript source under the core, recursively.
 *
 * The recursion is the point: a hardcoded file list stops covering the core the
 * moment `core/rules/` or `core/projection/` gains its first file.
 *
 * @param {string} [root] absolute path to the core directory
 * @returns {Array<{ path: string, source: string }>} repo-relative paths, POSIX separators
 */
export function readCoreSources(root = join(ROOT, ...CORE_DIRECTORY.split('/'))) {
	/** @type {Array<{ path: string, source: string }>} */
	const sources = [];

	/** @type {Set<string>} */
	const visited = new Set();

	/** @param {string} directory */
	function walk(directory) {
		// realpathSync so a symlinked directory cannot be walked twice, and so a
		// cycle terminates instead of recursing until the stack gives out.
		const real = realpathSync(directory);
		if (visited.has(real)) return;
		visited.add(real);

		const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0
		);
		for (const entry of entries) {
			const full = join(directory, entry.name);
			// A symlink reports neither isDirectory() nor isFile(), so resolving it
			// is what keeps a symlinked core file from being silently unchecked.
			const stats = entry.isSymbolicLink() ? statSync(full) : entry;
			if (stats.isDirectory()) {
				walk(full);
			} else if (stats.isFile() && entry.name.endsWith('.ts')) {
				sources.push({
					path: relative(root, full).split(sep).join('/'),
					source: readFileSync(full, 'utf8')
				});
			}
		}
	}

	walk(root);
	return sources;
}

/**
 * @typedef {object} Violation
 * @property {string} file    path as supplied by the caller
 * @property {number} line    1-based
 * @property {string} rule    short machine-readable rule name
 * @property {string} detail  what was found, in words
 */

/**
 * Check every supplied source against the core's boundary rules.
 *
 * Returns every violation rather than the first, so one run tells you
 * everything that has to change — the same contract as the pin gate.
 *
 * @param {ReadonlyArray<{ path: string, source: string }>} sources
 * @returns {{ ok: boolean, violations: Violation[] }}
 */
export function checkCorePurity(sources) {
	/** @type {Violation[]} */
	const violations = [];

	for (const { path, source } of sources) {
		const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

		/**
		 * @param {ts.Node} node
		 * @param {string} rule
		 * @param {string} detail
		 */
		const report = (node, rule, detail) => {
			const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
			violations.push({ file: path, line: line + 1, rule, detail });
		};

		/**
		 * @param {ts.Node} node
		 * @param {ts.Expression | undefined} specifier
		 */
		const checkSpecifier = (node, specifier) => {
			if (specifier === undefined || !ts.isStringLiteral(specifier)) {
				report(node, 'dynamic-specifier', 'import specifier is not a literal string');
				return;
			}
			const text = specifier.text;
			if (!RELATIVE_SPECIFIER.test(text)) {
				const kind = text.startsWith('$')
					? 'an alias'
					: text.startsWith('node:')
						? 'a Node built-in'
						: 'a bare specifier';
				report(
					node,
					'non-relative-import',
					`imports ${JSON.stringify(text)} — ${kind}; the core may import nothing outside the TypeScript standard library, and only by relative path`
				);
				return;
			}
			if (!text.endsWith('.ts')) {
				report(
					node,
					'missing-ts-extension',
					`imports ${JSON.stringify(text)} without an explicit .ts extension — Deno will not resolve it`
				);
			}
		};

		/**
		 * Report a forbidden `object.property` / `object['property']` pair.
		 * @param {ts.Node} node
		 * @param {string} object
		 * @param {string} property
		 */
		const checkMember = (node, object, property) => {
			for (const [forbiddenObject, forbiddenProperty] of FORBIDDEN_MEMBERS) {
				if (object === forbiddenObject && property === forbiddenProperty) {
					report(
						node,
						'forbidden-reference',
						`references ${object}.${property} — the core takes no clock, no randomness and no ambient state (AD-1, AD-3)`
					);
				}
			}
		};

		/** @param {ts.Node} node */
		const visit = (node) => {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				// A bare `export { x }` has no specifier and is not an import.
				if (node.moduleSpecifier !== undefined) checkSpecifier(node, node.moduleSpecifier);
			} else if (ts.isImportEqualsDeclaration(node)) {
				// `import x = require('y')` and `import x = Foo.Bar`. The first is a
				// CommonJS import Deno will not resolve; the second is a namespace
				// alias that only exists alongside one. Neither belongs in the core.
				report(
					node,
					'import-equals',
					'uses `import x = ...`; the core takes ES module syntax only, or Deno will not load it'
				);
			} else if (ts.isImportTypeNode(node)) {
				const argument = node.argument;
				checkSpecifier(
					node,
					ts.isLiteralTypeNode(argument) ? argument.literal : /** @type {any} */ (undefined)
				);
			} else if (ts.isCallExpression(node)) {
				if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
					report(
						node,
						'dynamic-import',
						'uses dynamic import(); the core is statically resolvable or it is not portable'
					);
				}
			} else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
				checkMember(node, node.expression.text, node.name.text);
			} else if (
				ts.isElementAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				ts.isStringLiteralLike(node.argumentExpression)
			) {
				// `Math['random']()` is the same call as `Math.random()`, written to
				// slip a check that only looks at dot access.
				checkMember(node, node.expression.text, node.argumentExpression.text);
			} else if (ts.isMetaProperty(node)) {
				// MetaProperty covers both `import.meta` and `new.target`; name the
				// one actually present rather than always reporting import.meta.
				const construct =
					node.keywordToken === ts.SyntaxKind.ImportKeyword ? 'import.meta' : 'new.target';
				report(
					node,
					'forbidden-reference',
					`references ${construct} — not portable across runtimes`
				);
			} else if (ts.isIdentifier(node) && FORBIDDEN_GLOBAL_SET.has(node.text) && isReference(node)) {
				report(
					node,
					'forbidden-reference',
					`references ${node.text} — the core takes no clock, no randomness and no ambient state (AD-1, AD-3)`
				);
			}

			ts.forEachChild(node, visit);
		};

		ts.forEachChild(file, visit);
	}

	violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
	return { ok: violations.length === 0, violations };
}

/**
 * Is this identifier a value reference, rather than a property name, a member
 * name, or the name being declared? `row.process` and `{ process: 1 }` are not
 * references to the ambient `process`.
 *
 * @param {ts.Identifier} node
 * @returns {boolean}
 */
function isReference(node) {
	const parent = node.parent;
	if (parent === undefined) return true;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if (ts.isQualifiedName(parent) && parent.right === node) return false;
	if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
	if (ts.isPropertySignature(parent) && parent.name === node) return false;
	if (ts.isMethodSignature(parent) && parent.name === node) return false;
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
	// A member *named* like a global is not that global. `class C { process() {} }`
	// and `{ get crypto() {} }` declare members on an object the core owns.
	if (
		(ts.isMethodDeclaration(parent) ||
			ts.isGetAccessorDeclaration(parent) ||
			ts.isSetAccessorDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isEnumMember(parent)) &&
		parent.name === node
	) {
		return false;
	}
	// A declaration introducing the name shadows nothing that matters here, but
	// declaring `const process = ...` inside the core is still worth refusing,
	// so declarations deliberately count as references.
	return true;
}

/**
 * Render violations for a terminal, one per line, path first so the editor can
 * link them.
 *
 * @param {ReadonlyArray<Violation>} violations
 * @returns {string}
 */
export function formatViolations(violations) {
	return violations
		.map((v) => `${CORE_DIRECTORY}/${v.file}:${v.line} — [${v.rule}] ${v.detail}`)
		.join('\n');
}

// CLI entry point. The comparison is case-insensitive because on Windows the
// drive letter's case differs between `node scripts/x.js` and an npm-script
// invocation, and a case-sensitive check silently skips the gate entirely —
// which is the failure mode this whole block is most likely to suffer, so
// tests/purity.test.ts spawns this file for real rather than re-implementing it.
//
// An optional path argument overrides the directory checked. The build passes
// none and gets the real core; the test passes a fixture, which is what makes
// the failing path reachable without writing a violation into src/.
const invoked = process.argv[1];
if (
	invoked !== undefined &&
	import.meta.url.toLowerCase() === pathToFileURL(invoked).href.toLowerCase()
) {
	const override = process.argv[2];
	const result = checkCorePurity(
		override === undefined ? readCoreSources() : readCoreSources(override)
	);
	if (!result.ok) {
		process.stderr.write(
			`The pure core boundary is broken (AD-1, AD-2):\n${formatViolations(result.violations)}\n`
		);
		// Set the code and let the process exit on its own, for the reason
		// check-pins.js documents: stderr is asynchronous when it is a pipe, and
		// process.exit() would race away the output the gate exists to print.
		process.exitCode = 1;
	}
}
