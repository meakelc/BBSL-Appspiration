/**
 * Pure Cap Space and slot-ceiling validation for a staged roster (AD-24,
 * Story 1.7).
 *
 * Consumes only `ParsedRosterRow` — the domain type the Fantrax adapter
 * emits — and the league constants. No notion of a file, a Team, or a
 * database row reaches this module; that is `adapters/fantrax/`'s job and
 * `server/roster-import.ts`'s job respectively.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

import {
	ACTIVE_BENCH_SLOTS,
	INJURY_RESERVE_SLOTS,
	MINOR_LEAGUE_SLOTS,
	SALARY_CAP
} from '../constants.ts';
import { addMoney, parseMoney, subtractMoney } from '../money.ts';
import type { Money } from '../money.ts';
import type { ParsedRosterRow, RosterSlotKind } from '../types.ts';

// --- Cap Space ---------------------------------------------------------

/** Cap Space, and the total it was computed from — so a refusal can state both. */
export type CapSpaceResult = {
	readonly capHitTotal: Money;
	readonly capSpace: Money;
};

/**
 * The two fields Cap Space is computed from, and no others.
 *
 * `ParsedRosterRow` satisfies this structurally, so the import path passes
 * its own rows unchanged. Story 2.6's money gate is the second caller and
 * has neither a player name nor a contract length in hand — it reads two
 * columns off `team_rosters` — and widening the parameter is what let it
 * reuse this function rather than write a second definition of Cap Space
 * that could disagree about the Minor League rule below.
 */
export type CapHitRow = {
	readonly capHit: Money;
	readonly rosterSlotKind: RosterSlotKind;
};

/**
 * Cap Space = SALARY_CAP − Σ(cap hits), with a Minor League row's cap hit
 * always treated as $0 regardless of what the file states for it — a Minor
 * League contract does not count against the Cap by rule, and this
 * computation enforces that itself rather than trusting the import to have
 * already zeroed it (the imported figure is preserved exactly as supplied in
 * `import_staged_rosters.cap_hit`; only this computation zeroes it).
 *
 * **Injury Reserve is NOT zeroed**, and that asymmetry is the rule rather
 * than an omission: an IR contract counts against the Cap in full, and only
 * against Roster Count does it drop out (PRD §3 "Roster Count", §10 ex 23).
 * Story 2.6 counts the two separately for exactly that reason.
 */
export function computeCapSpace(rows: readonly CapHitRow[]): CapSpaceResult {
	let total: Money = parseMoney(0);
	for (const row of rows) {
		const hit: Money = row.rosterSlotKind === 'minor_league' ? parseMoney(0) : row.capHit;
		total = addMoney(total, hit);
	}
	return { capHitTotal: total, capSpace: subtractMoney(parseMoney(SALARY_CAP), total) };
}

// --- Slot ceilings -------------------------------------------------------

/** One roster slot kind whose row count exceeds its league ceiling. */
export type SlotCeilingBreach = {
	readonly slotKind: RosterSlotKind;
	readonly count: number;
	readonly ceiling: number;
};

const SLOT_CEILINGS: Readonly<Record<RosterSlotKind, number>> = Object.freeze({
	active_bench: ACTIVE_BENCH_SLOTS,
	injury_reserve: INJURY_RESERVE_SLOTS,
	minor_league: MINOR_LEAGUE_SLOTS
});

/**
 * Every roster slot kind whose row count exceeds its league ceiling, if any.
 * Empty means every ceiling holds. Checked against `ACTIVE_BENCH_SLOTS`,
 * `INJURY_RESERVE_SLOTS` and `MINOR_LEAGUE_SLOTS` — the same constants the
 * rest of the core reads from `core/constants.ts`, never a value repeated
 * here.
 */
export function checkSlotCeilings(rows: readonly ParsedRosterRow[]): readonly SlotCeilingBreach[] {
	const counts: Record<RosterSlotKind, number> = {
		active_bench: 0,
		injury_reserve: 0,
		minor_league: 0
	};
	for (const row of rows) {
		counts[row.rosterSlotKind] += 1;
	}

	const breaches: SlotCeilingBreach[] = [];
	for (const slotKind of Object.keys(SLOT_CEILINGS) as RosterSlotKind[]) {
		const ceiling = SLOT_CEILINGS[slotKind];
		const count = counts[slotKind];
		if (count > ceiling) breaches.push({ slotKind, count, ceiling });
	}
	return breaches;
}

// --- Refusal wording (product voice: state the fact, then the arithmetic) --

/** Slot kind labels for a refusal sentence, matching the glossary phrasing. */
const SLOT_LABELS: Readonly<Record<RosterSlotKind, string>> = Object.freeze({
	active_bench: 'Active/Bench',
	injury_reserve: 'Injury Reserve',
	minor_league: 'Minor League'
});

/**
 * U+2212 MINUS SIGN — not a hyphen. `core/money.ts` keeps its own private
 * copy of this same character for the same reason (its module header:
 * "DESIGN.md is explicit about this"); it isn't exported from there, so this
 * module holds an equivalent constant rather than reaching into `money.ts`'s
 * internals.
 */
const MINUS_SIGN = '−';

/**
 * Render a whole-dollar amount with the product's true minus sign — never
 * `String(amount)`, which prints an ASCII hyphen for a negative `Money` and
 * would render Cap Space as `$-500000` instead of `−$500000`.
 */
function renderDollars(amount: Money): string {
	return amount < 0 ? `${MINUS_SIGN}$${String(-amount)}` : `$${String(amount)}`;
}

/**
 * The refusal sentence for a negative Cap Space: states the fact, then the
 * arithmetic. Plain integer dollars, not `formatMoney` — an imported cap hit
 * is a real-world salary figure with no guarantee it sits on the app's own
 * $500,000 grid, and `formatMoney` throws rather than render an off-grid
 * amount.
 */
export function capSpaceRefusalDetail(result: CapSpaceResult): string {
	return (
		`Cap Space is negative: $${String(SALARY_CAP)} minus ${renderDollars(result.capHitTotal)} ` +
		`equals ${renderDollars(result.capSpace)}.`
	);
}

/** The refusal sentence for one or more slot-ceiling breaches: fact, then arithmetic. */
export function slotCeilingRefusalDetail(breaches: readonly SlotCeilingBreach[]): string {
	return breaches
		.map(
			(breach) =>
				`${SLOT_LABELS[breach.slotKind]}: ${String(breach.count)} rows exceeds the ceiling of ${String(breach.ceiling)}.`
		)
		.join(' ');
}
