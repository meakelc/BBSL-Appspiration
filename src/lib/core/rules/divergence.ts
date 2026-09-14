/**
 * Comparing the app's Existing Contracts against what Fantrax says, and
 * turning the difference into PROPOSALS (Story 7.9, FR-42).
 *
 * **This declares no command and no gate set, and that absence is the design.**
 * Every other module in `core/rules/` evaluates an act: a Bid, a close, a
 * Trade, a Drop. A divergence is not an act and not a rule — it is a reading of
 * a third-party system, it authorises nothing, and it passes no gate. So the
 * proposal types are declared here beside the comparison rather than in
 * `core/types.ts`'s command block, and nothing in this file appends, decides or
 * permits anything.
 *
 * **A proposal is a LINK, and that is the story's largest saving.**
 * `/roster-trade` reads its whole selection off `url.searchParams` — `from`,
 * `to`, repeated `send`, repeated `recv` — and `/roster-drop` reads `team` and
 * repeated `drop`. The only POST field either takes is the override reason. So
 * a proposal needs no new form, no new sheet and no new write path: it builds a
 * query string, and the existing Story 7.7 and 7.8 routes do the rest, their
 * three guards and their mandatory reason included. Nothing here writes a
 * Trade, a Drop or an event, and nothing here can.
 *
 * **Membership is the only fact compared.** A Slot kind arrives on both sides
 * and is never looked at: a placement difference is the expected state between
 * a Roster Move and the next Fantrax export, not drift, and raising it would
 * report the app working correctly as a fault.
 *
 * **Pairing is grouping, not matching.** A movement is directly observable —
 * the app says P is on A, Fantrax says P is on B — so no reverse movement has
 * to be found for it to be a Trade. Every movement is grouped by unordered Team
 * pair, giving one proposal per pair, and a one-directional gift is a Trade
 * with an empty side, which `/roster-trade` already accepts. A departure is a
 * Drop only when the Player is on NO Fantrax roster at all.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative `.ts` imports only so Deno can load it (AD-2). The instant and
 * the volume fraction both arrive as PARAMETERS — nothing here reads a clock, a
 * network or a configuration.
 */

import { hash } from '../hash.ts';
import { contractForPlayer } from '../projection/contracts.ts';
import type { AuctionContracts } from '../projection/contracts.ts';
import type { RosterSlotKind } from '../types.ts';

// --- What the comparison is given -------------------------------------------

/**
 * One of the app's Teams, and the Fantrax roster it is bound to.
 *
 * `fantraxTeamId` is `null` until it is seeded, and a `null` is NOT a
 * fallback to matching on `teamName` (AD-24). `server/team-registry.ts`'s
 * `resolveTeamByFileName` is the app's one name-based match and it is the
 * IMPORT path; reusing it here would mean a Team renamed in Fantrax reads as
 * its whole roster departing and its whole roster arriving, at once. A Team
 * with no id makes the detector NOT CONFIGURED, which renders like *stopped*
 * and never like *no divergences*.
 */
export type DivergenceTeam = {
	readonly teamId: string;
	readonly teamName: string;
	readonly fantraxTeamId: string | null;
};

/** One row of `team_rosters`, as the comparison needs it. */
export type AppRosterMember = {
	readonly teamId: string;
	/**
	 * The CANONICAL id, produced by the shell through
	 * `adapters/fantrax`'s `normaliseFantraxPlayerId`. This module compares on
	 * it and never derives it — the shape of a Fantrax id is a fact about
	 * Fantrax and does not belong in the pure core (AD-24).
	 */
	readonly playerId: string;
	/**
	 * The id EXACTLY as `team_rosters` stores it — `*04ewu*`, asterisks
	 * included. Carried verbatim BESIDE the canonical form rather than
	 * reconstructed from it, because it is what a pre-filled `/roster-trade` or
	 * `/roster-drop` link must name for the existing route to find the row.
	 */
	readonly fantraxPlayerId: string;
	readonly playerName: string;
	/** Advisory. Nothing in this file reads it — see the module header. */
	readonly rosterSlotKind: RosterSlotKind;
};

/** One row of a Fantrax roster, keyed by the Fantrax team id. */
export type FantraxMember = {
	readonly fantraxTeamId: string;
	/** Already canonical, exactly as `AppRosterMember.playerId` is. */
	readonly playerId: string;
	readonly playerName: string;
	/** Advisory. Nothing in this file reads it. */
	readonly rosterSlotKind: RosterSlotKind;
};

/** Everything one comparison is given. No clock, no network, no configuration. */
export type DivergenceInput = {
	readonly teams: readonly DivergenceTeam[];
	readonly appMembers: readonly AppRosterMember[];
	readonly fantraxMembers: readonly FantraxMember[];
	/**
	 * Every Fantrax team id the payload COVERED, whether or not it carried any
	 * rows.
	 *
	 * **Separate from `fantraxMembers`, and the separation is the whole of the
	 * guard's second half.** A Team that came back with an empty roster and a
	 * Team that was absent from the answer entirely are indistinguishable in a
	 * flat list of members — both contribute nothing — and they are different
	 * faults: one says Fantrax forgot a Team, the other says Fantrax thinks a
	 * Team has nobody. Folding them together would report one as the other, and
	 * an empty roster is the more dangerous of the two because it manufactures a
	 * Drop of every Player on it.
	 */
	readonly fantraxTeamIds: readonly string[];
	/**
	 * The Auction Contracts folded from the log. A non-null
	 * `contractForPlayer` IS "won in this auction", and a won Player is
	 * excluded from BOTH sides: the app holds him because the auction put him
	 * there, and Fantrax has not been told yet, so he is neither a departure
	 * nor an arrival.
	 */
	readonly contracts: AuctionContracts;
	/**
	 * Each `contracts.byPlayer` key paired with its CANONICAL form, as
	 * `[key, canonical]` entries.
	 *
	 * **The fold's keys are the asterisk-wrapped ids the close recorded**, and
	 * this module may not know that — so the shell canonicalises them with the
	 * same function it applies to both membership sides and hands the mapping in.
	 * A key absent from this list is compared as-is, which is the honest
	 * behaviour for an id nobody claimed needed normalising.
	 */
	readonly canonicalContractIds: ReadonlyArray<readonly [string, string]>;
	/**
	 * The share of the League one pass may touch before the plausibility guard
	 * trips. A PARAMETER, never read from configuration here —
	 * `core/constants.ts`'s `DIVERGENCE_VOLUME_FRACTION` is the default and the
	 * shell may override it, but this function is handed the effective number.
	 */
	readonly volumeFraction: number;
	/** Fingerprints the Commissioner has dismissed or acknowledged. */
	readonly dismissedFingerprints: readonly string[];
};

// --- What the comparison produces -------------------------------------------

/** A Team, as a proposal names it. */
export type DivergenceTeamRef = {
	readonly teamId: string;
	readonly teamName: string;
};

/** One Player inside a proposal. */
export type DivergencePlayer = {
	/** The canonical id both sides were compared on. */
	readonly playerId: string;
	/** The stored id the pre-filled link names. */
	readonly fantraxPlayerId: string;
	readonly playerName: string;
};

/**
 * One proposed Roster Trade: a Team pair, and every Player the app holds on
 * the wrong side of it.
 *
 * `sending` are the Players the app holds on `fromTeam` that Fantrax puts on
 * `toTeam`; `receiving` are the mirror. Either may be empty — a one-directional
 * gift is a Trade with an empty side, and `/roster-trade` accepts that.
 */
export type ProposedTrade = {
	readonly kind: 'trade';
	readonly fingerprint: string;
	readonly fromTeam: DivergenceTeamRef;
	readonly toTeam: DivergenceTeamRef;
	readonly sending: readonly DivergencePlayer[];
	readonly receiving: readonly DivergencePlayer[];
	/** `/roster-trade?from=…&to=…&send=…&recv=…`, pre-filled. */
	readonly href: string;
	readonly sentence: string;
};

/** One proposed Drop: a Team, and every Player of its the app holds and Fantrax does not. */
export type ProposedDrop = {
	readonly kind: 'drop';
	readonly fingerprint: string;
	readonly team: DivergenceTeamRef;
	readonly players: readonly DivergencePlayer[];
	/** `/roster-drop?team=…&drop=…`, pre-filled. */
	readonly href: string;
	readonly sentence: string;
};

export type DivergenceProposal = ProposedTrade | ProposedDrop;

/**
 * A Player on a Fantrax roster the app holds nowhere and who has no Auction
 * Contract.
 *
 * **An ERROR, never a proposal.** There is no act that fixes this: the app
 * cannot invent a Contract it has no money, length or provenance for. It means
 * the league id is wrong, the period is wrong, or somebody added a Player out
 * of band — all three are faults a human resolves outside the app, and
 * offering a control would imply otherwise.
 */
export type UnknownArrival = {
	readonly playerId: string;
	readonly playerName: string;
	readonly fantraxTeamId: string;
	readonly teamName: string;
};

/** Why the plausibility guard tripped. One code per reason, for the wording. */
export type GuardTripReason = 'missing_teams' | 'empty_roster' | 'volume';

/**
 * The plausibility guard's verdict.
 *
 * **It never clears itself.** A tripped guard stays tripped on every reload
 * until the Commissioner acknowledges it, and acknowledging REVEALS the
 * proposals rather than discarding them — because the guard's claim is "this
 * payload is probably not real", and a human is the only thing that can settle
 * that. The acknowledgement is a dismissal of `fingerprint`, which is derived
 * from the trip's content alone: a different implausible payload is a
 * different fingerprint and trips again.
 */
export type GuardVerdict =
	| { readonly tripped: false }
	| {
			readonly tripped: true;
			readonly reason: GuardTripReason;
			readonly fingerprint: string;
			readonly acknowledged: boolean;
			readonly detail: string;
	  };

/**
 * Everything one comparison produced.
 *
 * `unmappedTeamNames` non-empty is NOT CONFIGURED and nothing is raised. A
 * tripped, unacknowledged guard suppresses every proposal and states how many
 * it is holding back. Neither state may ever be rendered as *no divergences* —
 * `core/freshness.ts` is this codebase's precedent for a surface that states a
 * pipe is down rather than showing nothing, and the surface words this the same
 * way.
 */
export type DivergenceReport = {
	/** Teams with no Fantrax team id, by NAME — never counted (import-status.ts). */
	readonly unmappedTeamNames: readonly string[];
	/**
	 * Fantrax team ids in the payload that no Team claims, which is the other
	 * half of the same configuration fault.
	 */
	readonly unclaimedFantraxTeamIds: readonly string[];
	readonly configured: boolean;
	readonly guard: GuardVerdict;
	/** Raised, in order. Empty while a guard is tripped and unacknowledged. */
	readonly proposals: readonly DivergenceProposal[];
	/** How many proposals a tripped guard is holding back. */
	readonly suppressedCount: number;
	/** How many proposals a dismissal suppressed. Counted, because they are not news. */
	readonly dismissedCount: number;
	readonly arrivals: readonly UnknownArrival[];
	/** True only when everything ran and there is genuinely nothing to report. */
	readonly clean: boolean;
};

// --- The wording ------------------------------------------------------------
//
// Worded HERE, for `core/freshness.ts`'s reason: two copies of a sentence are
// two sources and they drift the first time one is edited. No route and no
// component words any of this.

/** The heading over a tripped guard, per reason. */
export const GUARD_HEADINGS: Readonly<Record<GuardTripReason, string>> = Object.freeze({
	missing_teams: 'This read did not cover the whole League',
	empty_roster: 'This read returned an empty roster',
	volume: 'This read moved too much of the League at once'
});

/** What a tripped guard MEANS, in the product voice: the fact, then what it changes. */
export const GUARD_STATEMENTS: Readonly<Record<GuardTripReason, string>> = Object.freeze({
	missing_teams:
		'Fantrax answered without every Team in it, so anything missing from the answer would ' +
		'read as a Player leaving the League. Nothing is proposed from this read.',
	empty_roster:
		'Fantrax answered with a Team holding nobody at all, which no real roster does. ' +
		'Nothing is proposed from this read.',
	volume:
		'This read would move more of the League at once than an offseason day plausibly ' +
		'does. A mis-set league id, a wrong period or a Fantrax outage all look exactly like ' +
		'this, so nothing is proposed from it.'
});

/** The one sentence a not-configured surface leads with. */
export const NOT_CONFIGURED_HEADING = 'Not configured';

/**
 * The genuinely-empty state, stated as a sentence rather than a blank list —
 * `routes/assignment-monitoring/+page.svelte:121-126`'s discipline.
 *
 * **It is the ONLY string in this module containing the words "no
 * divergences", and that is deliberate.** Every other state — stopped, not
 * configured, tripped — words itself differently on purpose, so that a
 * Commissioner can never read a failure as a clean read.
 * `tests/routes/divergence.test.ts` asserts the distinctness rather than
 * trusting it.
 */
/**
 * What a dismissed DIVERGENCE is told: it stays out of the way, and the content
 * changing is what brings it back.
 */
export const DIVERGENCE_DISMISSED_NOTICE =
	'Dismissed. It stays out of the way until its content changes — a different Player, ' +
	'a different Team or a different direction is a different divergence and raises again ' +
	'by itself.';

/**
 * What an acknowledged GUARD is told, and it is the OPPOSITE fact: nothing went
 * away, and the proposals the guard was holding back are now shown.
 *
 * Two sentences rather than one, because the two acts write the same row and
 * mean opposite things to the person who clicked. One notice for both told a
 * Commissioner the thing "stays out of the way" at the exact moment the
 * proposals became visible.
 */
export const GUARD_ACKNOWLEDGED_NOTICE =
	'Acknowledged. The proposals this read produced are now shown below — acknowledging ' +
	'revealed them rather than discarding them, and each still opens the existing act and ' +
	'still demands its own reason.';

export const NO_DIVERGENCES_STATEMENT =
	'This read found no divergences: every Player the app holds is on the same Fantrax ' +
	'roster, and every Player on a Fantrax roster is one the app knows about.';

// --- The comparison ---------------------------------------------------------

/**
 * The byte joined between fingerprint parts, and between the two team ids of a
 * pair key.
 *
 * U+001F INFORMATION SEPARATOR ONE, which cannot occur in a Team id, a Fantrax
 * player id or anything else joined here — so no two different contents can
 * ever render to the same joined string and collide into one fingerprint. A
 * comma or a pipe could: a Player id containing one would make two distinct
 * divergences indistinguishable, and a dismissal of one would silently
 * suppress the other.
 *
 * Built with `String.fromCharCode` rather than written as a literal, because a
 * raw control byte in a source file is invisible in every editor and diff — it
 * would survive a copy that dropped it and change every fingerprint in the
 * table silently, un-dismissing everything at once.
 */
const FINGERPRINT_SEPARATOR = String.fromCharCode(31);

/** Sort helper — explicit ordering everywhere, never incidental (AD-1, AD-5). */
function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** `Object.prototype.hasOwnProperty`, called against a record whose keys are data. */
function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * The set of ids that carry an Auction Contract.
 *
 * **Keyed on `DivergenceInput.wonPlayerIds`, not on the fold's own keys.** The
 * contracts fold is keyed on whatever id the close recorded, which came from
 * the pool import and is therefore the asterisk-wrapped form — and this module
 * is forbidden from knowing that, because the shape of a Fantrax id is a fact
 * about Fantrax and lives in `adapters/fantrax/` (AD-24). The shell
 * canonicalises those keys before they arrive, exactly as it canonicalises both
 * membership sides, so this function only has to answer which of them is a
 * genuine contract.
 */
function wonPlayerIds(contracts: AuctionContracts, canonicalByKey: ReadonlyMap<string, string>): ReadonlySet<string> {
	const won = new Set<string>();
	for (const key of Object.keys(contracts.byPlayer).sort()) {
		if (!hasOwn(contracts.byPlayer, key)) continue;
		if (contractForPlayer(contracts, key) === null) continue;
		won.add(canonicalByKey.get(key) ?? key);
	}
	return won;
}

/** `/roster-trade?from=…&to=…&send=…&recv=…` — the Story 7.7 route, pre-filled. */
export function tradeHref(input: {
	readonly fromTeamId: string;
	readonly toTeamId: string;
	readonly sendingPlayerIds: readonly string[];
	readonly receivingPlayerIds: readonly string[];
}): string {
	const parts: string[] = [
		`from=${encodeURIComponent(input.fromTeamId)}`,
		`to=${encodeURIComponent(input.toTeamId)}`
	];
	// Sorted, so the same divergence always builds the same URL — the route
	// itself sorts what it reads for AD-5's reason, and a proposal that did not
	// would produce two spellings of one act.
	for (const id of [...input.sendingPlayerIds].sort(compareText)) {
		parts.push(`send=${encodeURIComponent(id)}`);
	}
	for (const id of [...input.receivingPlayerIds].sort(compareText)) {
		parts.push(`recv=${encodeURIComponent(id)}`);
	}
	return `/roster-trade?${parts.join('&')}`;
}

/** `/roster-drop?team=…&drop=…` — the Story 7.8 route, pre-filled. */
export function dropHref(input: {
	readonly teamId: string;
	readonly fantraxPlayerIds: readonly string[];
}): string {
	const parts: string[] = [`team=${encodeURIComponent(input.teamId)}`];
	for (const id of [...input.fantraxPlayerIds].sort(compareText)) {
		parts.push(`drop=${encodeURIComponent(id)}`);
	}
	return `/roster-drop?${parts.join('&')}`;
}

/**
 * A stable fingerprint over a divergence's CONTENT and nothing else.
 *
 * No row id, no timestamp, no read: that is exactly what makes "dismissed
 * stays dismissed until it changes" a property of the data rather than of a
 * policy, and what makes a re-read of an unchanged league produce the same
 * fingerprint an hour later. Every id inside is the CANONICAL one, so the
 * fingerprint cannot change because the same Player arrived in a different
 * spelling.
 *
 * `hash` is `core/hash.ts`'s SHA-256 — already in this codebase, already
 * proven against FIPS 180-4's vectors, and pure, which a fingerprint computed
 * inside a synchronous comparison has to be.
 */
export function fingerprintOf(parts: readonly string[]): string {
	return hash(parts.join(FINGERPRINT_SEPARATOR));
}

/** One player, rendered into the fingerprint. Canonical id only. */
function playerFingerprintPart(players: readonly DivergencePlayer[]): string {
	return [...players.map((player) => player.playerId)].sort(compareText).join(FINGERPRINT_SEPARATOR);
}

function nameList(names: readonly string[]): string {
	if (names.length === 0) return '';
	if (names.length === 1) return names[0] ?? '';
	const head = names.slice(0, -1).join(', ');
	return `${head} and ${names[names.length - 1] ?? ''}`;
}

/**
 * Compare the app's membership against Fantrax's, and produce proposals.
 *
 * Pure and total: every input shape produces a `DivergenceReport`, and nothing
 * here throws. Order is explicit at every step (AD-5) — a report is
 * fingerprinted, and a fingerprint over an incidental order is not one.
 */
export function compareMembership(input: DivergenceInput): DivergenceReport {
	// 1. The explicit Team map, both ways. A Team with no id, and a Fantrax
	//    roster no Team claims, are the same configuration fault seen from two
	//    sides; both are NAMED and neither is counted.
	const teamByFantraxId = new Map<string, DivergenceTeam>();
	const unmappedTeamNames: string[] = [];
	for (const team of [...input.teams].sort((left, right) => compareText(left.teamId, right.teamId))) {
		if (team.fantraxTeamId === null || team.fantraxTeamId.trim() === '') {
			unmappedTeamNames.push(team.teamName);
			continue;
		}
		teamByFantraxId.set(team.fantraxTeamId, team);
	}

	const seenFantraxTeamIds = new Set<string>(input.fantraxTeamIds);
	// A member whose team id was not listed still counts as covered: the payload
	// plainly contained it, and refusing to notice would be a third answer to a
	// question with two.
	for (const member of input.fantraxMembers) seenFantraxTeamIds.add(member.fantraxTeamId);
	const unclaimedFantraxTeamIds = [...seenFantraxTeamIds]
		.filter((id) => !teamByFantraxId.has(id))
		.sort(compareText);

	const configured = unmappedTeamNames.length === 0 && unclaimedFantraxTeamIds.length === 0;

	const teamById = new Map<string, DivergenceTeam>();
	for (const team of input.teams) teamById.set(team.teamId, team);

	const empty: DivergenceReport = {
		unmappedTeamNames: [...unmappedTeamNames].sort(compareText),
		unclaimedFantraxTeamIds,
		configured,
		guard: { tripped: false },
		proposals: [],
		suppressedCount: 0,
		dismissedCount: 0,
		arrivals: [],
		clean: false
	};

	// **Not configured raises NOTHING.** Half a Team map produces a comparison
	// in which every unmapped Team's whole roster reads as departed, which is
	// the silent-total-failure shape this story exists to prevent.
	if (!configured) return empty;

	const won = wonPlayerIds(input.contracts, new Map(input.canonicalContractIds));

	// 2. Where Fantrax says each Player is. Canonicalised again here rather than
	//    trusted from the caller: this function is the one place both sides meet,
	//    so it is the one place that can guarantee they meet in one form.
	const fantraxLocation = new Map<string, { team: DivergenceTeam; member: FantraxMember }>();
	for (const member of input.fantraxMembers) {
		const team = teamByFantraxId.get(member.fantraxTeamId);
		if (team === undefined) continue;
		// Already canonical. This module normalises NOTHING — see `DivergenceInput`.
		fantraxLocation.set(member.playerId, { team, member });
	}

	// 3. Classify every Player the app holds.
	type Movement = { readonly from: DivergenceTeam; readonly to: DivergenceTeam; readonly player: DivergencePlayer };
	const movements: Movement[] = [];
	const departuresByTeam = new Map<string, DivergencePlayer[]>();
	const appPlayerIds = new Set<string>();

	const appMembers = [...input.appMembers].sort((left, right) =>
		compareText(left.fantraxPlayerId, right.fantraxPlayerId)
	);

	for (const member of appMembers) {
		// Already canonical, supplied beside the verbatim stored id by the shell.
		const playerId = member.playerId;
		appPlayerIds.add(playerId);

		// A Player won in THIS auction is excluded from both sides: the app holds
		// him because the auction put him there, Fantrax has not been told, and
		// neither "departure" nor "arrival" is a true description of that.
		if (won.has(playerId)) continue;

		const appTeam = teamById.get(member.teamId);
		if (appTeam === undefined) continue;

		const player: DivergencePlayer = {
			playerId,
			fantraxPlayerId: member.fantraxPlayerId,
			playerName: member.playerName
		};

		const located = fantraxLocation.get(playerId);
		if (located === undefined) {
			// On NO Fantrax roster at all. That, and only that, is a Drop.
			const existing = departuresByTeam.get(appTeam.teamId);
			if (existing === undefined) departuresByTeam.set(appTeam.teamId, [player]);
			else existing.push(player);
			continue;
		}

		// Same Team: unchanged. The Slot kind may differ and is NOT compared —
		// a placement difference is the expected state between a Roster Move and
		// the next export.
		if (located.team.teamId === appTeam.teamId) continue;

		movements.push({ from: appTeam, to: located.team, player });
	}

	// 4. Everything on a Fantrax roster the app holds nowhere and that carries no
	//    Auction Contract is an unknown ARRIVAL — an error, never a proposal.
	const arrivals: UnknownArrival[] = [];
	for (const member of input.fantraxMembers) {
		const playerId = member.playerId;
		if (appPlayerIds.has(playerId)) continue;
		if (won.has(playerId)) continue;
		const team = teamByFantraxId.get(member.fantraxTeamId);
		if (team === undefined) continue;
		arrivals.push({
			playerId,
			playerName: member.playerName,
			fantraxTeamId: member.fantraxTeamId,
			teamName: team.teamName
		});
	}
	arrivals.sort((left, right) => compareText(left.playerId, right.playerId));

	// 5. Group every movement by UNORDERED Team pair — one proposal per pair.
	//    No reverse movement has to be found: a movement is directly observed,
	//    and a one-directional gift is a Trade with an empty side.
	type Pair = {
		readonly fromTeam: DivergenceTeam;
		readonly toTeam: DivergenceTeam;
		readonly sending: DivergencePlayer[];
		readonly receiving: DivergencePlayer[];
	};
	const pairs = new Map<string, Pair>();
	for (const movement of movements) {
		// The pair is keyed on the two team ids SORTED, so A→B and B→A land in
		// one group. `fromTeam` is then always the lower id, which is what makes
		// the fingerprint and the URL stable whichever direction was seen first.
		const [lowId, highId] = [movement.from.teamId, movement.to.teamId].sort(compareText);
		const key = `${String(lowId)}${FINGERPRINT_SEPARATOR}${String(highId)}`;
		let pair = pairs.get(key);
		if (pair === undefined) {
			const low = teamById.get(String(lowId));
			const high = teamById.get(String(highId));
			if (low === undefined || high === undefined) continue;
			pair = { fromTeam: low, toTeam: high, sending: [], receiving: [] };
			pairs.set(key, pair);
		}
		if (movement.from.teamId === pair.fromTeam.teamId) pair.sending.push(movement.player);
		else pair.receiving.push(movement.player);
	}

	const proposals: DivergenceProposal[] = [];

	for (const key of [...pairs.keys()].sort(compareText)) {
		const pair = pairs.get(key);
		if (pair === undefined) continue;
		const sending = [...pair.sending].sort((left, right) => compareText(left.playerId, right.playerId));
		const receiving = [...pair.receiving].sort((left, right) =>
			compareText(left.playerId, right.playerId)
		);
		const fromTeam: DivergenceTeamRef = {
			teamId: pair.fromTeam.teamId,
			teamName: pair.fromTeam.teamName
		};
		const toTeam: DivergenceTeamRef = { teamId: pair.toTeam.teamId, teamName: pair.toTeam.teamName };
		proposals.push({
			kind: 'trade',
			fingerprint: fingerprintOf([
				'trade',
				fromTeam.teamId,
				toTeam.teamId,
				playerFingerprintPart(sending),
				playerFingerprintPart(receiving)
			]),
			fromTeam,
			toTeam,
			sending,
			receiving,
			href: tradeHref({
				fromTeamId: fromTeam.teamId,
				toTeamId: toTeam.teamId,
				sendingPlayerIds: sending.map((player) => player.fantraxPlayerId),
				receivingPlayerIds: receiving.map((player) => player.fantraxPlayerId)
			}),
			sentence: tradeSentence(fromTeam, toTeam, sending, receiving)
		});
	}

	for (const teamId of [...departuresByTeam.keys()].sort(compareText)) {
		const players = (departuresByTeam.get(teamId) ?? [])
			.slice()
			.sort((left, right) => compareText(left.playerId, right.playerId));
		const team = teamById.get(teamId);
		if (team === undefined || players.length === 0) continue;
		const teamRef: DivergenceTeamRef = { teamId: team.teamId, teamName: team.teamName };
		proposals.push({
			kind: 'drop',
			fingerprint: fingerprintOf(['drop', teamRef.teamId, playerFingerprintPart(players)]),
			team: teamRef,
			players,
			href: dropHref({
				teamId: teamRef.teamId,
				fantraxPlayerIds: players.map((player) => player.fantraxPlayerId)
			}),
			sentence: dropSentence(teamRef, players)
		});
	}

	// 6. The plausibility guard. Both halves, in the order a human would ask
	//    them: did we get the whole League, did any Team come back empty, and is
	//    the amount of change believable.
	const mappedTeamCount = teamByFantraxId.size;
	const guard = evaluateGuard({
		mappedTeams: [...teamByFantraxId.values()],
		seenFantraxTeamIds,
		fantraxMembers: input.fantraxMembers,
		proposals,
		arrivals,
		mappedTeamCount,
		volumeFraction: input.volumeFraction,
		dismissedFingerprints: input.dismissedFingerprints
	});

	// 7. Dismissals, applied last, so a dismissed divergence is still counted in
	//    the guard's volume: a Commissioner who dismissed three proposals last
	//    hour must not thereby lower the bar for the fourth.
	const dismissed = new Set(input.dismissedFingerprints);
	const raised = proposals.filter((proposal) => !dismissed.has(proposal.fingerprint));
	const dismissedCount = proposals.length - raised.length;

	const suppressing = guard.tripped && !guard.acknowledged;

	return {
		unmappedTeamNames: [],
		unclaimedFantraxTeamIds: [],
		configured: true,
		guard,
		proposals: suppressing ? [] : raised,
		suppressedCount: suppressing ? raised.length : 0,
		dismissedCount,
		arrivals: suppressing ? [] : arrivals,
		clean: !guard.tripped && raised.length === 0 && arrivals.length === 0 && dismissedCount === 0
	};
}

/**
 * The plausibility guard, entire.
 *
 * Three refusals, each about a different way a payload can be unreal, and each
 * reported with its own fingerprint so that acknowledging one implausible read
 * does not acknowledge the next.
 */
function evaluateGuard(input: {
	readonly mappedTeams: readonly DivergenceTeam[];
	readonly seenFantraxTeamIds: ReadonlySet<string>;
	readonly fantraxMembers: readonly FantraxMember[];
	readonly proposals: readonly DivergenceProposal[];
	readonly arrivals: readonly UnknownArrival[];
	readonly mappedTeamCount: number;
	readonly volumeFraction: number;
	readonly dismissedFingerprints: readonly string[];
}): GuardVerdict {
	const dismissed = new Set(input.dismissedFingerprints);

	// (a) Every mapped Team must be in the payload. A Team missing from the
	//     answer would otherwise read as its whole roster leaving the League.
	const missing = input.mappedTeams
		.filter((team) => team.fantraxTeamId !== null && !input.seenFantraxTeamIds.has(team.fantraxTeamId))
		.map((team) => team.teamName)
		.sort(compareText);
	if (missing.length > 0) {
		const fingerprint = fingerprintOf(['guard', 'missing_teams', missing.join(FINGERPRINT_SEPARATOR)]);
		return {
			tripped: true,
			reason: 'missing_teams',
			fingerprint,
			acknowledged: dismissed.has(fingerprint),
			detail: `Fantrax returned no roster for ${nameList(missing)}.`
		};
	}

	// (b) No mapped Team may come back holding nobody. No real roster is empty,
	//     and an empty one manufactures a Drop of every Player on it.
	const countByFantraxTeam = new Map<string, number>();
	for (const member of input.fantraxMembers) {
		countByFantraxTeam.set(member.fantraxTeamId, (countByFantraxTeam.get(member.fantraxTeamId) ?? 0) + 1);
	}
	const emptyTeams = input.mappedTeams
		.filter((team) => team.fantraxTeamId !== null && (countByFantraxTeam.get(team.fantraxTeamId) ?? 0) === 0)
		.map((team) => team.teamName)
		.sort(compareText);
	if (emptyTeams.length > 0) {
		const fingerprint = fingerprintOf(['guard', 'empty_roster', emptyTeams.join(FINGERPRINT_SEPARATOR)]);
		return {
			tripped: true,
			reason: 'empty_roster',
			fingerprint,
			acknowledged: dismissed.has(fingerprint),
			detail: `Fantrax returned an empty roster for ${nameList(emptyTeams)}.`
		};
	}

	// (c) Volume. Counted in TEAMS TOUCHED rather than in Players, because the
	//     unit FR-42 names is "a quarter of the League" and the League is
	//     thirty Teams — a single Team rebuilt from scratch is one Team's
	//     problem however many Players it moves, while eight Teams changing at
	//     once between two hourly reads is the shape of a wrong league id.
	const touched = new Set<string>();
	for (const proposal of input.proposals) {
		if (proposal.kind === 'trade') {
			touched.add(proposal.fromTeam.teamId);
			touched.add(proposal.toTeam.teamId);
		} else {
			touched.add(proposal.team.teamId);
		}
	}
	if (input.mappedTeamCount > 0 && touched.size > input.mappedTeamCount * input.volumeFraction) {
		const names = [...touched].sort(compareText);
		const fingerprint = fingerprintOf(['guard', 'volume', names.join(FINGERPRINT_SEPARATOR)]);
		return {
			tripped: true,
			reason: 'volume',
			fingerprint,
			acknowledged: dismissed.has(fingerprint),
			detail:
				`This read would change ${String(touched.size)} of ${String(input.mappedTeamCount)} Teams at once.`
		};
	}

	return { tripped: false };
}

/** One Trade proposal, as one sentence. Named Players, never counted. */
function tradeSentence(
	fromTeam: DivergenceTeamRef,
	toTeam: DivergenceTeamRef,
	sending: readonly DivergencePlayer[],
	receiving: readonly DivergencePlayer[]
): string {
	const out = nameList(sending.map((player) => player.playerName));
	const back = nameList(receiving.map((player) => player.playerName));
	if (sending.length > 0 && receiving.length > 0) {
		return `Fantrax has ${out} on ${toTeam.teamName} and ${back} on ${fromTeam.teamName}; the app has them the other way round.`;
	}
	if (sending.length > 0) {
		return `Fantrax has ${out} on ${toTeam.teamName}; the app still charges ${fromTeam.teamName}.`;
	}
	return `Fantrax has ${back} on ${fromTeam.teamName}; the app still charges ${toTeam.teamName}.`;
}

/** One Drop proposal, as one sentence. */
function dropSentence(team: DivergenceTeamRef, players: readonly DivergencePlayer[]): string {
	const names = nameList(players.map((player) => player.playerName));
	return `${names} ${players.length === 1 ? 'is' : 'are'} on no Fantrax roster; the app still charges ${team.teamName}.`;
}
