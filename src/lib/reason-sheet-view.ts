/**
 * The reason sheet, and every word it says (Story 7.1).
 *
 * The sheet is the interstitial that stands between a Commissioner control
 * and a committed override — DESIGN.md:236 counts it as one of the
 * Commissioner class's four properties, and `styles/commissioner.css:23-28`
 * records that Epic 1 shipped the persistent label in its place and left the
 * sheet to this story. It states the act in words, both states side by side,
 * the consequences that are not obvious from those states, and it takes a
 * reason it will not proceed without.
 *
 * **Every sentence lives here, not in `ReasonSheet.svelte`** — the
 * `core/strip.ts` / `PersistentStrip.svelte` precedent. `vite.config.ts` pins
 * `environment: 'node'` and no `.svelte` file renders under the suite, so
 * words asserted in a component are words asserted by reading source text.
 * Words asserted here are called and compared.
 *
 * **It is not in `core/`, and that is deliberate.** This is a rendering of an
 * override into a screen's worth of strings; the override itself, and the
 * rule that it cannot exist without a reason, are the core's
 * (`core/rules/override.ts`). Same split as `destinations-view.ts` against
 * `server/destinations.ts`. Nothing server-only is reachable from here.
 *
 * **Zero call sites.** No override control, route or event exists yet; Story
 * 7.2 renders the first sheet.
 */

import {
	ACTIVE_BENCH_SLOTS,
	INJURY_RESERVE_SLOTS,
	MINOR_LEAGUE_SLOTS
} from './core/constants.ts';
import type {
	RosterActTeamFigures,
	RosterTradeTransfer
} from './core/projection/contracts.ts';
import type { ActCapGateOutcome } from './core/types.ts';
import { OVERRIDE_REASON_FIELD } from './core/rules/override.ts';
import { SLOT_LABELS } from './core/rules/roster-import.ts';
import { describeActAmount } from './core/rules/roster-act.ts';
import { transferAttention } from './core/rules/roster-trade.ts';
import type { RosterTradeDelta } from './core/rules/roster-trade.ts';
import { dropAttention } from './core/rules/roster-drop.ts';
import type { DropRelease, RosterDropDelta } from './core/rules/roster-drop.ts';
import { maximumBidDirectionSentence, moveAttention } from './core/rules/roster-rearrange.ts';
import type {
	MaximumBidPair,
	RearrangeMove,
	RosterRearrangeDelta
} from './core/rules/roster-rearrange.ts';
import { closeReversalAttention } from './core/rules/close-reversal.ts';
import type { CloseReversalDecision, SlotPair } from './core/rules/close-reversal.ts';
import { bidReinstatementAttention } from './core/rules/bid-reinstatement.ts';
import type { BidReinstatementDecision } from './core/rules/bid-reinstatement.ts';
import type { Money } from './core/money.ts';

/**
 * One before→after row, as the caller states it.
 *
 * `before` and `after` arrive already rendered into words — money through
 * `describeAmount` (AD-8), clocks through their own renderer. This module
 * pairs them; it does not format them, because a second money renderer is
 * exactly the divergence AD-8 exists to prevent.
 *
 * `attention` is a sentence, not a flag. A row whose change is obvious from
 * its own before and after carries `null`: the amber marker is the product's
 * single attention colour and it means something, so a sheet that marks every
 * row marks nothing. A row carries a sentence only when a consequence follows
 * that the two states do not show — "this removes the bid's League Clock
 * reset; the Auction Phase will end 5h 47m sooner".
 */
export type ReasonSheetRow = {
	readonly label: string;
	readonly before: string;
	readonly after: string;
	readonly attention: string | null;
};

/** Everything the caller must decide: what the act is, and what it changes. */
export type ReasonSheetInput = {
	/**
	 * The act, as one finished sentence — "Void the leading bid on Jalen
	 * Duren." The sheet never assembles this from parts: an act described by
	 * template is an act described the same way whether or not the template
	 * still fits it.
	 */
	readonly act: string;
	/** The commit control's own words. Never "Confirm" — it names the act. */
	readonly commitLabel: string;
	/** Every value the act changes. May be empty; the rows block then does not render. */
	readonly rows: readonly ReasonSheetRow[];
	/** Where Cancel goes. Always somewhere — leaving the sheet is never a dead end. */
	readonly cancelHref: string;
};

/** One row, paired and ready to render. */
export type ReasonSheetViewRow = {
	/**
	 * This row's identity in the rendered list.
	 *
	 * Derived from the row's POSITION, never from its words. Keying an
	 * `{#each}` on a label or a sentence means two rows that happen to read
	 * the same collide on a duplicate key — and "Leading bid" appearing twice,
	 * or the same consequence sentence attached to two Clocks, is an ordinary
	 * thing for an override to want to say, not a defect to guard against.
	 */
	readonly key: string;
	readonly label: string;
	/** `before → after`, in one string, so the component pairs nothing itself. */
	readonly change: string;
	/** This row's consequence sentence, or `null`. Rendered ON the row. */
	readonly attention: string | null;
};

/**
 * Everything a sheet says EXCEPT the reason field — the shape a Manager's own
 * confirmation sheet reads (Story 7.11, FR-44).
 *
 * **Split out rather than made optional.** FR-44 gives a Manager acting on
 * their own Team a confirmation sheet and NO reason: it is an ordinary
 * strategic decision, not a referee intervention, and UX-DR41 forbids one
 * component with a conditional reason field. A `reasonLabel?: string` would
 * be exactly that conditional, moved into the type — so the Manager variant
 * is a shape that cannot carry a reason at all, and `ReasonSheetView` is this
 * plus the two fields the Commissioner's sheet needs.
 */
export type ConfirmSheetView = {
	readonly title: string;
	readonly act: string;
	readonly rowsHeading: string;
	readonly rows: readonly ReasonSheetViewRow[];
	/**
	 * Every row's consequence sentence, in row order. Empty when none.
	 *
	 * The sheet does NOT render this list — each sentence renders on the row
	 * it belongs to, so the reader can see which value a consequence is
	 * about. This is the same set, flattened, for a caller that needs to ask
	 * "does this act have consequences at all" without walking the rows.
	 */
	readonly attentionNotes: readonly string[];
	readonly cancelLabel: string;
	readonly cancelHref: string;
	readonly commitLabel: string;
	readonly auditFooter: string;
};

/** The whole sheet, in words. */
export type ReasonSheetView = ConfirmSheetView & {
	readonly reasonLabel: string;
	/** The `name` the reason posts under — the guard's field, not a second literal. */
	readonly reasonFieldName: string;
};

/**
 * The sheet's title.
 *
 * The same words on every override in the epic, because the sheet's first job
 * is to say which of the two people using this app is acting. The specific
 * act is the sentence below it.
 */
export const REASON_SHEET_TITLE = 'Commissioner override';

/** The before→after block's own heading. */
export const REASON_SHEET_ROWS_HEADING = 'Before → after';

/**
 * The reason field's label.
 *
 * Three facts, because all three change what gets typed: it is required, it
 * is permanent, and every Manager can read it. A Commissioner who believes
 * the box is a private note writes a different sentence than one who knows
 * the League will read it, and the second sentence is the one worth keeping.
 */
export const REASON_SHEET_FIELD_LABEL = 'Reason — required, permanent, readable by every Manager';

/** The Cancel control's words. Cancel is not a refusal; it is a way back. */
export const REASON_SHEET_CANCEL_LABEL = 'Cancel';

/**
 * The Audit Log footer.
 *
 * States what is written and that it cannot be unwritten — including by the
 * Commissioner, which is the half that matters. The Audit Log's own read
 * surface is Story 7.5; this sentence describes the record, and links to
 * nothing that does not exist yet.
 */
export const REASON_SHEET_AUDIT_FOOTER =
	'Written to the Audit Log with your name, the timestamp, both states and this reason. ' +
	'It cannot be edited or deleted afterwards, by you or anyone.';

/** Pair one row's two states into the single string the sheet shows. */
function change(row: ReasonSheetRow): string {
	return `${row.before} → ${row.after}`;
}

/**
 * A row's consequence sentence, or `null` if it has nothing to say.
 *
 * An empty or whitespace-only `attention` is treated as absent rather than
 * rendered: the amber bar is the product's single attention colour, and a bar
 * with no sentence in it marks a row as consequential while explaining
 * nothing — worse than no marker, because the reader looks for the reason and
 * finds a blank.
 */
function attentionOf(row: ReasonSheetRow): string | null {
	if (row.attention === null) return null;
	return row.attention.trim().length === 0 ? null : row.attention;
}

/**
 * Build the sheet.
 *
 * A pure mapping: the caller supplies the act and what it changes, this
 * supplies every word that is the same on every override. Nothing here knows
 * how the override commits, and nothing here validates the reason — the
 * reason is validated where it can actually be enforced, server-side
 * (`server/override-guard.ts`), over what was submitted rather than over what
 * was rendered.
 */
export function reasonSheetView(input: ReasonSheetInput): ReasonSheetView {
	return {
		...sheetBody(input, REASON_SHEET_TITLE, REASON_SHEET_AUDIT_FOOTER),
		reasonLabel: REASON_SHEET_FIELD_LABEL,
		reasonFieldName: OVERRIDE_REASON_FIELD
	};
}

/**
 * The half both sheets share: the act, the paired rows and the way out.
 *
 * One mapping, called twice, so the Manager's confirmation sheet and the
 * Commissioner's reason sheet cannot pair a before with a different after or
 * key their rows differently. Neither sheet's own words are decided here —
 * the title and the footer arrive from the caller, because they are the two
 * sentences that actually differ.
 */
function sheetBody(input: ReasonSheetInput, title: string, auditFooter: string): ConfirmSheetView {
	const rows = input.rows.map((row, index) => ({
		key: `row-${index}`,
		label: row.label,
		change: change(row),
		attention: attentionOf(row)
	}));
	return {
		title,
		act: input.act,
		rowsHeading: REASON_SHEET_ROWS_HEADING,
		rows,
		attentionNotes: rows
			.map((row) => row.attention)
			.filter((note): note is string => note !== null),
		cancelLabel: REASON_SHEET_CANCEL_LABEL,
		cancelHref: input.cancelHref,
		commitLabel: input.commitLabel,
		auditFooter
	};
}

/**
 * The Manager's own confirmation sheet (Story 7.11, FR-44).
 *
 * **A sheet without a reason is not a weaker override sheet; it is a
 * different object.** A Manager rearranging their own Roster is making an
 * ordinary strategic decision — FR-44 says so in as many words — and asking
 * them to justify it to the League would be the app treating a legal move as
 * an intervention. What it still does is state the act, both states and every
 * consequence the two states do not show, because §10 example 45's Maximum
 * Bid moves in the direction nobody expects.
 *
 * The title says whose act it is, and the footer says the record is
 * league-visible and permanent — which is true of a Manager's Move as much as
 * of a Commissioner's, and is the one thing they might not otherwise expect.
 */
export function confirmSheetView(input: ReasonSheetInput): ConfirmSheetView {
	return sheetBody(input, CONFIRM_SHEET_TITLE, CONFIRM_SHEET_AUDIT_FOOTER);
}

/** The Manager sheet's title. It names the act's owner, not the referee. */
export const CONFIRM_SHEET_TITLE = 'Confirm your Roster Move';

/**
 * The Manager sheet's footer.
 *
 * No reason is asked for, so the footer cannot say "and this reason". What it
 * must still say is that the act is written down, that every Manager can read
 * it, and that it cannot be unwritten — a Manager who believes their own
 * rearrangement is private would be surprised by the Audit Log, and the
 * surprise is avoidable here.
 */
export const CONFIRM_SHEET_AUDIT_FOOTER =
	'Written to the Audit Log with your name, the timestamp and both states. Every Manager can read ' +
	'it, and it cannot be edited or deleted afterwards. The Move itself is reversible: move the ' +
	'Contract back and the roster returns to exactly the state it held.';

// --- Story 7.7: the two-Team Roster Trade sheet ----------------------------

/**
 * A Roster Trade's before → after, as ROWS (Story 7.7, FR-41, UX-DR39).
 *
 * **Rows, not a second component.** `ReasonSheet.svelte` already renders a
 * list of labelled before → after pairs with an optional consequence sentence
 * on each, which is exactly what a two-Team sheet is — one row per figure per
 * Team, labelled with the Team. A parallel two-column component would be a
 * second sheet to keep in step with the first, and the first is the one the
 * repo-wide Commissioner-block guard reads.
 *
 * **Five figures per Team, in FR-41's own order**: Cap Space, Roster Count,
 * and the occupancy of all three Slot kinds. Roster Count and Active/Bench
 * occupancy are the same number by definition (PRD §3) and are both stated
 * anyway, because the requirement names both and a Commissioner checking a
 * trade against Fantrax is reading two different columns there.
 *
 * **The moved Players are named BETWEEN the two Teams**, which is the whole
 * reason the sheet is a list rather than a table: the rows read top to bottom
 * as "this Team, these Players, that Team", and a Player who changes Slot on
 * arrival carries the consequence sentence FR-41 requires in words before
 * commit — a Cap Hit rising from $0 to $18,000,000 by the act of moving is
 * the least obvious thing in this requirement.
 *
 * Every amount arrives through `describeAmount`, the core's one money
 * renderer (AD-8). This module formats nothing itself.
 */
export function teamFigureRows(
	before: RosterActTeamFigures,
	after: RosterActTeamFigures
): readonly ReasonSheetRow[] {
	const label = (figure: string): string => `${after.teamName} · ${figure}`;
	const occupancy = (held: number, ceiling: number): string =>
		`${String(held)} of ${String(ceiling)}`;
	return [
		{
			label: label('Cap Space'),
			// `describeActAmount`, never `describeAmount`: an imported Cap Hit is
			// a real-world salary and the roster importer asserts no money grid
			// over it, so a Team's Cap Space legitimately sits off the $500,000
			// grid — and a sheet that answered "an amount that is not on the grid"
			// would be asking for a commitment against a figure it declines to
			// print.
			before: describeActAmount(before.capSpace),
			after: describeActAmount(after.capSpace),
			attention: null
		},
		{
			label: label('Roster Count'),
			before: String(before.rosterCount),
			after: String(after.rosterCount),
			attention: null
		},
		{
			label: label(SLOT_LABELS.active_bench),
			before: occupancy(before.rosterCount, ACTIVE_BENCH_SLOTS),
			after: occupancy(after.rosterCount, ACTIVE_BENCH_SLOTS),
			attention: null
		},
		{
			label: label(SLOT_LABELS.injury_reserve),
			before: occupancy(before.injuryReserveOccupied, INJURY_RESERVE_SLOTS),
			after: occupancy(after.injuryReserveOccupied, INJURY_RESERVE_SLOTS),
			attention: null
		},
		{
			label: label(SLOT_LABELS.minor_league),
			before: occupancy(before.minorLeagueOccupied, MINOR_LEAGUE_SLOTS),
			after: occupancy(after.minorLeagueOccupied, MINOR_LEAGUE_SLOTS),
			attention: null
		}
	];
}

/** One moved Player, named between the two Teams' figures. */
function transferRow(transfer: RosterTradeTransfer): ReasonSheetRow {
	return {
		label: transfer.playerName,
		before: `${transfer.fromTeamName} · ${SLOT_LABELS[transfer.fromPlacement]}`,
		after: `${transfer.toTeamName} · ${SLOT_LABELS[transfer.toPlacement]}`,
		// Every consequence the two states do not show, in one string —
		// `transferAttention` joins the re-placed Cap Hit and the cleared
		// contract length, either, both or neither. `null` where there is none:
		// the amber marker is the product's single attention colour, and a
		// sheet that marks every row marks nothing.
		attention: transferAttention(transfer)
	};
}

/** Every row a Roster Trade's sheet shows, in reading order. */
export function rosterTradeReasonRows(delta: RosterTradeDelta): readonly ReasonSheetRow[] {
	return [
		...teamFigureRows(delta.sendingBefore, delta.sendingAfter),
		...delta.transfers.map(transferRow),
		...teamFigureRows(delta.receivingBefore, delta.receivingAfter)
	];
}

/**
 * The act, as one finished sentence — never assembled from a template the
 * sheet itself holds.
 *
 * It names both Teams and counts the Contracts in each direction, because
 * either direction may be empty and "sends nothing" is the sentence a salary
 * dump needs to see before it commits (§10 example 36).
 */
export function rosterTradeActSentence(delta: RosterTradeDelta): string {
	const sendingTeam = delta.sendingAfter.teamName;
	const receivingTeam = delta.receivingAfter.teamName;
	const out = delta.transfers.filter(
		(transfer) => transfer.fromTeamId === delta.sendingAfter.teamId
	);
	const back = delta.transfers.filter(
		(transfer) => transfer.fromTeamId === delta.receivingAfter.teamId
	);
	const names = (transfers: readonly RosterTradeTransfer[]): string =>
		transfers.map((transfer) => transfer.playerName).join(', ');

	if (back.length === 0) {
		return `Record that ${sendingTeam} sends ${names(out)} to ${receivingTeam} and receives nothing back.`;
	}
	if (out.length === 0) {
		return `Record that ${receivingTeam} sends ${names(back)} to ${sendingTeam} and receives nothing back.`;
	}
	return `Record that ${sendingTeam} sends ${names(out)} to ${receivingTeam} and receives ${names(back)}.`;
}

/** The commit control's own words. Never "Confirm" — it names the act. */
export const ROSTER_TRADE_COMMIT_LABEL = 'Record the Roster Trade';

// --- Story 7.8: the one-Team Drop sheet -----------------------------------

/**
 * One released Player, named under the Team's figures (Story 7.8, FR-43,
 * UX-DR40).
 *
 * `before` is where he was and what he was charging; `after` is what the Team
 * is left carrying — Dead Money at the same amount, or the stated absence of
 * any. The row is deliberately readable without the Slot arithmetic above it:
 * "Active/Bench · $2.0M → Dead Money · $2.0M" is the whole of FR-43's rule for
 * an ordinary release, and "→ Released, nothing carried" is the exception.
 *
 * The `attention` sentence is the pure core's (`dropAttention`), and it is
 * the one FR-43 requires before a Drop commits: the Slot an Active/Bench
 * release frees costs $1,000,000 to reserve, and the sentence then states the
 * NET direction for that release — a fall of $1,000,000 where the Cap Hit is
 * carried (§10 example 40), a rise where it is released back to Cap Space
 * (§10 example 41). Everybody's intuition says a Drop frees money, which is
 * exactly why the sentence exists — and why it is on the row rather than in a
 * footnote. It states a direction it computed, never one it assumed: the two
 * examples are the same Slot and the same amount and move opposite ways.
 */
function releaseRow(release: DropRelease): ReasonSheetRow {
	return {
		label: release.playerName,
		before: `${SLOT_LABELS[release.fromPlacement]} · ${describeActAmount(release.chargedCapHit)}`,
		after: release.removed
			? 'Released — nothing carried'
			: `${SLOT_LABELS.dead_money} · ${describeActAmount(release.deadMoney)}`,
		attention: dropAttention(release)
	};
}

/**
 * Every row a Drop's sheet shows, in reading order.
 *
 * One Team's block, then one row per released Player — the Team's five
 * figures first because the counterintuitive half of FR-43 is what they do
 * NOT show: Cap Space stands still while Roster Count falls, and the released
 * rows underneath are where the money went.
 *
 * `teamFigureRows` is the Trade's, called rather than copied: a Drop's five
 * figures are a Trade's five figures asked of one Team.
 */
export function dropReasonRows(delta: RosterDropDelta): readonly ReasonSheetRow[] {
	return [...teamFigureRows(delta.before, delta.after), ...delta.released.map(releaseRow)];
}

/** The commit control's own words. Never "Confirm" — it names the act. */
export const DROP_COMMIT_LABEL = 'Record the Drop';

// --- Story 7.11: the one-Team Roster Move sheet ---------------------------

/**
 * One re-placed Contract, named under the Team's figures (Story 7.11, FR-44,
 * UX-DR41).
 *
 * `before` is the Slot it occupied and what it was charging; `after` is the
 * Slot it now occupies and what it charges there. The row is deliberately
 * readable without the arithmetic above it: "Active/Bench 18.0M to Minor
 * League 0" is the whole of FR-44's cap rule for one Contract.
 *
 * The `attention` sentence is the pure core's (`moveAttention`) and states
 * what the Contract's charge did, with the value stated unchanged beside it
 * (AD-23) — §10 example 44's $15,000,000 recovery is two of these rows
 * pulling opposite ways.
 */
function rearrangeRow(move: RearrangeMove): ReasonSheetRow {
	return {
		label: move.playerName,
		before: `${SLOT_LABELS[move.fromPlacement]} · ${describeActAmount(move.capHitBefore)}`,
		after: `${SLOT_LABELS[move.toPlacement]} · ${describeActAmount(move.capHitAfter)}`,
		attention: moveAttention(move)
	};
}

/**
 * Every row a Roster Move's sheet shows, in reading order.
 *
 * The Team's five figures, then the **Maximum Bid** row, then one row per
 * re-placed Contract.
 *
 * **Maximum Bid earns a row of its own, and it is the reason this sheet
 * exists.** The five figures show Cap Space falling while Roster Count rises,
 * which every intuition reads as a loss — and §10 example 45 is the case
 * where the Team ends $10,000,000 RICHER at the bidding table for exactly
 * that trade. The figure is `managerMaximumBidFor`'s — the Maximum Bid a
 * Manager knows from the board, which counts the Bid about to be placed —
 * and NOT the gates' solvency headroom, which projects none and would state
 * a gain $1,000,000 short. The sentence beside it is
 * `maximumBidDirectionSentence`'s. Neither is asserted here.
 *
 * `teamFigureRows` is the Trade's, called rather than copied: a Move's five
 * figures are a Trade's five figures asked of one Team.
 */
export function rearrangeReasonRows(
	delta: RosterRearrangeDelta,
	capBefore: ActCapGateOutcome,
	capAfter: ActCapGateOutcome,
	maximumBid: MaximumBidPair
): readonly ReasonSheetRow[] {
	return [
		...teamFigureRows(delta.before, delta.after),
		{
			label: `${delta.after.teamName} · Maximum Bid`,
			before: describeActAmount(maximumBid.before),
			after: describeActAmount(maximumBid.after),
			attention: maximumBidDirectionSentence(capBefore, capAfter, maximumBid)
		},
		...delta.moves.map(rearrangeRow)
	];
}

/**
 * The act, as one finished sentence — the pure core's, re-exported rather
 * than restated.
 *
 * `dropActSentence` lives in `rules/roster-drop.ts` and
 * `rosterTradeActSentence` lives here; the Move's sentence lives in the core
 * beside the rule that produces the delta, and this name is what the Code Map
 * promises callers of this module. One function, two names, no second
 * wording.
 */
export { rearrangeActSentence } from './core/rules/roster-rearrange.ts';

/** The commit control's own words. Never "Confirm" — it names the act. */
export const ROSTER_MOVE_COMMIT_LABEL = 'Record the Roster Move';

// --- Story 7.13: reversing an Auction Close --------------------------------

/**
 * One Team's Nomination Slot, in words — `Open`, or held and on whom.
 *
 * `teamFigureRows` has no Slot row, because no roster act moves one; a
 * reversal can, so the row is built here.
 */
function slotWords(held: SlotPair['before']): string {
	return held === null ? 'Open' : `Held — ${held.playerName}`;
}

/**
 * Every row a Close reversal's sheet shows, in reading order (Story 7.13,
 * FR-32, UX: the sheet titled *Reverse this Close*).
 *
 * **Before → after for Cap Space, Available Cap Space, Maximum Bid, Roster
 * Count and Nomination Slot**, then one row per standing Bid Cancellation
 * stated as NOT undone. `teamFigureRows` carries none of Available Cap Space,
 * Maximum Bid or the Slot, so they are built here — every figure is the pure
 * core's (`figuresFor`, `teamSolvencyFiguresFor`), and this formats nothing
 * but through `describeActAmount`.
 *
 * The consequence notes ride the rows they are about, from
 * `closeReversalAttention`: the Player returning to the pool on Cap Space;
 * the IR Roster Move and the Contract Assignment warning on Roster Count; the
 * Slot's reason on the Slot; and "nothing else is undone" on the closing row
 * that lists what stands.
 */
export function closeReversalReasonRows(decision: CloseReversalDecision): readonly ReasonSheetRow[] {
	const notes = closeReversalAttention(decision);
	const team = decision.teamAfter.teamName;
	const label = (figure: string): string => `${team} · ${figure}`;
	const rosterNotes = [notes.irMove, notes.contractAssignment].filter(
		(note): note is string => note !== null
	);
	return [
		{
			label: label('Cap Space'),
			before: describeActAmount(decision.teamBefore.capSpace),
			after: describeActAmount(decision.teamAfter.capSpace),
			attention: notes.pool
		},
		{
			label: label('Available Cap Space'),
			before: describeActAmount(decision.solvencyBefore.availableCapSpace),
			after: describeActAmount(decision.solvencyAfter.availableCapSpace),
			attention: null
		},
		{
			label: label('Maximum Bid'),
			before: describeActAmount(decision.solvencyBefore.maximumBid),
			after: describeActAmount(decision.solvencyAfter.maximumBid),
			attention: null
		},
		{
			label: label('Roster Count'),
			before: String(decision.teamBefore.rosterCount),
			after: String(decision.teamAfter.rosterCount),
			attention: rosterNotes.length === 0 ? null : rosterNotes.join(' ')
		},
		{
			label: label(SLOT_LABELS.injury_reserve),
			before: `${String(decision.teamBefore.injuryReserveOccupied)} of ${String(INJURY_RESERVE_SLOTS)}`,
			after: `${String(decision.teamAfter.injuryReserveOccupied)} of ${String(INJURY_RESERVE_SLOTS)}`,
			attention: null
		},
		{
			label: label('Nomination Slot'),
			before: slotWords(decision.slot.before),
			after: slotWords(decision.slot.after),
			attention: notes.slot
		},
		...decision.standingCancellations.map((cancellation) => ({
			label: `Bid Cancellation · ${cancellation.playerName}`,
			before: `${cancellation.teamName}'s ${describeActAmount(cancellation.amount)} Bid cancelled${
				cancellation.restoredTeamName === null ? '' : `; ${cancellation.restoredTeamName} leads`
			}`,
			after: 'Stands — not undone',
			attention: null
		})),
		{
			label: 'Bid Cancellations and the League Clock',
			before: `${String(decision.standingCancellations.length)} cancelled by this Close`,
			after: 'Unchanged',
			attention: notes.nothingElse
		}
	];
}

/** The act, as one finished sentence — the pure core's, re-exported. */
export { closeReversalActSentence } from './core/rules/close-reversal.ts';

/** The commit control's own words. Never "Confirm" — it names the act. */
export const CLOSE_REVERSAL_COMMIT_LABEL = 'Reverse this Close';

// --- Story 7.14: reinstating a cancelled Bid -------------------------------

/**
 * Every row a Bid reinstatement's sheet shows, in reading order (Story 7.14).
 *
 * **Before → after for the Leading Bid, the Auction Clock, the Bids placed
 * after the cancellation, and the League Clock** — the four things the act
 * moves. Every figure and instant is the pure core's decision, and every
 * consequence note is `bidReinstatementAttention`'s; this formats nothing but
 * through `describeActAmount`.
 */
export function bidReinstatementReasonRows(
	decision: BidReinstatementDecision
): readonly ReasonSheetRow[] {
	const notes = bidReinstatementAttention(decision);
	const player = decision.cancellation.playerName;
	const bidWords = (bid: { readonly teamName: string; readonly amount: Money }): string =>
		`${bid.teamName} · ${describeActAmount(bid.amount)}`;
	return [
		{
			label: `${player} · Leading Bid`,
			before: decision.leaderBefore === null ? 'None' : bidWords(decision.leaderBefore),
			after: bidWords(decision.reinstated),
			attention: notes.leader
		},
		{
			label: `${player} · Auction Clock`,
			before: decision.closesAtBefore ?? 'None',
			after: decision.reinstated.closesAt,
			attention: notes.clock
		},
		{
			label: `${player} · Bids after the cancellation`,
			before:
				decision.erased.length === 0 ? 'None' : decision.erased.map(bidWords).join(', '),
			after: decision.erased.length === 0 ? 'None' : 'Erased',
			attention: notes.erased
		},
		{
			label: 'League Clock',
			before: decision.leagueClockExpiryBefore ?? 'None',
			after: decision.leagueClockExpiryAfter ?? 'None',
			attention: notes.leagueClock
		},
		{
			label: `${decision.reinstated.teamName} · Cap and Slots, as of now`,
			before: 'Bid cancelled',
			after: 'Both pass',
			attention: null
		}
	];
}

/** The act, as one finished sentence — the pure core's, re-exported. */
export { bidReinstatementActSentence } from './core/rules/bid-reinstatement.ts';

/** The commit control's own words. Never "Confirm" — it names the act. */
export const BID_REINSTATEMENT_COMMIT_LABEL = 'Reinstate this Bid';
