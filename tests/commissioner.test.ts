import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STYLES = join(ROOT, 'src', 'lib', 'styles');

/**
 * The Commissioner control must stay distinguishable from a Manager control with
 * all colour removed — the accessibility floor's acceptance test is a greyscale
 * screenshot, and the person the distinction protects is the one holding both
 * roles at once.
 *
 * This asserts the four differentiators structurally, over the declared token
 * values, rather than over a rendered screenshot: fill presence, border style,
 * ground luminance, and the persistent label. Those are exactly the properties
 * that survive desaturation. A Playwright visual check is the stronger form and
 * belongs with the first real Commissioner surface in Story 1.7.
 */

// --- A minimal CSS reader --------------------------------------------------

type Rule = { selector: string; declarations: Map<string, string> };

function readRules(source: string): Rule[] {
	const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
	const rules: Rule[] = [];
	for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const declarations = new Map<string, string>();
		for (const line of (match[2] ?? '').split(';')) {
			const at = line.indexOf(':');
			if (at === -1) continue;
			declarations.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
		}
		rules.push({ selector: (match[1] ?? '').trim(), declarations });
	}
	return rules;
}

const commissionerCss = readFileSync(join(STYLES, 'commissioner.css'), 'utf8');
const tokensCss = readFileSync(join(STYLES, 'tokens.css'), 'utf8');
const rules = readRules(commissionerCss);

/**
 * All declarations that apply to a selector, later rules winning.
 *
 * The `background` shorthand is expanded into the longhands before merging.
 * Without that, `background: var(--control-fill)` on the Commissioner control is
 * invisible to a test that only reads `background-color` — the control is filled
 * on screen while every assertion still passes. That exact mutation was
 * demonstrated against this file.
 */
function declarationsFor(selector: string): Map<string, string> {
	const merged = new Map<string, string>();
	for (const rule of rules) {
		const selectors = rule.selector.split(',').map((part) => part.trim());
		if (!selectors.includes(selector)) continue;
		for (const [property, value] of rule.declarations) {
			if (property === 'background') {
				// `background: none` resets the colour to its initial `transparent`;
				// anything else is treated as painting the box, which is what the
				// "never filled" assertions care about.
				merged.set('background-color', value === 'none' ? 'transparent' : value);
				merged.set('background-image', /url\(|gradient/i.test(value) ? value : 'none');
				continue;
			}
			merged.set(property, value);
		}
	}
	return merged;
}

/** Resolve a value through tokens.css until it is no longer a var() reference. */
function resolve(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	let current = value;
	for (let depth = 0; depth < 8; depth += 1) {
		const reference = /var\(\s*(--[\w-]+)\s*\)/.exec(current);
		if (reference === null) return current.trim();
		const name = reference[1] ?? '';
		const declared = new RegExp(`${name}\\s*:\\s*([^;{}]+);`).exec(
			tokensCss.replace(/\/\*[\s\S]*?\*\//g, '')
		);
		if (declared === null) throw new Error(`${name} is referenced but not declared in tokens.css`);
		current = current.replace(reference[0], (declared[1] ?? '').trim());
	}
	throw new Error(`var() references in "${value}" do not terminate`);
}

// --- Greyscale -------------------------------------------------------------

/** WCAG 2.1 relative luminance — what a colour becomes when desaturated. */
function relativeLuminance(hex: string): number {
	const normalised = hex.trim().replace('#', '');
	expect(normalised, `"${hex}" is not a six-digit hex colour`).toMatch(/^[0-9A-Fa-f]{6}$/);
	const channels = [0, 2, 4].map((at) => {
		const channel = Number.parseInt(normalised.slice(at, at + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** WCAG 2.1 contrast ratio between two hex colours, 1:1 to 21:1. */
function contrastRatio(a: string, b: string): number {
	const first = relativeLuminance(a);
	const second = relativeLuminance(b);
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

/** Resolve a declaration to a hex colour, failing loudly if it is not one. */
function colourOf(declarations: Map<string, string>, property: string): string {
	const value = resolve(declarations.get(property));
	expect(value, `${property} is not declared`).toBeDefined();
	expect(value, `${property} resolves to "${value}", which is not a hex colour`).toMatch(
		/^#[0-9A-Fa-f]{6}$/
	);
	return value ?? '';
}

/** The border colour out of a border shorthand or longhand. */
function borderColourOf(declarations: Map<string, string>): string {
	const shorthand = resolve(declarations.get('border') ?? declarations.get('border-top'));
	const hex = /#[0-9A-Fa-f]{6}/.exec(shorthand ?? '');
	expect(hex, `no hex colour in border "${shorthand}"`).not.toBeNull();
	return hex?.[0] ?? '';
}

/** The `solid` / `dashed` keyword out of a border shorthand or longhand. */
function borderStyleOf(declarations: Map<string, string>): string | undefined {
	const explicit = declarations.get('border-style');
	if (explicit !== undefined) return explicit;
	for (const property of ['border', 'border-top']) {
		const shorthand = declarations.get(property);
		if (shorthand === undefined) continue;
		const keyword = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset|none)\b/.exec(
			shorthand
		);
		if (keyword !== null) return keyword[1];
	}
	return undefined;
}

const manager = declarationsFor('.control-manager');
const commissioner = declarationsFor('.control-commissioner');
const managerGround = declarationsFor('.manager-block');
const commissionerGround = declarationsFor('.commissioner-block');

describe('both control classes exist', () => {
	it('declares a Manager control and a Commissioner control', () => {
		expect(manager.size, '.control-manager is not declared').toBeGreaterThan(0);
		expect(commissioner.size, '.control-commissioner is not declared').toBeGreaterThan(0);
		expect(managerGround.size, '.manager-block is not declared').toBeGreaterThan(0);
		expect(commissionerGround.size, '.commissioner-block is not declared').toBeGreaterThan(0);
	});
});

describe('difference 1 — fill', () => {
	it('fills the Manager control with a real colour', () => {
		const fill = resolve(manager.get('background-color'));
		expect(fill).toMatch(/^#[0-9A-Fa-f]{6}$/);
		// #1D2922, not DESIGN.md:229's #223028 — see the correction recorded in
		// tokens.css and the 1.4.11 assertions below.
		expect(fill).toBe('#1D2922');
	});

	it('never fills the Commissioner control', () => {
		expect(commissioner.get('background-color')).toBe('transparent');
		expect(commissioner.get('background-image') ?? 'none').toBe('none');
	});

	it('never fills the Commissioner control on hover, focus or active either', () => {
		// Every interactive state must SAY it stays unfilled. Skipping a state whose
		// declaration is simply absent is how a rewrite to
		// `background: var(--control-fill)` passed this suite unnoticed: the guard
		// treated "nothing declared" and "declared transparent" as the same answer.
		for (const state of [':hover', ':focus-visible', ':active']) {
			const stateful = declarationsFor(`.control-commissioner${state}`);
			expect(
				stateful.get('background-color'),
				`.control-commissioner${state} must declare it stays unfilled`
			).toBe('transparent');
			expect(stateful.get('background-image') ?? 'none', `on ${state}`).toBe('none');
		}
	});

	it('survives desaturation: one control has a fill, the other has none', () => {
		const managerFill = manager.get('background-color');
		const commissionerFill = commissioner.get('background-color');
		expect(managerFill).toBeDefined();
		expect(managerFill).not.toBe('transparent');
		expect(commissionerFill).toBe('transparent');
	});
});

describe('difference 2 — border style', () => {
	it('gives the Manager control a solid 1px border-interactive', () => {
		expect(borderStyleOf(manager)).toBe('solid');
		expect(resolve(manager.get('border'))).toContain('1px');
		expect(resolve(manager.get('border'))).toContain('#5E7568');
		// DESIGN.md:116 assigns control boundaries to border-interactive. It holds
		// the same value as border-strong today; naming the wrong one would break
		// silently the day they diverge.
		expect(manager.get('border')).toContain('--color-border-interactive');
	});

	it('gives the Commissioner control a dashed 1px admin border', () => {
		expect(borderStyleOf(commissioner)).toBe('dashed');
		expect(resolve(commissioner.get('border'))).toContain('1px');
		expect(resolve(commissioner.get('border'))).toContain('#6E8592');
	});

	it('survives desaturation: solid and dashed are not the same shape', () => {
		expect(borderStyleOf(manager)).not.toBe(borderStyleOf(commissioner));
	});
});

describe('difference 3 — ground', () => {
	it('sits a Manager control on surface', () => {
		expect(resolve(managerGround.get('background-color'))).toBe('#15211B');
	});

	it('sits a Commissioner control on a recessed admin-ground behind a dashed rule', () => {
		expect(resolve(commissionerGround.get('background-color'))).toBe('#131C1C');
		expect(borderStyleOf(commissionerGround)).toBe('dashed');
		expect(commissionerGround.get('border-top')).toBeDefined();
	});

	it('survives desaturation: the two grounds have distinct luminance', () => {
		const managerLuminance = relativeLuminance(resolve(managerGround.get('background-color')) ?? '');
		const commissionerLuminance = relativeLuminance(
			resolve(commissionerGround.get('background-color')) ?? ''
		);
		expect(managerLuminance).not.toBe(commissionerLuminance);
		// The recess is a supporting cue, not the load-bearing one — the grounds sit
		// close together by design so the Commissioner block reads as recessed rather
		// than as an alert. Fill, border style and the label carry the distinction.
		expect(Math.abs(managerLuminance - commissionerLuminance)).toBeGreaterThan(0.001);
		expect(commissionerLuminance).toBeLessThan(managerLuminance);
	});
});

describe('difference 4 — the persistent label', () => {
	it('generates the label from CSS so no call site can omit it', () => {
		const label = declarationsFor('.control-commissioner::before');
		const content = label.get('content');
		expect(content, '.control-commissioner::before declares no content').toBeDefined();
		expect(content).toContain('Commissioner');
	});

	it('renders the label in admin-text', () => {
		const label = declarationsFor('.control-commissioner::before');
		expect(resolve(label.get('color'))).toBe('#8FA6B2');
	});

	it('gives the Manager control no such label', () => {
		expect(declarationsFor('.control-manager::before').size).toBe(0);
		expect(declarationsFor('.control-manager::after').size).toBe(0);
	});

	it('survives desaturation: a word is present on one control and absent on the other', () => {
		const commissionerLabel = declarationsFor('.control-commissioner::before').get('content');
		const managerLabel = declarationsFor('.control-manager::before').get('content');
		expect(commissionerLabel).toBeDefined();
		expect(managerLabel).toBeUndefined();
	});
});

describe('width — inline and content-width, never full-bleed', () => {
	it('makes the Manager control full-width', () => {
		expect(manager.get('width')).toBe('100%');
		expect(manager.get('display')).toBe('flex');
	});

	it('makes the Commissioner control inline and content-width', () => {
		expect(commissioner.get('width')).toBe('auto');
		expect(commissioner.get('display')).toBe('inline-flex');
	});
});

describe('the accessibility floor', () => {
	it('keeps both controls above the 44px touch minimum', () => {
		expect(resolve(manager.get('min-height'))).toBe('46px');
		expect(resolve(commissioner.get('min-height'))).toBe('44px');
	});

	it('counts four independent non-colour differences', () => {
		const differences = [
			manager.get('background-color') !== commissioner.get('background-color'),
			borderStyleOf(manager) !== borderStyleOf(commissioner),
			managerGround.get('background-color') !== commissionerGround.get('background-color'),
			declarationsFor('.control-commissioner::before').has('content') &&
				!declarationsFor('.control-manager::before').has('content')
		];
		expect(differences.filter(Boolean)).toHaveLength(4);
	});
});

describe('measured contrast — WCAG 1.4.11 and 1.4.3', () => {
	// DESIGN.md audits every pairing against `surface`, the tightest GROUND. That
	// premise does not hold for a control that carries its own fill: the boundary
	// of a filled button sits on the fill, not on the ground behind it. The
	// original #223028 fill measured 2.77:1 against its own border and shipped
	// only because nobody measured that pair. These assertions measure it.

	it('bounds the Manager control at 3:1 or better against its own fill', () => {
		const fill = colourOf(manager, 'background-color');
		const boundary = borderColourOf(manager);
		const ratio = contrastRatio(boundary, fill);
		expect(
			ratio,
			`control boundary ${boundary} on fill ${fill} measures ${ratio.toFixed(3)}:1, ` +
				`below the 3:1 WCAG 1.4.11 requires of a non-text element identifying a control`
		).toBeGreaterThanOrEqual(3);
	});

	it('bounds the Manager control at 3:1 or better against the ground it sits on', () => {
		const ground = colourOf(managerGround, 'background-color');
		const ratio = contrastRatio(borderColourOf(manager), ground);
		expect(ratio, `measures ${ratio.toFixed(3)}:1 against ${ground}`).toBeGreaterThanOrEqual(3);
	});

	it('bounds the Commissioner control at 3:1 or better against its recessed ground', () => {
		// It is never filled, so the ground behind it IS what its border sits on.
		const ground = colourOf(commissionerGround, 'background-color');
		const ratio = contrastRatio(borderColourOf(commissioner), ground);
		expect(ratio, `measures ${ratio.toFixed(3)}:1 against ${ground}`).toBeGreaterThanOrEqual(3);
	});

	it('renders Manager control text at 4.5:1 or better on its fill', () => {
		const ratio = contrastRatio(colourOf(manager, 'color'), colourOf(manager, 'background-color'));
		expect(ratio, `measures ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
	});

	it('renders Commissioner control text at 4.5:1 or better on its recessed ground', () => {
		const ratio = contrastRatio(
			colourOf(commissioner, 'color'),
			colourOf(commissionerGround, 'background-color')
		);
		expect(ratio, `measures ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
	});

	it('renders the persistent label at 4.5:1 or better on that same ground', () => {
		const label = declarationsFor('.control-commissioner::before');
		const ratio = contrastRatio(
			colourOf(label, 'color'),
			colourOf(commissionerGround, 'background-color')
		);
		expect(ratio, `measures ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
	});

	it('computes ratios the way WCAG defines them', () => {
		// Anchors, so a broken helper cannot quietly certify a failing palette.
		expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
		expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
		// The defect this suite was extended to catch, kept as a regression anchor.
		expect(contrastRatio('#223028', '#5E7568')).toBeLessThan(3);
		expect(contrastRatio('#1D2922', '#5E7568')).toBeGreaterThanOrEqual(3);
	});
});

describe('the stylesheet is actually loaded', () => {
	// Deleting both @import lines from global.css left every assertion in this
	// suite green while the entire token set and Commissioner class became dead
	// at runtime — the files still parse, they just never reach a browser.
	const globalCss = readFileSync(join(STYLES, 'global.css'), 'utf8');

	it.each(['./tokens.css', './commissioner.css'])(
		'global.css imports %s, or nothing here reaches the page',
		(href: string) => {
			expect(globalCss).toMatch(
				new RegExp(`@import\\s+(?:url\\()?["']${href.replaceAll('.', '\\.')}["']`)
			);
		}
	);

	it('imports the tokens before the stylesheet that consumes them', () => {
		expect(globalCss.indexOf('tokens.css')).toBeLessThan(globalCss.indexOf('commissioner.css'));
	});
});

describe('scope', () => {
	it('builds no override reason sheet — that is Story 7.1', () => {
		expect(commissionerCss.toLowerCase()).not.toContain('reason-sheet');
		expect(commissionerCss.toLowerCase()).not.toContain('.reason-');
	});

	it('uses no shadow or elevation — depth is a 1px border', () => {
		expect(commissionerCss).not.toMatch(/box-shadow\s*:\s*(?!none)/);
		expect(commissionerCss).not.toMatch(/\belevation\b/);
		expect(readFileSync(join(STYLES, 'global.css'), 'utf8')).not.toMatch(
			/box-shadow\s*:\s*(?!none)/
		);
	});
});
