import { describe, expect, it } from 'vitest';

import { formatTeamManager } from '../src/lib/core/team-identity.ts';

/**
 * `formatTeamManager`, the naming convention's one renderer. Glossary rule: a
 * fantasy Team is always spelled out with its acting Manager attached, never
 * abbreviated to three letters — that abbreviation means an NBA team only.
 */

/** U+2014 EM DASH, asserted by codepoint so an editor cannot silently
 *  normalise it to a hyphen without this test noticing. */
const EM_DASH = '—';

describe('formatTeamManager', () => {
	it('pairs the Team name with the acting Manager, spelled out', () => {
		expect(formatTeamManager('Lakers', 'Meakel')).toBe('Lakers — Meakel');
	});

	it('uses an em dash, not a hyphen', () => {
		const result = formatTeamManager('Lakers', 'Meakel');
		expect(result).toContain(EM_DASH);
		expect(result).not.toContain('-');
		expect(result.codePointAt(result.indexOf(EM_DASH))).toBe(0x2014);
	});

	it('separates the em dash from both names with exactly one space on each side', () => {
		expect(formatTeamManager('Celtics', 'Cara')).toBe(`Celtics ${EM_DASH} Cara`);
	});

	it('is a pure function: same inputs, same output, every time', () => {
		expect(formatTeamManager('Warriors', 'Dana')).toBe(formatTeamManager('Warriors', 'Dana'));
	});

	it('never abbreviates the Team name it is given', () => {
		// The formatter does not invent an abbreviation; whatever it is handed
		// for teamName appears verbatim. This asserts it is not silently
		// truncated to three characters or upper-cased into one.
		expect(formatTeamManager('Lakers', 'Meakel')).toContain('Lakers');
		expect(formatTeamManager('Lakers', 'Meakel')).not.toContain('LAK');
	});

	it.each([
		['a name carrying its own em dash', 'Buy — Sell Co.', 'Meakel'],
		['a manager name with surrounding whitespace, taken verbatim', 'Lakers', ' Meakel '],
		['a single-word manager name', 'Nets', 'Kim'],
		['a Team name with internal punctuation', "Nique's All-Stars", 'Sam']
	])('handles %s without throwing or reshaping either argument', (_label, teamName, managerName) => {
		expect(formatTeamManager(teamName, managerName)).toBe(`${teamName} ${EM_DASH} ${managerName}`);
	});

	describe('a Manager with no Team yet', () => {
		it('renders just the Manager name, with no em dash', () => {
			expect(formatTeamManager(null, 'Meakel')).toBe('Meakel');
		});

		it('never emits an em dash when teamName is null', () => {
			expect(formatTeamManager(null, 'Meakel')).not.toContain(EM_DASH);
		});

		it('is still pure for the null case', () => {
			expect(formatTeamManager(null, 'Meakel')).toBe(formatTeamManager(null, 'Meakel'));
		});
	});
});
