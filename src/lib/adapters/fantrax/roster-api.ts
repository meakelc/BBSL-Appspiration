/**
 * The Fantrax `getTeamRosters` endpoint — the only module in the repository
 * that knows this API's URL, its query parameters, its field names, its id
 * form or its status strings (AD-24, AR-2, Story 7.9). Everything downstream
 * sees `FantraxRosterSnapshot`, a domain shape with no notion of an HTTP
 * request.
 *
 * **The reader never receives a database client** (AD-32). There is no
 * parameter of any signature here through which one could be passed, so a
 * write from inside this file is a type error rather than a discipline. It
 * takes a URL, a league id, a period, a `FetchLike` and an `AbortSignal`, and
 * it returns a value.
 *
 * **`adapters/discord/webhook.ts` is the template, and the departure from it
 * is deliberate.** That module takes its URL and a structural `FetchLike` as
 * parameters, reads no `$env` itself, never throws, returns a result union,
 * keeps the URL out of every `detail` string and truncates a body at 500
 * characters. All of that is copied. What is added is an `AbortSignal`: an
 * undocumented third party can hang where a webhook does not, and a read that
 * hangs must become a recorded failure rather than an open socket.
 *
 * **MEMBERSHIP IS THE ONLY FACT THIS READ PRODUCES.** A Slot kind is carried
 * because it costs nothing to carry and a future story may want it, and it is
 * marked advisory at every step: nothing compares it, because a placement
 * difference is the expected state between a Move and the next export, not
 * drift. Money is NOT taken from here as authoritative either — `salary` is
 * read only to run the rounding-and-grid check below, and the resulting figure
 * is a warning, never a charge.
 *
 * **Ids are normalised in BOTH directions, and that is hazard 2.** The API
 * answers `01eon`; the FR-1 CSV importer stores `*04ewu*` verbatim,
 * asterisks included, because the pool export writes it the same way and
 * stripping them in one adapter and not the other would silently break every
 * match (`roster-file.ts:31-35`). An unnormalised comparison would read all
 * 303 rows as a departure and an unknown arrival at once — a silent total
 * failure — so `normaliseFantraxPlayerId` below is the ONE definition, and
 * `server/divergence.ts` applies it to BOTH sides before the pure comparison
 * sees either. The core normalises nothing and knows no Fantrax string format
 * (AD-24); `tests/server/divergence.test.ts` is what fails if the shell stops
 * applying it.
 *
 * Deno-loadable like everything else under `adapters/` (AD-2): relative `.ts`
 * imports only, no `$env`, no `$lib`, no Node builtin, no bare specifier.
 */

import { isOnMoneyGrid, parseMoney } from '../../core/money.ts';
import type { Money } from '../../core/money.ts';
import type { RosterSlotKind } from '../../core/types.ts';

/**
 * The one canonical form of a Fantrax player id — this module's, and only this
 * module's (AD-24).
 *
 * **Two real forms exist and both are correct where they live.** This API
 * answers `01eon`. The FR-1 CSV importer stores `*04ewu*` — asterisks and all,
 * deliberately, because the Free Agent pool export writes it the same way and
 * `roster-file.ts:31-35` says stripping them in one adapter and not the other
 * would silently break every match.
 *
 * So neither form may be compared against the other as-is. An unnormalised
 * comparison reads every one of the league's 303 rows as a departure AND as an
 * unknown arrival at the same instant: a silent total failure that produces a
 * confident, completely wrong answer.
 *
 * **It lives HERE and it may not live in `core/`.** The shape of a Fantrax id
 * is a fact about Fantrax, and AD-24 puts every Fantrax name, id form and
 * status string inside `adapters/fantrax/`. The pure core may not import an
 * adapter (AD-2 permits relative `.ts` imports, but the dependency runs the
 * wrong way and `core/rules/divergence.ts` would then know a third party's
 * string format). The SHELL may import both, so `server/divergence.ts` is where
 * this is applied — to the Fantrax side, to `team_rosters`' stored ids and to
 * the Auction Contracts' keys alike — and `compareMembership` receives ids that
 * are already canonical and normalises nothing.
 *
 * Canonical form: trimmed, asterisks stripped from both ends, lower-cased. The
 * BARE form rather than the wrapped one, because that is what this API emits.
 * The app's stored id is never reconstructed from it — it is carried alongside,
 * verbatim, so a pre-filled `/roster-trade` or `/roster-drop` link names exactly
 * the id `team_rosters` holds.
 *
 * Lower-casing is not cosmetic. The export and the API have never been observed
 * to disagree on case, but a comparison that would break on a case change is one
 * Fantrax release away from reading the whole league as churn, and no id in this
 * domain has meaningful case.
 *
 * A value that is nothing but asterisks and whitespace canonicalises to the
 * empty string, which every caller treats as "no id" rather than as a short one.
 */
export function normaliseFantraxPlayerId(raw: string): string {
	let text = raw.trim();
	while (text.startsWith('*')) text = text.slice(1);
	while (text.endsWith('*')) text = text.slice(0, -1);
	return text.trim().toLowerCase();
}

/**
 * The `status` strings this endpoint emits, as observed 2026-09-10 against the
 * live league (unauthenticated, 30 Teams, 303 rows).
 *
 * A closed union rather than `string`, so the map below can be exhaustive with
 * no `default` — a fifth status arriving is then a `malformed` payload that
 * names the value, rather than a row quietly folded into the wrong Slot.
 */
export type FantraxRosterStatus = 'ACTIVE' | 'RESERVE' | 'MINORS' | 'INJURED_RESERVE';

/**
 * The API's `status`, mapped to the `RosterSlotKind` the core deals in.
 *
 * **Declared separately from `roster-file.ts`'s `ROSTER_SLOT_ALIASES`, and
 * the separation is load-bearing.** That map is over a CSV's `Status` cell
 * (`Act`, `Res`, `Min`, plus three guessed spellings of IR) and is
 * case-insensitively keyed on trimmed text. This API's `INJURED_RESERVE` does
 * not match its `injured reserve` alias and never would: one has an
 * underscore and the other a space. Folding the two maps together would mean
 * one of them loosening — and a loose map over a third party's enum is how a
 * new status silently becomes `active_bench`.
 *
 * `ACTIVE` and `RESERVE` both fold to `active_bench`, for the CSV map's
 * reason: the distinction Fantrax draws between an active player and a benched
 * one is a lineup concern the BBSL cap does not see, and both count against
 * Roster Capacity.
 *
 * Exhaustive over the union above with NO `default` and no catch-all, so a
 * fifth member of `FantraxRosterStatus` is a compile error here.
 */
export const FANTRAX_STATUS_SLOTS: Readonly<Record<FantraxRosterStatus, RosterSlotKind>> =
	Object.freeze({
		ACTIVE: 'active_bench',
		RESERVE: 'active_bench',
		MINORS: 'minor_league',
		INJURED_RESERVE: 'injury_reserve'
	});

/** Is this one of the four statuses the endpoint is known to emit? */
export function isFantraxRosterStatus(value: unknown): value is FantraxRosterStatus {
	return (
		value === 'ACTIVE' || value === 'RESERVE' || value === 'MINORS' || value === 'INJURED_RESERVE'
	);
}

/**
 * One Player's membership of one Fantrax roster. Membership, a name for the
 * surface to print, and an ADVISORY Slot kind that nothing compares.
 */
export type FantraxRosterMember = {
	/** Normalised (`normaliseFantraxPlayerId`), never the raw API form. */
	readonly playerId: string;
	/**
	 * The normalised id again: the endpoint carries no name. Kept as a field so
	 * stored reads keep their shape; `server/divergence.ts` resolves the name.
	 */
	readonly playerName: string;
	/**
	 * Advisory only. A placement difference between the app and Fantrax is the
	 * expected state between a Roster Move and the next export, and raising it
	 * would report the app working correctly as drift.
	 */
	readonly rosterSlotKind: RosterSlotKind;
};

/** One Fantrax Team's roster, keyed by the Fantrax team id the app stores. */
export type FantraxTeamRoster = {
	readonly fantraxTeamId: string;
	/** For a diagnostic sentence only. NOTHING matches on this (AD-24). */
	readonly teamName: string;
	readonly members: readonly FantraxRosterMember[];
};

/** Everything one successful read produced. */
export type FantraxRosterSnapshot = {
	readonly teams: readonly FantraxTeamRoster[];
	/**
	 * `salary` figures that rounded to a value off the $500,000 grid, named
	 * one per Player. A WARNING and never a refusal — see `roundedSalary`.
	 */
	readonly moneyWarnings: readonly string[];
};

/** What one read of the endpoint amounted to. Four cases, never a throw. */
export type FantraxRosterResult =
	| { readonly kind: 'ok'; readonly snapshot: FantraxRosterSnapshot }
	| { readonly kind: 'unreachable'; readonly detail: string }
	| { readonly kind: 'rate_limited'; readonly detail: string }
	| { readonly kind: 'malformed'; readonly detail: string };

/** The port, as `server/divergence.ts` needs it. */
export type FantraxRosterPort = {
	read(): Promise<FantraxRosterResult>;
};

/**
 * As much of a `Response` as this module reads, declared structurally — the
 * webhook adapter's `HttpResponse`, restated here rather than imported so
 * `adapters/fantrax/` does not depend on `adapters/discord/`. A real
 * `Response` satisfies it.
 */
export type HttpResponse = {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
};

/**
 * As much of `fetch` as this module calls. A real `fetch` satisfies it.
 *
 * `signal` is part of the shape rather than something the caller closes over,
 * because the timeout is this reader's own answer to a third party that hangs
 * and it must be visible in the type that describes the transport.
 */
export type FetchLike = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly signal?: AbortSignal | undefined;
	}
) => Promise<HttpResponse>;

/** Fantrax's 429, named rather than inlined because two places test for it. */
const TOO_MANY_REQUESTS = 429;

/**
 * How much of a response body may reach `fantrax_reads.detail`.
 *
 * `adapters/discord/webhook.ts`'s `MAX_DETAIL_LENGTH`, for its reason: an
 * upstream proxy's HTML error page is unbounded, and the informative part of
 * an error is always its beginning.
 */
const MAX_DETAIL_LENGTH = 500;

function truncate(text: string): string {
	if (text.length <= MAX_DETAIL_LENGTH) return text;
	return `${text.slice(0, MAX_DETAIL_LENGTH)}… [truncated, ${text.length} characters]`;
}

/** A thrown value's text, without assuming it is an `Error`. */
function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * What one `salary` figure amounted to: the rounded dollars, and whether they
 * landed on the $500,000 grid.
 *
 * **Rounded, never truncated, and this is a real observed defect rather than a
 * hypothetical.** The endpoint emits JSON numbers — `2.25E7`, and in four of
 * 303 live rows a value like `23499999.999999993`. `int()` / `Math.trunc`
 * puts those four a dollar low and therefore off the grid;
 * `Math.round` puts them on `$23,500,000`, which is what Fantrax meant and
 * what every other reading of the same contract says.
 *
 * **An off-grid result refuses THE FIGURE, never the Player.** Dropping a row
 * from the membership set because an unused field failed a check would
 * manufacture a departure, and a manufactured departure is exactly the
 * silent-total-failure shape this story's id normalisation exists to prevent —
 * arriving through the door built to prevent it. The caller records a named
 * warning and keeps the Player a member.
 */
export type RoundedSalary = {
	readonly amount: Money;
	readonly onGrid: boolean;
};

/**
 * Round a raw `salary` to the nearest dollar and assert the grid.
 *
 * Exported because the hazard goes live the moment anything else reads
 * `salary`, and the next reader should be reaching for this rather than
 * writing `int()`. Returns `null` for a value that is not a finite number at
 * all — that is a malformed payload, not an off-grid figure, and the two must
 * not be reported as the same thing.
 */
export function roundedSalary(raw: unknown): RoundedSalary | null {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
	const rounded = Math.round(raw);
	if (!Number.isSafeInteger(rounded)) return null;
	const amount = parseMoney(rounded);
	return { amount, onGrid: isOnMoneyGrid(amount) };
}

/**
 * The endpoint's path under `baseUrl`, and its two query parameters.
 *
 * Spelled here and nowhere else (AD-24). `baseUrl` is the origin plus any
 * prefix — `https://www.fantrax.com/fxea/general` — supplied by the shell from
 * configuration, so a move of the host is a variable change rather than a code
 * change, and no module outside this directory knows the endpoint exists.
 */
export const ROSTERS_PATH = '/getTeamRosters';

/** Build the read URL. Exported so the test asserts the wiring, not the guess. */
export function rosterRequestUrl(input: {
	readonly baseUrl: string;
	readonly leagueId: string;
	readonly period: string;
}): string {
	const base = input.baseUrl.endsWith('/') ? input.baseUrl.slice(0, -1) : input.baseUrl;
	const query = new URLSearchParams();
	query.set('leagueId', input.leagueId);
	query.set('period', input.period);
	return `${base}${ROSTERS_PATH}?${query.toString()}`;
}

/** `Object.prototype.hasOwnProperty`, called against a parsed JSON object. */
function hasOwn(record: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * Parse the endpoint's body into a snapshot, or say why it could not be.
 *
 * **The observed shape, 2026-09-10.** A top-level `rosters` object keyed by
 * the Fantrax team id; each value carries `teamName`, `salaryCap` and a
 * `rosterItems` array; each item is
 * `{"contract":{"smallId","name"},"id":"01eon","position","salary":2.25E7,"status"}`.
 * `salaryCap`, `position` and `contract` are read for nothing — money,
 * contract length and Slot placement are never taken from this endpoint as
 * authoritative. `contract.name` is the contract label (`2RK29`), NOT the
 * Player's name, and nothing in the payload is; see `playerName` below.
 *
 * Exported separately from the transport so the payload shape is testable with
 * no `fetch` at all — the split `adapters/fantrax/pool-file.ts` gets for free
 * by being pure.
 */
export function parseRosterPayload(body: string): FantraxRosterResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		return {
			kind: 'malformed',
			detail: truncate(`the response was not JSON: ${describe(error)}`)
		};
	}

	const root = asRecord(parsed);
	if (root === null) {
		return { kind: 'malformed', detail: 'the response was not a JSON object.' };
	}

	const rosters = asRecord(root['rosters']);
	if (rosters === null) {
		return {
			kind: 'malformed',
			detail: 'the response carried no "rosters" object, so no Team could be read from it.'
		};
	}

	const teams: FantraxTeamRoster[] = [];
	const moneyWarnings: string[] = [];

	/**
	 * Every canonical player id seen so far, ACROSS every Team in the payload.
	 *
	 * `roster-file.ts:280,299-308` keeps the same set for the same reason, and
	 * here the consequence is worse than there. Rows join on this id (AD-24), so
	 * the same Player on two Fantrax rosters is unresolvable — which occurrence
	 * is the real one? — and the membership map this builds is keyed by Team, so
	 * a silent last-one-wins would put the Player on whichever Team sorted later
	 * and then propose a Roster Trade naming THE WRONG TEAM. The Commissioner
	 * would have no way to tell from the page that the proposal was built on a
	 * coin toss.
	 *
	 * `team_rosters.fantrax_player_id` is `unique` across every Team for
	 * precisely this reason; this is that constraint asserted at the boundary the
	 * database cannot see.
	 */
	const seenPlayerIds = new Set<string>();

	// Sorted, so one payload always produces one snapshot whatever order the
	// keys arrived in (AD-5) — the membership is stored and later fingerprinted,
	// and a fingerprint over an incidental key order is not a fingerprint.
	for (const fantraxTeamId of Object.keys(rosters).sort()) {
		if (!hasOwn(rosters, fantraxTeamId)) continue;
		const team = asRecord(rosters[fantraxTeamId]);
		if (team === null) {
			return {
				kind: 'malformed',
				detail: `the roster for Fantrax team ${fantraxTeamId} was not an object.`
			};
		}

		const rawItems = team['rosterItems'];
		if (!Array.isArray(rawItems)) {
			return {
				kind: 'malformed',
				detail: `the roster for Fantrax team ${fantraxTeamId} carried no rosterItems array.`
			};
		}

		const members: FantraxRosterMember[] = [];
		for (const rawItem of rawItems) {
			const item = asRecord(rawItem);
			if (item === null) {
				return {
					kind: 'malformed',
					detail: `a roster row on Fantrax team ${fantraxTeamId} was not an object.`
				};
			}

			const rawId = item['id'];
			if (typeof rawId !== 'string' || normaliseFantraxPlayerId(rawId) === '') {
				return {
					kind: 'malformed',
					detail: `a roster row on Fantrax team ${fantraxTeamId} carried no player id.`
				};
			}
			const playerId = normaliseFantraxPlayerId(rawId);

			if (seenPlayerIds.has(playerId)) {
				return {
					kind: 'malformed',
					detail: truncate(
						`the Fantrax player id ${JSON.stringify(playerId)} appears on more than one roster in this payload; nothing can say which Team holds him.`
					)
				};
			}
			seenPlayerIds.add(playerId);

			const status = item['status'];
			if (!isFantraxRosterStatus(status)) {
				// Named verbatim rather than folded into a default. A fifth status
				// is a fact about Fantrax that a human has to see once; guessing
				// would put a Player in the wrong Slot silently, forever.
				return {
					kind: 'malformed',
					detail: truncate(
						`a roster row on Fantrax team ${fantraxTeamId} carried an unrecognised status ${JSON.stringify(status)}.`
					)
				};
			}

			// **This payload carries no Player name, and `contract.name` is not
			// one.** It is the League's contract label — `2028`, `2RK29`, `2K30` —
			// and printing it as a name put "2K30" on the divergence page as a
			// Player (2026-09-23). The id is stored instead, and the shell resolves
			// a real name from what the app already knows when it renders.
			const playerName = playerId;

			// **Read for the warning and for nothing else.** An absent `salary`
			// is not an error here — no figure from this endpoint is
			// authoritative — and an off-grid one leaves the Player a member.
			if (hasOwn(item, 'salary')) {
				const salary = roundedSalary(item['salary']);
				if (salary !== null && !salary.onGrid) {
					moneyWarnings.push(playerName);
				}
			}

			members.push({ playerId, playerName, rosterSlotKind: FANTRAX_STATUS_SLOTS[status] });
		}

		const rawTeamName = team['teamName'];
		teams.push({
			fantraxTeamId,
			teamName:
				typeof rawTeamName === 'string' && rawTeamName.trim() !== ''
					? rawTeamName.trim()
					: fantraxTeamId,
			// Sorted by the normalised id, for the same AD-5 reason the Team keys
			// are: this list is stored and fingerprinted.
			members: [...members].sort((left, right) =>
				left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0
			)
		});
	}

	return { kind: 'ok', snapshot: { teams, moneyWarnings: [...moneyWarnings].sort() } };
}

/**
 * The real port: GET the rosters through the injected `fetch`.
 *
 * **Never throws.** Every outcome — a 2xx, a 429, a 5xx, a DNS failure, an
 * aborted socket, a body that is not JSON — comes back as a
 * `FantraxRosterResult`, because the caller must append exactly one
 * `fantrax_reads` row for each of them and a thrown transport error would be
 * the one case it could not describe.
 *
 * **The URL never reaches a `detail` string.** The league id identifies a
 * private league and the base URL is configuration; neither belongs in a row
 * the Commissioner's browser will render. `adapters/discord/webhook.ts` keeps
 * its webhook URL out of `detail` for the stronger version of this reason and
 * this file copies the discipline rather than judging the difference.
 *
 * **No database client can reach this function.** The input type has five
 * members and none of them is one (AD-32).
 */
export function createFantraxRosterPort(input: {
	readonly baseUrl: string;
	readonly leagueId: string;
	readonly period: string;
	readonly fetch: FetchLike;
	/**
	 * Abandons the read. An undocumented third party can hang where a webhook
	 * does not, and a read that hangs must become a recorded failure rather
	 * than an open socket — and it must never be able to block, delay or
	 * reverse an auction action, which is why the shell gives this its own
	 * timeout rather than letting the request run as long as it likes.
	 */
	readonly signal?: AbortSignal | undefined;
}): FantraxRosterPort {
	const url = rosterRequestUrl(input);

	return {
		async read(): Promise<FantraxRosterResult> {
			let response: HttpResponse;
			try {
				response = await input.fetch(url, {
					method: 'GET',
					headers: { accept: 'application/json' },
					signal: input.signal
				});
			} catch (error) {
				return {
					kind: 'unreachable',
					detail: truncate(`the Fantrax roster request failed before a response: ${describe(error)}`)
				};
			}

			// Read the body ONCE, before branching: `text()` may only be consumed
			// once, and both the failure path and the parse need it.
			let body: string;
			try {
				body = await response.text();
			} catch (error) {
				return {
					kind: 'unreachable',
					detail: truncate(`the response body could not be read: ${describe(error)}`)
				};
			}

			if (response.status === TOO_MANY_REQUESTS) {
				return {
					kind: 'rate_limited',
					detail: truncate(`Fantrax answered 429: ${body}`)
				};
			}

			if (!response.ok) {
				return {
					kind: 'unreachable',
					detail: truncate(`Fantrax answered ${String(response.status)}: ${body}`)
				};
			}

			return parseRosterPayload(body);
		}
	};
}
