import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	PINNED_NODE_MAJOR,
	PINNED_PACKAGES,
	TICK_DENO_JSON,
	checkPins,
	majorOf,
	readRepositoryInputs,
	readSimpleToml
} from '../scripts/check-pins.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every package.json field that can carry a version specifier. */
const VERSIONED_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
	'overrides'
] as const;

/** The repository as it actually stands. */
const actual = readRepositoryInputs();

/**
 * Build a drifted copy of the real inputs. Each drift test changes exactly one
 * thing, so a failure names the drift it was testing and nothing else.
 */
function withDrift(overrides: Partial<typeof actual>) {
	return { ...actual, ...overrides };
}

/** Replace a version literal inside the real package.json text. */
function repin(name: string, version: string): string {
	const pattern = new RegExp(`("${name.replace(/[/@]/g, '\\$&')}"\\s*:\\s*)"[^"]*"`);
	expect(actual.packageJson, `${name} must appear in package.json`).toMatch(pattern);
	return actual.packageJson.replace(pattern, `$1"${version}"`);
}

describe('the repository as committed', () => {
	it('passes the drift gate', () => {
		const result = checkPins(actual);
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('pins SvelteKit, the Netlify adapter and the auth clients to their exact architected versions', () => {
		expect(PINNED_PACKAGES).toEqual({
			'@sveltejs/kit': '2.70.2',
			'@sveltejs/adapter-netlify': '6.0.4',
			'@supabase/supabase-js': '2.112.3',
			'@supabase/ssr': '0.12.4'
		});
		const pkg = JSON.parse(actual.packageJson) as {
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		const declared = { ...pkg.dependencies, ...pkg.devDependencies };
		for (const [name, version] of Object.entries(PINNED_PACKAGES)) {
			expect(declared[name]).toBe(version);
		}
	});

	it('declares every version, in every field that can carry one, as an exact literal', () => {
		// Reading only dependencies and devDependencies is the same blind spot the
		// gate itself had: a range under optionalDependencies or overrides reaches
		// the install just as surely, and this test could not have observed it.
		const pkg = JSON.parse(actual.packageJson) as Record<string, unknown>;
		const declared: Array<[string, string]> = [];
		for (const field of VERSIONED_FIELDS) {
			const block = pkg[field];
			if (block === undefined) continue;
			for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
				expect(typeof version, `${field}.${name} must be a string version`).toBe('string');
				declared.push([`${field}.${name}`, version as string]);
			}
		}
		expect(declared.length).toBeGreaterThan(0);
		for (const [where, version] of declared) {
			expect(version, `${where} must be an exact version`).toMatch(/^\d+\.\d+\.\d+/);
			expect(version, `${where} must carry no range prefix`).not.toMatch(/[\^~><*|x ]/);
		}
	});

	it('runs the drift gate before Vite compiles, unskippably, from the build script', () => {
		const pkg = JSON.parse(actual.packageJson) as { scripts?: Record<string, string> };
		const build = pkg.scripts?.['build'] ?? '';
		expect(build).toContain('scripts/check-pins.js');
		const gateAt = build.indexOf('scripts/check-pins.js');
		const viteAt = build.indexOf('vite build');
		expect(viteAt, 'the build script must run vite').toBeGreaterThan(-1);
		expect(gateAt, 'the gate must run before vite build').toBeLessThan(viteAt);
		expect(build.slice(gateAt, viteAt), 'the gate must be sequenced with &&').toContain('&&');
	});
});

describe('drift detection', () => {
	it('fails and names the package when a dependency drifts off its pin', () => {
		const result = checkPins(withDrift({ packageJson: repin('@sveltejs/kit', '2.71.0') }));
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('@sveltejs/kit');
		expect(message).toContain('2.70.2');
		expect(message).toContain('2.71.0');
	});

	it('fails and names the package when the adapter drifts off its pin', () => {
		const result = checkPins(
			withDrift({ packageJson: repin('@sveltejs/adapter-netlify', '7.0.0') })
		);
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('@sveltejs/adapter-netlify');
		expect(message).toContain('6.0.4');
		expect(message).toContain('7.0.0');
	});

	// The auth clients live under `dependencies`, not `devDependencies`. The gate
	// reads both, but nothing proved it until a pin actually sat in the other
	// block — so these two cover the field as much as the packages.
	it.each([
		['@supabase/supabase-js', '2.112.3', '2.113.0'],
		['@supabase/ssr', '0.12.4', '0.13.0']
	])('fails and names %s when the runtime dependency drifts off its pin', (
		name: string,
		pinned: string,
		drifted: string
	) => {
		const result = checkPins(withDrift({ packageJson: repin(name, drifted) }));
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain(name);
		expect(message).toContain(pinned);
		expect(message).toContain(drifted);
	});

	it.each(['@supabase/supabase-js', '@supabase/ssr'])(
		'fails when %s is written as a caret range',
		(name: string) => {
			const pinned = PINNED_PACKAGES[name as keyof typeof PINNED_PACKAGES];
			const result = checkPins(withDrift({ packageJson: repin(name, `^${pinned}`) }));
			expect(result.ok).toBe(false);
			expect(result.errors.join('\n')).toContain('an exact version is required');
		}
	);

	it('fails when a pinned runtime dependency is removed entirely', () => {
		const stripped = JSON.parse(actual.packageJson) as {
			dependencies?: Record<string, string>;
		};
		delete stripped.dependencies?.['@supabase/ssr'];
		const result = checkPins(withDrift({ packageJson: JSON.stringify(stripped) }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('@supabase/ssr');
		expect(result.errors.join('\n')).toContain('missing');
	});

	it('fails and states that an exact version is required when a range appears', () => {
		const result = checkPins(withDrift({ packageJson: repin('@sveltejs/kit', '^2.70.2') }));
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('@sveltejs/kit');
		expect(message).toContain('^2.70.2');
		expect(message).toContain('an exact version is required');
	});

	it.each(['~2.70.2', '>=2.70.2', '2.x', 'latest', '*'])(
		'rejects the range "%s"',
		(range: string) => {
			const result = checkPins(withDrift({ packageJson: repin('@sveltejs/kit', range) }));
			expect(result.ok).toBe(false);
			expect(result.errors.join('\n')).toContain('an exact version is required');
		}
	);

	// The same range table, but placed under each of the fields the gate used to
	// ignore. `optionalDependencies: { 'left-pad': '*' }` returned ok = true.
	describe.each(['peerDependencies', 'optionalDependencies', 'overrides'] as const)(
		'under %s',
		(field: string) => {
			function withField(name: string, version: string): string {
				const pkg = JSON.parse(actual.packageJson) as Record<string, unknown>;
				pkg[field] = { ...(pkg[field] as Record<string, string> | undefined), [name]: version };
				return JSON.stringify(pkg, null, 2);
			}

			it.each(['^1.0.0', '~1.0.0', '>=1.0.0', '1.x', 'latest', '*'])(
				'rejects the range "%s"',
				(range: string) => {
					const result = checkPins(withDrift({ packageJson: withField('left-pad', range) }));
					expect(result.ok, `${field}.left-pad = "${range}" was accepted`).toBe(false);
					const message = result.errors.join('\n');
					expect(message).toContain('left-pad');
					expect(message).toContain(field);
					expect(message).toContain('an exact version is required');
				}
			);

			it('accepts an exact literal', () => {
				const result = checkPins(withDrift({ packageJson: withField('left-pad', '1.3.0') }));
				expect(result.errors).toEqual([]);
			});
		}
	);

	it('walks nested overrides rather than stopping at the first level', () => {
		const pkg = JSON.parse(actual.packageJson) as Record<string, unknown>;
		pkg['overrides'] = { '@sveltejs/kit': { 'left-pad': '^1.0.0' } };
		const result = checkPins(withDrift({ packageJson: JSON.stringify(pkg, null, 2) }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('overrides.@sveltejs/kit.left-pad');
	});

	it('fails and names the package when a pinned dependency is removed entirely', () => {
		const stripped = JSON.parse(actual.packageJson) as {
			devDependencies?: Record<string, string>;
		};
		delete stripped.devDependencies?.['@sveltejs/adapter-netlify'];
		const result = checkPins(withDrift({ packageJson: JSON.stringify(stripped) }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('@sveltejs/adapter-netlify');
		expect(result.errors.join('\n')).toContain('missing');
	});
});

describe('the Node major', () => {
	it.each(['22', '26'])('fails and names major 24 when .nvmrc says %s', (major: string) => {
		const result = checkPins(withDrift({ nvmrc: `${major}\n` }));
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('.nvmrc');
		expect(message).toContain(PINNED_NODE_MAJOR);
	});

	it.each(['22.x', '26.x'])(
		'fails and names major 24 when engines.node says %s',
		(engines: string) => {
			const result = checkPins(
				withDrift({ packageJson: actual.packageJson.replace('"node": "24.x"', `"node": "${engines}"`) })
			);
			expect(result.ok).toBe(false);
			const message = result.errors.join('\n');
			expect(message).toContain('engines.node');
			expect(message).toContain(PINNED_NODE_MAJOR);
		}
	);

	it('fails when netlify.toml pins a different Node major', () => {
		const result = checkPins(
			withDrift({ netlifyToml: actual.netlifyToml.replace('NODE_VERSION = "24"', 'NODE_VERSION = "22"') })
		);
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('NODE_VERSION');
		expect(message).toContain(PINNED_NODE_MAJOR);
	});

	it.each(['24', '24.x', '24.11.0', 'v24.11.0', ' 24 \n'])(
		'reads major 24 out of the plain literal "%s"',
		(value: string) => {
			expect(majorOf(value)).toBe('24');
		}
	);

	it.each(['>=24', '^24', '~24', '>=24 <27', '18 || 24', '24 - 26', '*', 'lts/*', ''])(
		'refuses to read a major out of the range "%s"',
		(value: string) => {
			// Taking the first digit run anywhere read "18 || 24" as major 18 and let
			// ">=24" pass as if it were a pin. A gate that accepts a range is not a
			// gate, so anything that is not a plain literal has no major at all.
			expect(majorOf(value)).toBeUndefined();
		}
	);

	it.each(['>=24', '^24', '18 || 24'])(
		'fails the build when .nvmrc holds the range "%s"',
		(value: string) => {
			const result = checkPins(withDrift({ nvmrc: `${value}\n` }));
			expect(result.ok).toBe(false);
			expect(result.errors.join('\n')).toContain(PINNED_NODE_MAJOR);
		}
	);
});

describe('the branch-to-environment contract', () => {
	it('maps production to prod and every other context to dev', () => {
		const toml = readSimpleToml(actual.netlifyToml);
		expect(toml.values.get('context.production.environment.SUPABASE_ENVIRONMENT')).toBe('prod');
		expect(toml.values.get('context.deploy-preview.environment.SUPABASE_ENVIRONMENT')).toBe('dev');
		expect(toml.values.get('context.branch-deploy.environment.SUPABASE_ENVIRONMENT')).toBe('dev');
	});

	it('fails if a preview context is pointed at production', () => {
		const result = checkPins(
			withDrift({
				netlifyToml: actual.netlifyToml.replace(
					/(\[context\.deploy-preview\.environment\][\s\S]*?SUPABASE_ENVIRONMENT = )"dev"/,
					'$1"prod"'
				)
			})
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('deploy-preview');
	});

	it('fails when a context nobody listed is pointed at production', () => {
		// Checking only the three named contexts left the actual hazard open: any
		// new [context.<branch>.environment] could take SUPABASE_ENVIRONMENT =
		// "prod" and write to the project that is never touched by hand.
		const result = checkPins(
			withDrift({
				netlifyToml: `${actual.netlifyToml}\n[context.spike-branch.environment]\n  SUPABASE_ENVIRONMENT = "prod"\n`
			})
		);
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('spike-branch');
		expect(message).toContain('only the "production" context');
	});

	it('accepts a further context that points at dev', () => {
		const result = checkPins(
			withDrift({
				netlifyToml: `${actual.netlifyToml}\n[context.spike-branch.environment]\n  SUPABASE_ENVIRONMENT = "dev"\n`
			})
		);
		expect(result.errors).toEqual([]);
	});

	it('fails when a context names an environment that does not exist', () => {
		const result = checkPins(
			withDrift({
				netlifyToml: `${actual.netlifyToml}\n[context.spike-branch.environment]\n  SUPABASE_ENVIRONMENT = "staging"\n`
			})
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('staging');
	});

	it('declares the publish directory the Netlify adapter needs', () => {
		const toml = readSimpleToml(actual.netlifyToml);
		expect(toml.values.get('build.publish')).toBe('build');
		expect(toml.values.get('build.command')).toBe('npm run build');
	});
});

describe('reading netlify.toml', () => {
	it('strips a trailing inline comment from a value', () => {
		const toml = readSimpleToml('[build.environment]\n  NODE_VERSION = "24" # pinned, see AR\n');
		expect(toml.values.get('build.environment.NODE_VERSION')).toBe('24');
	});

	it('keeps a # that sits inside quotes', () => {
		const toml = readSimpleToml('[build.environment]\n  NOTE = "colour #0D1712"\n');
		expect(toml.values.get('build.environment.NOTE')).toBe('colour #0D1712');
	});

	it('still passes the whole gate when values carry inline comments', () => {
		const commented = actual.netlifyToml.replace(
			'NODE_VERSION = "24"',
			'NODE_VERSION = "24" # Netlify Functions default'
		);
		expect(checkPins(withDrift({ netlifyToml: commented })).errors).toEqual([]);
	});
});

describe('a malformed package.json', () => {
	it('reports the JSON failure AND every other drift, not just the first', () => {
		// Returning early on a parse failure contradicted this function's own
		// all-failures contract and would send you round the build loop twice.
		const result = checkPins(withDrift({ packageJson: '{ not json', nvmrc: '22\n' }));
		expect(result.ok).toBe(false);
		const message = result.errors.join('\n');
		expect(message).toContain('package.json');
		expect(message).toContain('.nvmrc');
	});

	it.each([
		['an array', '[]'],
		['a string', '"nope"'],
		['null', 'null'],
		['a number', '7']
	])('refuses a top level that is %s', (_label: string, source: string) => {
		const result = checkPins(withDrift({ packageJson: source }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('must be a JSON object');
	});

	it('refuses a versioned field that is not an object', () => {
		const pkg = JSON.parse(actual.packageJson) as Record<string, unknown>;
		pkg['optionalDependencies'] = ['left-pad'];
		const result = checkPins(withDrift({ packageJson: JSON.stringify(pkg) }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('optionalDependencies');
	});
});

describe('the CLI entry point', () => {
	it('exits non-zero and prints every drift without truncating them', () => {
		// stderr is asynchronous whenever it is a pipe rather than a TTY — which is
		// the CI and Netlify case — so process.exit() could race the messages the
		// script exists to print. Running it piped is exactly that condition.
		const drifted = JSON.parse(actual.packageJson) as Record<string, unknown>;
		(drifted['devDependencies'] as Record<string, string>)['@sveltejs/kit'] = '2.71.0';

		const script = join(ROOT, 'scripts', 'check-pins.js');
		const probe = [
			`import { checkPins } from ${JSON.stringify(pathToFileURL(script).href)};`,
			`const result = checkPins(${JSON.stringify({
				packageJson: JSON.stringify(drifted),
				nvmrc: '22\n',
				netlifyToml: actual.netlifyToml
			})});`,
			'for (const error of result.errors) process.stderr.write(`  ${error}\\n`);',
			'process.exitCode = result.ok ? 0 : 1;'
		].join('\n');

		const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
			encoding: 'utf8'
		});
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('@sveltejs/kit');
		expect(run.stderr).toContain('.nvmrc');
	});

	it('uses process.exitCode rather than process.exit so stderr can drain', () => {
		const source = readFileSync(join(ROOT, 'scripts', 'check-pins.js'), 'utf8');
		// Strip comments — the comment explaining why process.exit() is wrong is
		// not a call to process.exit().
		const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
		expect(code).toContain('process.exitCode = 1');
		expect(code).not.toMatch(/process\.exit\(/);
	});
});

describe('.nvmrc and netlify.toml agree with package.json', () => {
	it('names the same Node major in all three places', () => {
		const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8');
		const pkg = JSON.parse(actual.packageJson) as { engines?: { node?: string } };
		const toml = readSimpleToml(actual.netlifyToml);
		expect(majorOf(nvmrc)).toBe(PINNED_NODE_MAJOR);
		expect(majorOf(pkg.engines?.node ?? '')).toBe(PINNED_NODE_MAJOR);
		expect(majorOf(toml.values.get('build.environment.NODE_VERSION') ?? '')).toBe(
			PINNED_NODE_MAJOR
		);
	});
});

/**
 * The tick Edge Function's Deno import map (Story 3.5).
 *
 * Deno resolves these specifiers at deploy time on a machine nobody is
 * watching, and there is no lockfile beside them and no `npm install` step
 * where a drift would surface. So the same gate that pins package.json pins
 * them, and the two must agree about any package they both name.
 */
describe('the tick Edge Function pins its Deno dependencies exactly', () => {
	/** Rewrite one import-map value in the real deno.json text. */
	function remap(specifier: string, value: string): string {
		const config = JSON.parse(actual.tickDenoJson) as { imports: Record<string, string> };
		config.imports[specifier] = value;
		return JSON.stringify(config, null, 2);
	}

	it('names the map the gate reads', () => {
		expect(TICK_DENO_JSON).toBe('supabase/functions/tick/deno.json');
		expect(existsSync(join(ROOT, ...TICK_DENO_JSON.split('/')))).toBe(true);
	});

	it.each([
		['https://deno.land/x/postgres@v0.19/mod.ts', 'a truncated deno.land version'],
		['https://deno.land/x/postgres/mod.ts', 'no version at all'],
		['https://esm.sh/postgres@3.4.5', 'an unrecognised host']
	])('refuses %s — %s', (value: string) => {
		const result = checkPins(withDrift({ tickDenoJson: remap('postgres', value) }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain(TICK_DENO_JSON);
	});

	it.each(['npm:@supabase/supabase-js@^2.112.3', 'npm:@supabase/supabase-js@2.x'])(
		'refuses the ranged npm specifier %s',
		(value: string) => {
			const result = checkPins(withDrift({ tickDenoJson: remap('@supabase/supabase-js', value) }));
			expect(result.ok).toBe(false);
			expect(result.errors.join('\n')).toContain('exact version is required');
		}
	);

	it('refuses a Deno version that disagrees with package.json’s pin', () => {
		// The two runtimes load the same core and shell sources (AD-2). They
		// must not disagree about the client those sources type against.
		const result = checkPins(
			withDrift({ tickDenoJson: remap('@supabase/supabase-js', 'npm:@supabase/supabase-js@2.113.0') })
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain(PINNED_PACKAGES['@supabase/supabase-js']);
	});

	it('refuses a map that is missing, malformed, or has no imports block', () => {
		expect(checkPins(withDrift({ tickDenoJson: '{ not json' })).ok).toBe(false);
		expect(checkPins(withDrift({ tickDenoJson: '{}' })).ok).toBe(false);
		expect(checkPins(withDrift({ tickDenoJson: '[]' })).ok).toBe(false);
	});

	it('pins @supabase/supabase-js to the same version in both runtimes', () => {
		const config = JSON.parse(actual.tickDenoJson) as { imports: Record<string, string> };
		expect(config.imports['@supabase/supabase-js']).toBe(
			`npm:@supabase/supabase-js@${PINNED_PACKAGES['@supabase/supabase-js']}`
		);
	});
});

/**
 * The tick's committed lockfile (Story 3.5).
 *
 * `deno.json` pins the direct versions; `deno.lock` is what Deno actually
 * resolves, transitive dependencies included. A gate that read only the import
 * map would vouch for a deployment loading something else entirely.
 */
describe('the tick Deno lockfile agrees with the import map', () => {
	/** The real lock, with one specifier remapped to a different version. */
	function relock(specifier: string, version: string): string {
		const lock = JSON.parse(actual.tickDenoLock) as { specifiers: Record<string, string> };
		lock.specifiers[specifier] = version;
		return JSON.stringify(lock, null, 2);
	}

	it('passes against the committed tree', () => {
		expect(checkPins(actual).ok).toBe(true);
	});

	it('refuses a lock that resolves a specifier to a different version than the map asks for', () => {
		const drifted = relock(
			`npm:@supabase/supabase-js@${PINNED_PACKAGES['@supabase/supabase-js']}`,
			'2.113.0'
		);
		const result = checkPins(withDrift({ tickDenoLock: drifted }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toMatch(/deno\.lock/);
	});

	it('refuses a lock that names no specifier for a mapped npm package', () => {
		const lock = JSON.parse(actual.tickDenoLock) as { specifiers: Record<string, string> };
		lock.specifiers = {};
		const result = checkPins(withDrift({ tickDenoLock: JSON.stringify(lock) }));
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toMatch(/names no specifier/);
	});

	it('refuses a missing, empty or malformed lock', () => {
		expect(checkPins(withDrift({ tickDenoLock: '' })).ok).toBe(false);
		expect(checkPins(withDrift({ tickDenoLock: '{ not json' })).ok).toBe(false);
		expect(checkPins(withDrift({ tickDenoLock: '{}' })).ok).toBe(false);
	});
});
