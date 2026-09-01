import { describe, expect, it } from 'vitest';

import { fold } from '../src/lib/core/projection/fold.ts';
import {
	AUCTION_OPENED_EVENT,
	CONTRACT_ASSIGNMENT_OPENED_EVENT,
	INITIAL_PHASE,
	phaseReducer
} from '../src/lib/core/projection/phase.ts';
import type { AppendedEvent } from '../src/lib/core/types.ts';

/** Build a minimal, valid `AppendedEvent` — only `seq`/`type` usually matter. */
function event(seq: string, type: string): AppendedEvent {
	return {
		seq,
		occurredAt: '2026-08-22T00:00:00.000Z',
		schemaVersion: 1,
		coreVersion: 1,
		type,
		payload: {},
		managerId: 'm-1',
		teamId: 't-1',
		deviceClass: null,
		dispatchOutcome: null,
		deliveryOutcome: null
	};
}

describe('INITIAL_PHASE', () => {
	it('is Setup — the correct answer with no events, not a placeholder', () => {
		expect(INITIAL_PHASE).toBe('Setup');
	});
});

describe('phaseReducer', () => {
	it('folds no events to Setup', () => {
		expect(fold(INITIAL_PHASE, [], phaseReducer)).toBe('Setup');
	});

	it('leaves the phase unchanged for an event type it does not recognise (the default case)', () => {
		// Since Story 3.7 the reducer has two real cases, `AuctionOpened` and
		// `ContractAssignmentOpened`. Every other type still reaches `default` —
		// this is the reducer's correct behaviour, not an unfinished switch.
		// `tests/core/auction-open.test.ts` covers the first case; the block at
		// the bottom of this file covers the second.
		const events = [event('1', 'SomeUnrelatedEvent'), event('2', 'AnotherOne')];
		expect(fold(INITIAL_PHASE, events, phaseReducer)).toBe('Setup');
	});

	it('leaves a non-initial starting state unchanged too, for the same reason', () => {
		// Exercises the reducer against a starting state other than
		// INITIAL_PHASE, so "unchanged" is proven rather than assumed to be
		// "always Setup" by coincidence.
		const events = [event('1', 'Whatever')];
		expect(fold('Auction', events, phaseReducer)).toBe('Auction');
	});

	it('a full rebuild from empty state converges on the same result as a genuinely incremental fold (AD-5)', () => {
		const all = [event('1', 'A'), event('2', 'B'), event('3', 'C')];

		const rebuilt = fold(INITIAL_PHASE, all, phaseReducer);

		const afterFirstTwo = fold(INITIAL_PHASE, all.slice(0, 2), phaseReducer);
		const incremental = fold(afterFirstTwo, all.slice(2), phaseReducer);

		expect(incremental).toBe(rebuilt);
		expect(rebuilt).toBe('Setup');
	});
});

// --- the second case: the phase ends by falling out of the log (Story 3.7) --

describe('phaseReducer — ContractAssignmentOpened, the second and last case so far', () => {
	it('folds a running auction to Contract Assignment', () => {
		const log = [
			event('1', AUCTION_OPENED_EVENT),
			event('2', CONTRACT_ASSIGNMENT_OPENED_EVENT)
		];
		expect(fold(INITIAL_PHASE, log, phaseReducer)).toBe('Contract Assignment');
	});

	it('is idempotent — a second one changes nothing, so a double replay converges', () => {
		const log = [
			event('1', AUCTION_OPENED_EVENT),
			event('2', CONTRACT_ASSIGNMENT_OPENED_EVENT),
			event('3', CONTRACT_ASSIGNMENT_OPENED_EVENT)
		];
		const once = fold(INITIAL_PHASE, log, phaseReducer);
		expect(once).toBe('Contract Assignment');
		expect(fold(once, log, phaseReducer)).toBe(once);
	});

	it('has NO inverse — nothing returns the phase to Auction or to Setup', () => {
		// AD-4 forbids deleting an event and no compensating event for either
		// transition exists or is intended. Every event type this codebase can
		// append is tried against a phase that has already ended.
		const ended = fold(
			INITIAL_PHASE,
			[event('1', AUCTION_OPENED_EVENT), event('2', CONTRACT_ASSIGNMENT_OPENED_EVENT)],
			phaseReducer
		);

		for (const type of [
			'NominationPlaced',
			'BidPlaced',
			'BidVoided',
			'AuctionClosed',
			'AuctionTerminated',
			'ContentionDrawn',
			'ContentionDissolved',
			'MinorLeagueEligibilitySet',
			'ImportPromoted'
		]) {
			expect(fold(ended, [event('9', type)], phaseReducer), type).toBe('Contract Assignment');
		}

		// Not even a second open, which is what "one-way" actually means.
		expect(fold(ended, [event('9', AUCTION_OPENED_EVENT)], phaseReducer)).toBe('Auction');
	});

	it('is decided by log ORDER rather than by a guard — seq is the whole rule', () => {
		// The reducer guards on nothing, deliberately: a fold must be total over
		// any log it is handed, and the gates are what make the impossible orders
		// unappendable. `fold()` sorts by `seq`, so the LAST transition wins
		// whatever order the array arrived in.
		const shuffled = [
			event('2', CONTRACT_ASSIGNMENT_OPENED_EVENT),
			event('1', AUCTION_OPENED_EVENT)
		];
		expect(fold(INITIAL_PHASE, shuffled, phaseReducer)).toBe('Contract Assignment');
	});
});
