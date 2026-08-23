import { describe, expect, it } from 'vitest';

import { classifyDestinations } from '../src/lib/destinations-view.ts';
import type { Destination } from '../src/lib/destinations-view.ts';
import { SIGN_IN_DESTINATION } from '../src/lib/server/destinations.ts';

/**
 * `classifyDestinations`, called directly (AC6).
 *
 * `tests/signin-surface.test.ts`'s block-placement guard proves a
 * Commissioner-only entry does not render inside `manager-block`'s markup;
 * it cannot prove the *filter that decides which entry goes where* is
 * correct, because the guard reads static markup and the class names never
 * move regardless of which array a filter routes an entry into. This file
 * is what actually proves that filter, by calling it directly.
 */

function destination(id: string, commissionerOnly: boolean): Destination {
	return { id, label: id, href: `/${id}`, commissionerOnly };
}

const SIGN_IN: Destination = { id: 'sign-in', label: 'Sign-in', href: '/signin', commissionerOnly: false };

describe('classifyDestinations', () => {
	it('sorts a Commissioner-only entry into commissionerDestinations and never managerDestinations', () => {
		const admin = destination('import', true);
		const result = classifyDestinations([admin]);
		expect(result.commissionerDestinations).toContain(admin);
		expect(result.managerDestinations).not.toContain(admin);
	});

	it('sorts a general entry into managerDestinations and never commissionerDestinations', () => {
		const general = destination('teams', false);
		const result = classifyDestinations([general]);
		expect(result.managerDestinations).toContain(general);
		expect(result.commissionerDestinations).not.toContain(general);
	});

	it('splits a mixed list correctly — the exact shape a swapped `!` predicate would get wrong', () => {
		const generalOne = destination('teams', false);
		const generalTwo = destination('audit-log', false);
		const adminOne = destination('import', true);
		const adminTwo = destination('auction-open-gate', true);

		const result = classifyDestinations([generalOne, adminOne, generalTwo, adminTwo]);

		expect(result.managerDestinations).toEqual([generalOne, generalTwo]);
		expect(result.commissionerDestinations).toEqual([adminOne, adminTwo]);
	});

	it('holds the Sign-in entry apart from both groupings', () => {
		const result = classifyDestinations([SIGN_IN]);
		expect(result.signIn).toEqual(SIGN_IN);
		expect(result.managerDestinations).toEqual([]);
		expect(result.commissionerDestinations).toEqual([]);
	});

	it('returns undefined for signIn when the list carries no Sign-in entry', () => {
		const result = classifyDestinations([destination('teams', false)]);
		expect(result.signIn).toBeUndefined();
	});

	it('returns every array empty, and signIn undefined, for an empty destination list', () => {
		const result = classifyDestinations([]);
		expect(result.signIn).toBeUndefined();
		expect(result.managerDestinations).toEqual([]);
		expect(result.commissionerDestinations).toEqual([]);
	});

	it("recognizes the server catalog's real SIGN_IN_DESTINATION, not only a hand-built stand-in", () => {
		// This module's `SIGN_IN_ID` is a deliberately separate copy of
		// `SIGN_IN_DESTINATION.id` (a .svelte-adjacent module may not import
		// the server-only destinations module) — this pins the two together
		// without undoing that separation: if the catalog's id ever changes
		// and this one does not follow, classifyDestinations stops
		// recognizing Sign-in, and this test is what would catch it.
		const result = classifyDestinations([SIGN_IN_DESTINATION]);
		expect(result.signIn).toEqual(SIGN_IN_DESTINATION);
	});

	describe('hasNothingLive', () => {
		it('is true only when signIn is absent and both groups are empty', () => {
			expect(classifyDestinations([]).hasNothingLive).toBe(true);
		});

		it('is false when only Sign-in is present', () => {
			expect(classifyDestinations([SIGN_IN]).hasNothingLive).toBe(false);
		});

		it('is false when only a manager-visible entry is present', () => {
			expect(classifyDestinations([destination('teams', false)]).hasNothingLive).toBe(false);
		});

		it('is false when only a Commissioner-only entry is present', () => {
			expect(classifyDestinations([destination('import', true)]).hasNothingLive).toBe(false);
		});
	});
});
