/**
 * Minor League Eligibility: what a set/unset would change, the sentence a
 * row states, and the four refusal sentences. Pure (Story 1.10).
 *
 * Three rules live here and nowhere else:
 *
 *   1. **The no-op.** A set/unset that would not change a Player's current
 *      value appends NO event and is reported as unchanged, so "before and
 *      after values" always mean something in the Audit Log.
 *   2. **The unknown id.** A Player id not in the live pool is refused BY
 *      NAME, never silently skipped.
 *   3. **The consequence.** `ELIGIBILITY_CONSEQUENCE` is the one statement of
 *      what the flag does to a Team; the surface prints a sentence built from
 *      it rather than showing a bare checkbox (EXPERIENCE.md's voice rule:
 *      where a control has a non-obvious rules consequence, say it).
 *
 * `eligibilityRefusalDetail` mirrors `import-preview.ts`'s
 * `promotionRefusalDetail` exactly: the route, the transaction and the tests
 * read ONE wording per refusal.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

/**
 * One pooled Player as the planner sees them: identity, the name a refusal
 * or a row sentence uses, and their CURRENT eligibility — which the caller
 * takes from the fold of the log, never from a column it read separately.
 */
export type PooledPlayerEligibility = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly eligible: boolean;
};

/** One Player whose flag actually changes, with both values named. */
export type EligibilityChange = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly before: boolean;
	readonly after: boolean;
};

/** One Player the submission named whose value already equals the target. */
export type UnchangedPlayer = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** The value they already hold, which is also the value that was asked for. */
	readonly eligible: boolean;
};

/** What a submission would do: the changes, the no-ops, and the unknown ids. */
export type EligibilityPlan = {
	readonly changes: readonly EligibilityChange[];
	readonly unchanged: readonly UnchangedPlayer[];
	readonly unknownIds: readonly string[];
};

/**
 * The one statement of what the flag means to a Team. Every row sentence and
 * every summary is built from this string, so there is exactly one place the
 * consequence is worded.
 */
export const ELIGIBILITY_CONSEQUENCE = 'this Player can be stashed at a $0 Cap Hit';

/**
 * The sentence beside one Player's control, stating the consequence in words
 * rather than offering a bare checkbox.
 *
 * Both branches read the same consequence out of the same constant — the
 * unset branch says what does not hold, so the two states are distinguished
 * by their words and not by a tick mark alone (the greyscale floor).
 */
export function eligibilityRowSentence(playerName: string, eligible: boolean): string {
	if (eligible) {
		return `${playerName} is Minor League Eligible: ${ELIGIBILITY_CONSEQUENCE}.`;
	}
	return (
		`${playerName} is not Minor League Eligible: it is not the case that ` +
		`${ELIGIBILITY_CONSEQUENCE}, so a winning bid carries its full Cap Hit.`
	);
}

/**
 * Plan what a set/unset would do, without doing any of it.
 *
 * One function so the no-op skip and the unknown-id detection have one
 * definition each — the transaction decides from this, the tests assert on
 * this, and no second copy can drift.
 *
 * Duplicate ids in one submission collapse to their first occurrence. A form
 * can post the same id twice (a select-all plus a row tick, a resubmitted
 * page); two events for one Player in one transaction would put a
 * before/after pair in the Audit Log whose `before` was already stale by the
 * time it was written.
 *
 * Order is the submission's order for `unknownIds`, and the pool's order for
 * the other two — the pool arrives sorted by name, so the sentences come out
 * in a stated order rather than the order a form serialised its checkboxes.
 */
export function planEligibilityChanges(
	pool: readonly PooledPlayerEligibility[],
	ids: readonly string[],
	target: boolean
): EligibilityPlan {
	const byId = new Map(pool.map((player) => [player.fantraxPlayerId, player]));

	const seen = new Set<string>();
	const requested: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		requested.push(id);
	}

	const unknownIds = requested.filter((id) => !byId.has(id));

	const changes: EligibilityChange[] = [];
	const unchanged: UnchangedPlayer[] = [];
	for (const player of pool) {
		if (!seen.has(player.fantraxPlayerId)) continue;
		if (player.eligible === target) {
			unchanged.push({
				fantraxPlayerId: player.fantraxPlayerId,
				playerName: player.playerName,
				eligible: player.eligible
			});
			continue;
		}
		changes.push({
			fantraxPlayerId: player.fantraxPlayerId,
			playerName: player.playerName,
			before: player.eligible,
			after: target
		});
	}

	return { changes, unchanged, unknownIds };
}

// --- The four refusals ------------------------------------------------------

/**
 * Why an eligibility change was refused.
 *
 * `phase` and `unknown_players` are re-derived INSIDE the transaction, from
 * the log and the live pool respectively. The other three are decided by the
 * route before the transaction opens: `empty_selection` because there is
 * nothing to decide about, `unstated_direction` because which way the change
 * was meant is unknowable from the submission, and `unbound_actor` because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so an unbound
 * actor has no event to append. All five are worded here anyway, so the
 * route never words a refusal itself.
 */
export type EligibilityRefusal =
	| { readonly kind: 'phase'; readonly phase: string }
	| { readonly kind: 'unknown_players'; readonly fantraxPlayerIds: readonly string[] }
	| { readonly kind: 'empty_selection' }
	| { readonly kind: 'unstated_direction' }
	| { readonly kind: 'unbound_actor' };

/**
 * The one refusal sentence for each case.
 *
 * Product voice: state the fact, then the arithmetic. No apology, no
 * exclamation mark, no advice.
 *
 * The `phase` sentence carries three facts because all three are load-
 * bearing: the phase that was folded, WHY the change cannot be made after
 * open (FR-35 — the flag is an input to cap arithmetic on every open Auction
 * for that Player), and that the way through is a Commissioner override
 * which this surface does not offer. The override path is Epic 7 and is
 * deliberately not built here; saying so is not a promise that it exists
 * elsewhere today.
 */
export function eligibilityRefusalDetail(refusal: EligibilityRefusal): string {
	switch (refusal.kind) {
		case 'phase':
			return (
				`The change was refused: the phase is ${refusal.phase}, not Setup. ` +
				'Minor League Eligibility is an input to cap arithmetic under FR-35 for every ' +
				'open Auction on that Player, so changing it after the auction opens would ' +
				'restate bids already placed. A Commissioner override is required, and this ' +
				'surface does not offer one. The phase was folded from the event log inside ' +
				'this transaction.'
			);
		case 'unknown_players':
			return (
				'The change was refused: no Player in the Free Agent pool carries ' +
				`${refusal.fantraxPlayerIds.length === 1 ? 'this Fantrax id' : 'these Fantrax ids'}: ` +
				`${refusal.fantraxPlayerIds.join(', ')}. Nothing was written.`
			);
		case 'empty_selection':
			return 'The change was refused: no Player was selected. Nothing was written.';
		case 'unstated_direction':
			return (
				'The change was refused: the submission did not state whether to set or ' +
				'unset Minor League Eligibility. Either value would have been a guess at ' +
				'what was meant for every Player selected. Nothing was written.'
			);
		case 'unbound_actor':
			return (
				'The change was refused: the acting Manager is not bound to a Team, ' +
				'and every event must name one.'
			);
	}
}

/**
 * What a completed change states back: every Player set, and every Player
 * that was already at the requested value, BY NAME.
 *
 * Named, never counted (epic-1-context.md). The Commissioner submitted a
 * specific set of Players and the honest report is which of them moved and
 * which did not — "37 changed, 3 unchanged" tells them nothing they can act
 * on at 11am on setup day.
 */
export function eligibilityOutcomeDetail(plan: EligibilityPlan, target: boolean): string {
	const verb = target ? 'set to Minor League Eligible' : 'set to not Minor League Eligible';
	const parts: string[] = [];

	if (plan.changes.length === 0) {
		parts.push(`No Player was ${verb}: every Player selected already held that value.`);
	} else {
		parts.push(`${verb.charAt(0).toUpperCase()}${verb.slice(1)}: ` +
			`${plan.changes.map((change) => change.playerName).join(', ')}.`);
	}

	if (plan.unchanged.length > 0) {
		parts.push(
			`Unchanged, already at that value and so carrying no event: ` +
				`${plan.unchanged.map((player) => player.playerName).join(', ')}.`
		);
	}

	return parts.join(' ');
}
