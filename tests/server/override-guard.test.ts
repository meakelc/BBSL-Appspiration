/**
 * The override guard (Story 7.1).
 *
 * No override route exists yet — the first lands in Story 7.2 — so this is
 * the only place the two refusals are proven: synthetic form data and
 * synthetic phases in, a SvelteKit `error()` or nothing out. The
 * `expectRefusal` shape is `tests/commissioner-guard.test.ts:41-67`'s,
 * generalised over the status and message so the two distinct refusals can be
 * driven through one assertion.
 *
 * The claim that matters most here is the one about WORDING: three gates can
 * refuse a Commissioner override (not the Commissioner, no reason, League
 * archived) and a Commissioner who is refused needs to know which. The
 * distinctness is asserted rather than trusted.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHttpError } from '@sveltejs/kit';

import {
	COMMISSIONER_ONLY_REFUSAL,
	COMMISSIONER_ONLY_STATUS
} from '../../src/lib/server/commissioner-guard.ts';
import {
	OVERRIDE_ARCHIVED_REFUSAL,
	OVERRIDE_ARCHIVED_STATUS,
	OVERRIDE_REASON_REQUIRED_REFUSAL,
	OVERRIDE_REASON_REQUIRED_STATUS,
	requireOverrideReason,
	requireOverridablePhase
} from '../../src/lib/server/override-guard.ts';
import { OVERRIDE_REASON_FIELD } from '../../src/lib/core/rules/override.ts';
import type { LeaguePhase } from '../../src/lib/core/projection/phase.ts';

/** Assert a call refuses with exactly one status and one message, and nothing else. */
function expectRefusal(act: () => unknown, status: number, message: string): void {
	let thrown: unknown;
	try {
		act();
	} catch (caught) {
		thrown = caught;
	}
	expect(thrown, 'the guard did not throw').toBeDefined();
	expect(isHttpError(thrown)).toBe(true);
	if (isHttpError(thrown)) {
		expect(thrown.status).toBe(status);
		expect(thrown.body.message).toBe(message);
	}
}

/** A submission carrying the given reason, through the real `FormData`. */
function submissionWith(reason: string): FormData {
	const form = new FormData();
	form.set(OVERRIDE_REASON_FIELD, reason);
	return form;
}

describe('requireOverrideReason', () => {
	it('returns the trimmed reason when one was given', () => {
		expect(
			requireOverrideReason(
				submissionWith('  Wrong co-manager account; confirmed in #bbsl-general  ')
			)
		).toBe('Wrong co-manager account; confirmed in #bbsl-general');
	});

	it('refuses a submission with no reason field at all', () => {
		// The hand-rolled POST that never saw a sheet. The refusal is
		// server-side and unconditional: a hidden control is never the check.
		expectRefusal(
			() => requireOverrideReason(new FormData()),
			OVERRIDE_REASON_REQUIRED_STATUS,
			OVERRIDE_REASON_REQUIRED_REFUSAL
		);
	});

	it.each([
		['one space', ' '],
		['tabs', '\t\t'],
		['newlines', '\n\n'],
		['spaces, tabs and newlines together', ' \t\n \r\n\t '],
		['a non-breaking space', '\u00a0']
	])('refuses a whitespace-only reason (%s), identically', (_label, raw) => {
		expectRefusal(
			() => requireOverrideReason(submissionWith(raw)),
			OVERRIDE_REASON_REQUIRED_STATUS,
			OVERRIDE_REASON_REQUIRED_REFUSAL
		);
	});

	it('refuses a reason field that is not text', () => {
		const form = new FormData();
		form.set(OVERRIDE_REASON_FIELD, new File([], 'reason.txt'));
		expectRefusal(
			() => requireOverrideReason(form),
			OVERRIDE_REASON_REQUIRED_STATUS,
			OVERRIDE_REASON_REQUIRED_REFUSAL
		);
	});

	it('states that a reason is required', () => {
		expect(OVERRIDE_REASON_REQUIRED_REFUSAL.toLowerCase()).toContain('reason');
	});

	it('reads the reason from the field the sheet posts, and nothing else', () => {
		const form = new FormData();
		form.set('why', 'this is not the field');
		expectRefusal(
			() => requireOverrideReason(form),
			OVERRIDE_REASON_REQUIRED_STATUS,
			OVERRIDE_REASON_REQUIRED_REFUSAL
		);
	});
});

describe('requireOverridablePhase', () => {
	it.each<LeaguePhase>(['Setup', 'Auction', 'Contract Assignment'])(
		'passes the phase gate in %s',
		(phase) => {
			expect(() => requireOverridablePhase(phase)).not.toThrow();
		}
	);

	it('refuses every override once the League is Archived', () => {
		// NOT covered by `requireLiveDestination`: `/board` and `/teams` are
		// both live in Archived, so an override control placed in place on one
		// of them passes that gate. This is its own gate for that reason.
		expectRefusal(
			() => requireOverridablePhase('Archived'),
			OVERRIDE_ARCHIVED_STATUS,
			OVERRIDE_ARCHIVED_REFUSAL
		);
	});

	it('words the archived refusal around the closed record, not around permission', () => {
		expect(OVERRIDE_ARCHIVED_REFUSAL.toLowerCase()).toContain('archived');
	});
});

describe('the three refusals a Commissioner override can meet are distinct', () => {
	/** One refusal's words, lowercased and stripped of punctuation. */
	function words(refusal: string): string[] {
		return refusal
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter((word) => word.length > 0);
	}

	const REFUSALS: ReadonlyArray<[string, string]> = [
		['Commissioner-only', COMMISSIONER_ONLY_REFUSAL],
		['reason required', OVERRIDE_REASON_REQUIRED_REFUSAL],
		['archived', OVERRIDE_ARCHIVED_REFUSAL]
	];

	it('says something in each that neither of the others says', () => {
		// Asserting only `a !== b` passes for three refusals differing by a
		// single character, which would leave a Commissioner unable to tell
		// which of the three facts stopped them — the whole reason there are
		// three constants rather than one. Each must carry at least one word
		// unique to it, which is what "distinctly worded" actually means.
		for (const [name, refusal] of REFUSALS) {
			const others = new Set(
				REFUSALS.filter(([other]) => other !== name).flatMap(([, text]) => words(text))
			);
			const unique = words(refusal).filter((word) => !others.has(word));
			expect(unique, `"${name}" says nothing the other two do not`).not.toEqual([]);
		}
	});

	it('differs by whole sentences, not by an edit', () => {
		for (const [nameA, a] of REFUSALS) {
			for (const [nameB, b] of REFUSALS) {
				if (nameA >= nameB) continue;
				const setA = new Set(words(a));
				const setB = new Set(words(b));
				const symmetric = [
					...[...setA].filter((word) => !setB.has(word)),
					...[...setB].filter((word) => !setA.has(word))
				];
				expect(
					symmetric.length,
					`"${nameA}" and "${nameB}" are near-identical wordings`
				).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it('is three constants, not two that happen to be equal', () => {
		expect(new Set(REFUSALS.map(([, refusal]) => refusal)).size).toBe(3);
	});

	it('separates the incomplete submission from the forbidden one by status too', () => {
		expect(OVERRIDE_REASON_REQUIRED_STATUS).toBe(400);
		expect(OVERRIDE_ARCHIVED_STATUS).toBe(COMMISSIONER_ONLY_STATUS);
		expect(OVERRIDE_REASON_REQUIRED_STATUS).not.toBe(COMMISSIONER_ONLY_STATUS);
	});
});

describe('AC4 — nothing here alters the Commissioner’s own Team', () => {
	// "Given the Commissioner's own Team, when ordinary Manager controls render
	// on it, then nothing in this story alters its Cap Space, Maximum Bid or
	// Nomination Slot." Counting a function's parameters said nothing about any
	// of those three figures. These do.

	it('names no Cap Space, Maximum Bid or Nomination Slot rule in its code', () => {
		// Comments are stripped, so the module's own prose about the invariant
		// is not mistaken for a read of one; the comparison is case-insensitive
		// so a rename or a different casing cannot slip past.
		const code = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'server', 'override-guard.ts'),
			'utf8'
		)
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
			.toLowerCase();
		for (const forbidden of [
			'capspace',
			'cap_space',
			'maximumbid',
			'maximum_bid',
			'nominationslot',
			'nomination_slot',
			'salarycap',
			'salary_cap',
			'evaluate(',
			'teamid',
			'team_id'
		]) {
			expect(code, `override-guard.ts reaches for ${forbidden}`).not.toContain(forbidden);
		}
	});

	it('imports no money, bidding or nomination module', () => {
		// The stronger half of the same claim: a figure this guard does not
		// import is a figure it cannot change.
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'server', 'override-guard.ts'),
			'utf8'
		);
		const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
		expect(imports.sort()).toEqual([
			'../core/projection/phase.ts',
			'../core/rules/override.ts',
			'@sveltejs/kit'
		]);
	});

	it('answers the phase gate the same way whoever is asking', () => {
		// The gate takes a phase and nothing else, so there is no Team for it
		// to treat specially — and the same phase gives the same answer every
		// time it is asked, Commissioner's own Team or any other.
		for (const phase of ['Setup', 'Auction', 'Contract Assignment'] as const) {
			expect(() => requireOverridablePhase(phase)).not.toThrow();
			expect(() => requireOverridablePhase(phase)).not.toThrow();
		}
		expectRefusal(
			() => requireOverridablePhase('Archived'),
			OVERRIDE_ARCHIVED_STATUS,
			OVERRIDE_ARCHIVED_REFUSAL
		);
	});
});
