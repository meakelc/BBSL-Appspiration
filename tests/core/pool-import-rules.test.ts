import { describe, expect, it } from 'vitest';

import { poolConflictRefusalDetail } from '../../src/lib/core/rules/pool-import.ts';

describe('poolConflictRefusalDetail — one sentence, shared by both directions', () => {
	it('names the Player and the Team', () => {
		const detail = poolConflictRefusalDetail([{ playerName: 'Alice', teamName: 'Lakers' }]);
		expect(detail).toContain('Alice');
		expect(detail).toContain('Lakers');
	});

	it('states the fact, then the specifics — product voice, no apology, no exclamation mark', () => {
		const detail = poolConflictRefusalDetail([{ playerName: 'Alice', teamName: 'Lakers' }]);
		expect(detail).toBe(
			"A Player cannot be both a Free Agent and on a Team roster: Alice is on the Lakers roster."
		);
		expect(detail).not.toContain('!');
		expect(detail.toLowerCase()).not.toContain('sorry');
	});

	it('names every conflicting Player and Team when there are several', () => {
		const detail = poolConflictRefusalDetail([
			{ playerName: 'Alice', teamName: 'Lakers' },
			{ playerName: 'Bob', teamName: 'Celtics' }
		]);
		expect(detail).toContain('Alice is on the Lakers roster');
		expect(detail).toContain('Bob is on the Celtics roster');
		// Never the possessive: "Celtics's roster" reads as a typo, and most
		// BBSL Team names are plural (review-loop-iteration 1).
		expect(detail).not.toContain("'s roster");
	});

	it('produces an honest sentence rather than a fragment when handed no conflicts', () => {
		expect(poolConflictRefusalDetail([])).toMatch(/^No Player appears in both/);
	});

	it('is pure — the same input yields the same sentence, with no I/O', () => {
		const conflicts = [{ playerName: 'Alice', teamName: 'Lakers' }];
		expect(poolConflictRefusalDetail(conflicts)).toBe(poolConflictRefusalDetail(conflicts));
	});
});
