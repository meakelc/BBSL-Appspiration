/**
 * Minor League Eligibility: what a set/unset would change, the sentence a
 * row states, and the four refusal sentences. Pure (Story 1.10).
 *
 * Three rules live here and nowhere else:
 *
 *   1. **The no-op.** A set/unset that would not change a Player's current
 *      value appends NO event and is reported as unchanged, so "before and
 *      after values" always mean something in the Audit Log.
 *   2. **The unknown id.** A Player id that names neither a pooled Player nor
 *      a rostered Contract is refused BY NAME, never silently skipped.
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
 * One Player the flag can be set on, as the planner sees them: identity, the
 * name a refusal or a row sentence uses, and their CURRENT eligibility —
 * which the caller takes from the fold of the log, never from a column it
 * read separately.
 *
 * **A candidate is a pooled Player OR a rostered Contract.** The flag answers
 * "may this Player occupy a Minor League Slot", and FR-44 asks that of a
 * Contract already on a Roster as readily as of one still in the pool:
 * `mayOccupyMinorLeague` (`rules/roster-rearrange.ts`) is the union of this
 * flag and the observation fold, so a rostered Player who has never been
 * observed in a Minor League Slot has no other way for the app to be told he
 * may occupy one.
 *
 * **`pooled` is the ONE thing downstream branches on, and only the phase gate
 * does.** This type was written indifferent to which of the two a candidate
 * is, and every rule that reads the FLAG still is — `planEligibilityChanges`
 * below never looks at this field. It exists because the phase gate is not a
 * rule about the flag, it is a rule about cap arithmetic: FR-35 binds the
 * flag to the Committed Bids of an OPEN AUCTION, and only a pooled Player can
 * have one. `teamMoneyStateFor` (`rules/bidding.ts`) partitions
 * `auctions.byPlayer` and nothing else, so a rostered Contract's flag cannot
 * reach any Team's Minors Exposure, Available Cap Space or Maximum Bid. The
 * gate therefore asks which kind a candidate is; nothing else may.
 */
export type EligibilityCandidate = {
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	readonly eligible: boolean;
	/**
	 * Whether this candidate is a Player in the Free Agent pool, as opposed to
	 * a Contract on a Roster. Read by the phase gate alone.
	 */
	readonly pooled: boolean;
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
 * Order is the submission's order for `unknownIds`, and the candidates' order
 * for the other two — they arrive sorted by name, so the sentences come out
 * in a stated order rather than the order a form serialised its checkboxes.
 *
 * A candidate id appearing twice — which the caller's read must not produce,
 * and which this function must not depend on it never producing — collapses
 * to its first occurrence, so one Player yields at most one change or one
 * no-op no matter how many rows named him.
 */
export function planEligibilityChanges(
	candidates: readonly EligibilityCandidate[],
	ids: readonly string[],
	target: boolean
): EligibilityPlan {
	const byId = new Map<string, EligibilityCandidate>();
	for (const candidate of candidates) {
		if (!byId.has(candidate.fantraxPlayerId)) byId.set(candidate.fantraxPlayerId, candidate);
	}

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
	// `byId.values()` rather than `candidates`: a Map keeps insertion order, so
	// this is still the caller's name order, with any duplicate id collapsed.
	for (const player of byId.values()) {
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

/**
 * Which of the submitted ids name a POOLED Player, in the candidates' order.
 *
 * The phase gate's one input, split out so "what makes the phase bite" has a
 * single expression the tests can drive directly. An id naming a rostered
 * Contract is absent, and so is an id naming nothing at all — an unknown id
 * is the `unknown_players` refusal's business, and answering "is this pooled?"
 * with `false` for a Player who does not exist would let a ghost slip past
 * this gate on its way to that one. Both refusals are reached in
 * `refuseEligibilityChange`, in an order that file states.
 */
export function pooledAmong(
	candidates: readonly EligibilityCandidate[],
	ids: readonly string[]
): readonly string[] {
	const submitted = new Set(ids);
	const pooled: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.pooled) continue;
		if (!submitted.has(candidate.fantraxPlayerId)) continue;
		if (seen.has(candidate.fantraxPlayerId)) continue;
		seen.add(candidate.fantraxPlayerId);
		pooled.push(candidate.fantraxPlayerId);
	}
	return pooled;
}

/**
 * Why the Free Agent pool is not listed on the surface outside Setup.
 *
 * The page hides what it knows the transaction would refuse, and then SAYS
 * it does — a list that silently shrank from 1,467 rows to 306 between two
 * phases would read as data loss. EXPERIENCE.md's voice rule cuts both ways:
 * where a control has a non-obvious rules consequence, say it; where a
 * control is ABSENT for a rules reason, say that too.
 */
export function eligibilityPoolWithheldSentence(phase: string, pooledCount: number): string {
	return (
		`The phase is ${phase}, not Setup, so the Free Agent pool is not listed: ` +
		`${pooledCount === 1 ? 'its one Player has' : `its ${pooledCount} Players have`} ` +
		'Minor League Eligibility bound to cap arithmetic under FR-35 by every open ' +
		'Auction, and changing it now would restate bids already placed. Every rostered ' +
		'Contract is listed and can still be changed: a Contract on a Roster has no open ' +
		'Auction, so no Team’s Committed Bids, Minors Exposure, Available Cap Space or ' +
		'Maximum Bid moves when its flag does.'
	);
}

// --- The four refusals ------------------------------------------------------

/**
 * Why an eligibility change was refused.
 *
 * `phase` and `unknown_players` are re-derived INSIDE the transaction, from
 * the log and the live candidate set respectively. The other three are decided by the
 * route before the transaction opens: `empty_selection` because there is
 * nothing to decide about, `unstated_direction` because which way the change
 * was meant is unknowable from the submission, and `unbound_actor` because
 * `auction_events.manager_id`/`team_id` are NOT NULL (AD-4) so an unbound
 * actor has no event to append. All five are worded here anyway, so the
 * route never words a refusal itself.
 */
export type EligibilityRefusal =
	| {
			readonly kind: 'phase';
			readonly phase: string;
			/** The POOLED Players that caused it, by id. Never the whole submission. */
			readonly fantraxPlayerIds: readonly string[];
	  }
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
 * The `phase` sentence carries four facts because all four are load-bearing:
 * the phase that was folded, WHICH Players it refused and that they are
 * refused *because they are in the pool*, WHY a pooled Player cannot be
 * changed after open (FR-35 — the flag is an input to cap arithmetic on every
 * open Auction for that Player), and that the same submission WOULD be
 * accepted for a rostered Contract. That last clause is the whole reason the
 * gate narrowed: a Commissioner refused here can act on the rostered half
 * immediately, and telling them so is the difference between a gate and a
 * dead end.
 */
export function eligibilityRefusalDetail(refusal: EligibilityRefusal): string {
	switch (refusal.kind) {
		case 'phase':
			return (
				`The change was refused: the phase is ${refusal.phase}, not Setup, and ` +
				`${refusal.fantraxPlayerIds.length === 1 ? 'this Player is' : 'these Players are'} ` +
				`in the Free Agent pool: ${refusal.fantraxPlayerIds.join(', ')}. Minor League ` +
				'Eligibility is an input to cap arithmetic under FR-35 for every open Auction ' +
				'on a pooled Player, so changing it after the auction opens would restate bids ' +
				'already placed. A rostered Contract has no open Auction and no such input, and ' +
				'the same submission is accepted for one in any phase. The phase was folded ' +
				'from the event log inside this transaction.'
			);
		case 'unknown_players':
			return (
				'The change was refused: no Player in the Free Agent pool and no rostered ' +
				`Contract carries ${refusal.fantraxPlayerIds.length === 1 ? 'this Fantrax id' : 'these Fantrax ids'}: ` +
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
