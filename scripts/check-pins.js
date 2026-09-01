/**
 * Version-drift gate.
 *
 * The stack is pinned exactly, never as a range, and the build fails on drift.
 * This runs as the first half of `npm run build`, before Vite compiles anything,
 * so a drifted dependency can never reach a deploy.
 *
 * Inputs: package.json, .nvmrc, netlify.toml, and the tick Edge Function's
 * Deno import map (supabase/functions/tick/deno.json).
 *
 * The checking logic is exported as a pure function so the test suite can drive
 * it with synthetic inputs; the CLI entry point at the bottom reads the real
 * files and sets the exit code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repository root, resolved from this file rather than the caller's cwd. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The stack pins. Each value is an exact literal — a range here would defeat
 * the entire point of this file.
 * @type {Readonly<Record<string, string>>}
 */
export const PINNED_PACKAGES = Object.freeze({
	'@sveltejs/kit': '2.70.2',
	'@sveltejs/adapter-netlify': '6.0.4',
	// The auth clients. An unpinned auth client is the reason this gate exists:
	// a minor bump to the library that mints and refreshes sessions arrives
	// silently on the next `npm install` and lands in a deploy unreviewed.
	'@supabase/supabase-js': '2.112.3',
	'@supabase/ssr': '0.12.4'
});

/** The required Node major version. Netlify Functions' documented default. */
export const PINNED_NODE_MAJOR = '24';

/**
 * The tick Edge Function's import map (Story 3.5).
 *
 * Deno resolves these at deploy time, on a machine nobody is watching, so a
 * ranged specifier here is exactly the drift this file exists to stop — and it
 * is worse than a ranged npm dependency, because there is no lockfile beside
 * it and no `npm install` step where anybody would notice.
 */
export const TICK_DENO_JSON = 'supabase/functions/tick/deno.json';

/**
 * The tick's committed Deno lockfile. The import map pins the DIRECT versions;
 * this pins the transitive ones, and the two must agree.
 */
export const TICK_DENO_LOCK = 'supabase/functions/tick/deno.lock';

/**
 * Import-map values that must carry an exact version, and how to find it.
 *
 * Each entry is a specifier form this repository actually uses, with a regex
 * whose one capture is the version. A value matching none of them is reported
 * rather than skipped: an unrecognised specifier form is a finding, because
 * this gate cannot vouch for a shape it does not understand.
 */
const DENO_SPECIFIER_FORMS = Object.freeze([
	// https://deno.land/x/postgres@v0.19.5/mod.ts
	{ what: 'a deno.land/x module', pattern: /^https:\/\/deno\.land\/x\/[^@/]+@v?([^/]+)\// },
	// jsr:@std/encoding@1.0.10  (unused today; here so adding one is checked)
	{ what: 'a JSR package', pattern: /^jsr:@?[^@]+@([^/]+)/ },
	// npm:@supabase/supabase-js@2.112.3
	{ what: 'an npm package', pattern: /^npm:@?[^@]+@([^/]+)/ }
]);

/** An exact semver literal: no prefix, no range, no wildcard. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Every package.json field that can carry a version specifier. Reading only
 * `dependencies` and `devDependencies` leaves three doors open: a range under
 * `optionalDependencies` or `overrides` reaches the install just as surely, and
 * an override can silently replace a pinned transitive dep.
 */
const VERSIONED_FIELDS = Object.freeze([
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
	'overrides'
]);

/** The Netlify context permitted to point at the production Supabase project. */
const PRODUCTION_CONTEXT = 'production';

/** The Supabase environments a Netlify context may name. */
const SUPABASE_ENVIRONMENTS = Object.freeze(['prod', 'dev']);

/**
 * A plain literal version, in any of the shapes a Node version is written in:
 * "24", "24.x", "24.11.0", "v24.11.0". Deliberately NOT a range — ">=24",
 * "^24", "18 || 24" and ">=24 <27" are all rejected, because a gate that reads
 * "18 || 24" as major 18 (or as major 24) is worse than no gate at all.
 *
 * The captured major is later normalised through `Number()` so a zero-padded
 * literal like "024" still compares equal to the pinned "24" — a leading zero
 * is not a drift.
 */
const PLAIN_VERSION = /^v?(\d+)(?:\.(?:\d+|[xX*]))*$/;

/**
 * Minimal reader for the flat `key = "value"` TOML this project uses.
 * It is not a general TOML parser and is not trying to be — it exists so the
 * drift gate can read netlify.toml without taking on a dependency.
 *
 * @param {string} source
 * @returns {{ sections: string[], values: Map<string, string> }}
 *   `values` is keyed `section.key`; top-level keys are keyed bare.
 */
export function readSimpleToml(source) {
	/** @type {string[]} */
	const sections = [];
	/** @type {Map<string, string>} */
	const values = new Map();
	let current = '';

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) continue;

		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header) {
			current = header[1] ?? '';
			sections.push(current);
			continue;
		}

		// `(.*)$` (not `(.+)$`) so a bare `KEY =` with nothing after it still
		// matches and surfaces as an empty string, rather than being silently
		// dropped as an unparsed line — a blank pin value is a finding, not
		// nothing to report.
		const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
		if (!pair) continue;
		const key = pair[1] ?? '';
		let value = stripInlineComment((pair[2] ?? '').trim()).trim();
		const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
		if (quoted) value = quoted[1] ?? '';
		values.set(current === '' ? key : `${current}.${key}`, value);
	}

	return { sections, values };
}

/**
 * Drop a trailing `# comment` that sits outside quotes.
 *
 * Without this, `NODE_VERSION = "24" # pinned` reads as the literal
 * `"24" # pinned`, which the quote-stripping regex then declines to unquote
 * because it is anchored to the whole string — so a perfectly ordinary comment
 * would break the Node check and, worse, could make a drifted value look
 * unparseable rather than wrong.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripInlineComment(value) {
	let quote = '';
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote !== '') {
			if (character === quote) quote = '';
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === '#') return value.slice(0, index);
	}
	return value;
}

/**
 * @typedef {object} PinInputs
 * @property {string} packageJson   raw contents of package.json
 * @property {string} nvmrc         raw contents of .nvmrc
 * @property {string} netlifyToml   raw contents of netlify.toml
 * @property {string} tickDenoJson  raw contents of supabase/functions/tick/deno.json
 * @property {string} tickDenoLock  raw contents of supabase/functions/tick/deno.lock
 */

/**
 * @typedef {object} PinResult
 * @property {boolean} ok
 * @property {string[]} errors  one human-readable line per drift found
 */

/**
 * Check every pin. Returns all failures rather than stopping at the first, so a
 * single run tells you everything that drifted.
 *
 * @param {PinInputs} inputs
 * @returns {PinResult}
 */
export function checkPins(inputs) {
	/** @type {string[]} */
	const errors = [];

	// A malformed package.json is collected like any other failure rather than
	// returned early. This function's contract is that one run reports every
	// drift; bailing out here would hide a Node or Netlify drift behind a
	// misplaced comma and send you round the loop twice.
	/** @type {Record<string, unknown> | undefined} */
	let pkg;
	try {
		const parsed = JSON.parse(inputs.packageJson);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			errors.push(
				`package.json: top level is ${describe(parsed)} — it must be a JSON object.`
			);
		} else {
			pkg = /** @type {Record<string, unknown>} */ (parsed);
		}
	} catch (cause) {
		errors.push(
			`package.json: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`
		);
	}

	if (pkg !== undefined) {
		const declared = collectDeclaredVersions(pkg, errors);

		// 1. Every declared version is an exact literal, never a range —
		//    across every field that can carry one.
		for (const { version, where } of declared) {
			if (!EXACT_SEMVER.test(version)) {
				errors.push(
					`package.json: ${where} is "${version}" — an exact version is required, ` +
						`not a range. Write the literal version with no prefix.`
				);
			}
		}

		// 2. The named stack pins are at their exact literal versions.
		/** @type {Map<string, string>} */
		const byName = new Map();
		for (const { field, name, version } of declared) {
			if (field === 'dependencies' || field === 'devDependencies') byName.set(name, version);
		}
		for (const [name, expected] of Object.entries(PINNED_PACKAGES)) {
			const found = byName.get(name);
			if (found === undefined) {
				errors.push(`package.json: ${name} is missing — pinned at ${expected}, found nothing.`);
				continue;
			}
			if (found !== expected) {
				errors.push(`package.json: ${name} pinned at ${expected}, found ${found}.`);
			}
		}

		// 3. engines.node names the required major.
		const engines = pkg['engines'];
		const enginesNode =
			typeof engines === 'object' && engines !== null
				? /** @type {Record<string, unknown>} */ (engines)['node']
				: undefined;
		if (typeof enginesNode !== 'string') {
			errors.push(
				`package.json: engines.node is missing — Node major ${PINNED_NODE_MAJOR} is required.`
			);
		} else if (majorOf(enginesNode) !== PINNED_NODE_MAJOR) {
			errors.push(
				`package.json: engines.node is "${enginesNode}" — Node major ${PINNED_NODE_MAJOR} is required.`
			);
		}
	}

	// 4. .nvmrc names the required major.
	const nvmrc = inputs.nvmrc.trim();
	if (nvmrc === '') {
		errors.push(`.nvmrc: empty — Node major ${PINNED_NODE_MAJOR} is required.`);
	} else if (majorOf(nvmrc) !== PINNED_NODE_MAJOR) {
		errors.push(`.nvmrc: is "${nvmrc}" — Node major ${PINNED_NODE_MAJOR} is required.`);
	}

	// 5. netlify.toml pins the same Node major and declares all three contexts.
	const toml = readSimpleToml(inputs.netlifyToml);
	const netlifyNode = toml.values.get('build.environment.NODE_VERSION');
	if (netlifyNode === undefined) {
		errors.push(
			`netlify.toml: build.environment.NODE_VERSION is missing — ` +
				`Node major ${PINNED_NODE_MAJOR} is required.`
		);
	} else if (majorOf(netlifyNode) !== PINNED_NODE_MAJOR) {
		errors.push(
			`netlify.toml: NODE_VERSION is "${netlifyNode}" — Node major ${PINNED_NODE_MAJOR} is required.`
		);
	}

	if (toml.values.get('build.publish') === undefined) {
		errors.push('netlify.toml: [build] publish is missing — adapter-netlify needs it.');
	}

	// The three contexts that must exist, each pointing where it is supposed to.
	const contextEnvironment = /** @type {Readonly<Record<string, string>>} */ ({
		'context.production.environment': 'prod',
		'context.deploy-preview.environment': 'dev',
		'context.branch-deploy.environment': 'dev'
	});
	for (const [section, expected] of Object.entries(contextEnvironment)) {
		const found = toml.values.get(`${section}.SUPABASE_ENVIRONMENT`);
		if (found === undefined) {
			errors.push(
				`netlify.toml: [${section}] SUPABASE_ENVIRONMENT is missing — expected "${expected}".`
			);
		} else if (found !== expected) {
			errors.push(
				`netlify.toml: [${section}] SUPABASE_ENVIRONMENT is "${found}", expected "${expected}".`
			);
		}
	}

	// And no OTHER context may point at prod. Checking only the three named
	// sections above leaves the actual hazard open: adding
	// [context.some-branch.environment] with SUPABASE_ENVIRONMENT = "prod" gives
	// a branch deploy write access to the production project, which is precisely
	// the project that is never touched by hand.
	for (const [key, value] of toml.values) {
		const match = /^context\.(.+)\.environment\.SUPABASE_ENVIRONMENT$/.exec(key);
		if (match === null) continue;
		const context = match[1] ?? '';
		if (!SUPABASE_ENVIRONMENTS.includes(value)) {
			errors.push(
				`netlify.toml: [context.${context}.environment] SUPABASE_ENVIRONMENT is "${value}" — ` +
					`expected one of ${SUPABASE_ENVIRONMENTS.map((name) => `"${name}"`).join(', ')}.`
			);
			continue;
		}
		if (context !== PRODUCTION_CONTEXT && value === 'prod') {
			errors.push(
				`netlify.toml: [context.${context}.environment] SUPABASE_ENVIRONMENT is "prod" — ` +
					`only the "${PRODUCTION_CONTEXT}" context may point at the production Supabase ` +
					`project. Every other context takes "dev".`
			);
		}
	}

	// 6. The tick Edge Function's Deno import map pins exactly, like everything
	//    else. Checked here rather than in a second script so one command
	//    reports every drift in the stack, whichever runtime it belongs to.
	checkTickImportMap(inputs.tickDenoJson, errors);
	checkTickLockfile(inputs.tickDenoJson, inputs.tickDenoLock, errors);

	return { ok: errors.length === 0, errors };
}

/**
 * The tick's lockfile must agree with its import map.
 *
 * `checkTickImportMap` below vouches for `deno.json`, which pins DIRECT
 * versions only. `deno.lock` is committed beside it and is what actually
 * decides what Deno resolves — every transitive npm dependency and every
 * remote integrity hash. A lockfile disagreeing with the import map would pass
 * every other gate in this file while the deployed function loaded something
 * nobody reviewed, which is precisely the drift this module exists to stop.
 *
 * This checks AGREEMENT, not the transitive tree: each `npm:` specifier the
 * import map names must appear in the lock's `specifiers` and resolve to the
 * same version. Remote `https://` modules carry no specifier entry and are
 * vouched for by `deno.json` plus the lock's own integrity hashes.
 *
 * @param {string | undefined} jsonSource raw contents of deno.json
 * @param {string | undefined} lockSource raw contents of deno.lock
 * @param {string[]} errors               appended to in place
 */
function checkTickLockfile(jsonSource, lockSource, errors) {
	if (typeof lockSource !== 'string' || lockSource.trim() === '') {
		errors.push(
			`${TICK_DENO_LOCK}: missing or empty. It is committed on purpose — without it the ` +
				`transitive versions Deno resolves are whatever it happened to fetch last.`
		);
		return;
	}

	let lock;
	let config;
	try {
		lock = JSON.parse(lockSource);
		config = JSON.parse(/** @type {string} */ (jsonSource));
	} catch (cause) {
		errors.push(
			`${TICK_DENO_LOCK}: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`
		);
		return;
	}

	const specifiers = lock['specifiers'];
	if (typeof specifiers !== 'object' || specifiers === null || Array.isArray(specifiers)) {
		errors.push(
			`${TICK_DENO_LOCK}: "specifiers" is ${describe(specifiers)} — it must be an object.`
		);
		return;
	}

	const imports = config['imports'];
	if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) return;

	for (const [specifier, value] of Object.entries(imports)) {
		if (typeof value !== 'string' || !value.startsWith('npm:')) continue;

		const entry = specifiers[value];
		if (entry === undefined) {
			errors.push(
				`${TICK_DENO_LOCK}: imports["${specifier}"] is "${value}" in ${TICK_DENO_JSON}, but the ` +
					`lockfile names no specifier for it. Refresh the lock and commit the result.`
			);
			continue;
		}

		const version = /^npm:@?[^@]+@([^/]+)/.exec(value)?.[1] ?? '';
		if (entry !== version) {
			errors.push(
				`${TICK_DENO_LOCK}: "${value}" resolves to ${JSON.stringify(entry)}, but ${TICK_DENO_JSON} ` +
					`asks for ${version}. The lockfile is what Deno loads, so a disagreement means the ` +
					`deployed function does not run the reviewed version.`
			);
		}
	}
}

/**
 * Every version in the tick's Deno import map is an exact literal.
 *
 * Two assertions, and the second is the one that matters most:
 *
 *   1. Every mapped specifier carries a version, in a form this gate
 *      recognises, and that version is an exact semver literal.
 *   2. `@supabase/supabase-js` is mapped to the SAME version package.json pins.
 *      The Node and Deno halves of this application share `src/lib/core` and
 *      `src/lib/shell` verbatim (AD-2); letting them disagree about the client
 *      those files' types come from would reintroduce the drift the shared
 *      source exists to eliminate.
 *
 * @param {string | undefined} source  raw contents of the import map
 * @param {string[]} errors            appended to in place
 */
function checkTickImportMap(source, errors) {
	if (typeof source !== 'string') {
		errors.push(`${TICK_DENO_JSON}: not supplied to the gate — it must be read and checked.`);
		return;
	}

	/** @type {Record<string, unknown>} */
	let config;
	try {
		const parsed = JSON.parse(source);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			errors.push(`${TICK_DENO_JSON}: top level is ${describe(parsed)} — it must be a JSON object.`);
			return;
		}
		config = /** @type {Record<string, unknown>} */ (parsed);
	} catch (cause) {
		errors.push(
			`${TICK_DENO_JSON}: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`
		);
		return;
	}

	const imports = config['imports'];
	if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) {
		errors.push(`${TICK_DENO_JSON}: "imports" is ${describe(imports)} — it must be an object.`);
		return;
	}

	for (const [specifier, value] of Object.entries(
		/** @type {Record<string, unknown>} */ (imports)
	)) {
		if (typeof value !== 'string') {
			errors.push(
				`${TICK_DENO_JSON}: imports["${specifier}"] is ${describe(value)} — it must be a string.`
			);
			continue;
		}

		const form = DENO_SPECIFIER_FORMS.find((candidate) => candidate.pattern.test(value));
		if (form === undefined) {
			errors.push(
				`${TICK_DENO_JSON}: imports["${specifier}"] is "${value}" — this gate does not ` +
					`recognise that specifier form, so it cannot vouch that it is pinned. Use a ` +
					`deno.land/x, jsr: or npm: specifier carrying an exact version.`
			);
			continue;
		}

		const version = form.pattern.exec(value)?.[1] ?? '';
		if (!EXACT_SEMVER.test(version)) {
			errors.push(
				`${TICK_DENO_JSON}: imports["${specifier}"] resolves ${form.what} at "${version}" — ` +
					`an exact version is required, not a range. Write the literal version with no prefix.`
			);
			continue;
		}

		// The one cross-runtime agreement: a package pinned for Node is pinned
		// to the same version for Deno.
		const pinned = PINNED_PACKAGES[specifier];
		if (pinned !== undefined && version !== pinned) {
			errors.push(
				`${TICK_DENO_JSON}: imports["${specifier}"] is at ${version}, but package.json pins ` +
					`${specifier} at ${pinned}. The Node and Deno runtimes load the same core and shell ` +
					`sources and must not disagree about the client those sources type against (AD-2).`
			);
		}
	}
}

/**
 * Flatten every version specifier in package.json, from every field that can
 * carry one. `overrides` nests arbitrarily, so it is walked recursively.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string[]} errors  appended to in place for malformed shapes
 * @returns {Array<{ field: string, name: string, version: string, where: string }>}
 */
function collectDeclaredVersions(pkg, errors) {
	/** @type {Array<{ field: string, name: string, version: string, where: string }>} */
	const declared = [];

	for (const field of VERSIONED_FIELDS) {
		const block = pkg[field];
		if (block === undefined) continue;
		if (typeof block !== 'object' || block === null || Array.isArray(block)) {
			errors.push(`package.json: "${field}" is ${describe(block)} — it must be an object.`);
			continue;
		}
		collectInto(declared, field, field, /** @type {Record<string, unknown>} */ (block), errors);
	}

	return declared;
}

/**
 * @param {Array<{ field: string, name: string, version: string, where: string }>} declared
 * @param {string} field  the top-level package.json field this came from
 * @param {string} path   the dotted path so far, for the error message
 * @param {Record<string, unknown>} block
 * @param {string[]} errors
 */
function collectInto(declared, field, path, block, errors) {
	for (const [name, value] of Object.entries(block)) {
		const where = `${path}.${name}`;
		if (typeof value === 'string') {
			// npm also accepts "$name" here, meaning "whatever the dependency
			// resolves to". That is a reference rather than a pin, and this gate
			// wants a literal, so it is rejected like any other non-literal.
			declared.push({ field, name, version: value, where });
			continue;
		}
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			collectInto(declared, field, where, /** @type {Record<string, unknown>} */ (value), errors);
			continue;
		}
		errors.push(`package.json: ${where} is ${describe(value)} — it must be a string version.`);
	}
}

/**
 * A short human name for a value's shape, for error messages.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	return `a ${typeof value}`;
}

/**
 * The major version of a PLAIN LITERAL version string: "24", "24.x", "24.11.0",
 * "v24.11.0". Returns undefined for anything else.
 *
 * It deliberately does not scan for the first digit run anywhere in the string.
 * That reading makes "18 || 24" report major 18 and lets ">=24", "^24" and
 * ">=24 <27" all sail through as if they were pins — a gate that accepts a
 * range is not a gate.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
export function majorOf(value) {
	const match = PLAIN_VERSION.exec(value.trim());
	if (match?.[1] === undefined) return undefined;
	// Normalise a zero-padded major ("024") to its numeric form ("24") so it
	// compares equal to the pin. A malformed capture (e.g. all zeros) still
	// round-trips through Number(), so this never masks a real mismatch.
	return String(Number(match[1]));
}

/** Read the four real files from the repository root. @returns {PinInputs} */
export function readRepositoryInputs() {
	return {
		packageJson: readFileSync(join(ROOT, 'package.json'), 'utf8'),
		nvmrc: readFileSync(join(ROOT, '.nvmrc'), 'utf8'),
		netlifyToml: readFileSync(join(ROOT, 'netlify.toml'), 'utf8'),
		tickDenoJson: readFileSync(join(ROOT, ...TICK_DENO_JSON.split('/')), 'utf8'),
		tickDenoLock: readFileSync(join(ROOT, ...TICK_DENO_LOCK.split('/')), 'utf8')
	};
}

// --- CLI entry point -------------------------------------------------------
// Runs when invoked directly (`node scripts/check-pins.js`), not when imported.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
	const result = checkPins(readRepositoryInputs());
	if (result.ok) {
		process.stdout.write('check-pins: stack matches its pins.\n');
	} else {
		process.stderr.write('check-pins: the stack has drifted from its pins.\n\n');
		for (const error of result.errors) process.stderr.write(`  ${error}\n`);
		process.stderr.write('\nPins are exact by design. Renegotiate the pin, do not widen it.\n');
		// Set the code and let the process exit on its own. process.exit() would
		// tear down immediately, and stderr is asynchronous whenever it is a pipe
		// rather than a TTY — which is exactly the CI and Netlify build case. The
		// one thing this script exists to do is print why the build failed, so it
		// must not race its own output away.
		process.exitCode = 1;
	}
}
