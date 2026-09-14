/**
 * The shell half of roster-divergence detection (Story 7.9, FR-42).
 *
 * **Two jobs that deliberately do not touch each other.**
 *
 *   1. `runFantraxRead` — the scheduled read. Enforce the interval from the last
 *      `fantrax_reads` row, call the port, and append EXACTLY ONE
 *      `fantrax_reads` row whatever the outcome. That last part is AD-19's
 *      reasoning applied to a second pipe: a read that recorded nothing is
 *      indistinguishable from a reader that is not running at all, and "the
 *      detector quietly stopped detecting" is the failure this table exists to
 *      make visible.
 *   2. `loadDivergenceView` — the render. Read the latest row, load the
 *      rosters and the Auction Contracts, apply the dismissals, and hand the
 *      pure core its inputs.
 *
 * Comparing at RENDER rather than at read time is what makes "once the Trade
 * is recorded, the divergence resolves" arrive immediately instead of up to an
 * a read interval later, and it keeps the stored row a transcript of a third party rather
 * than an opinion about the league.
 *
 * **Nothing in this file calls `runTransactionalWrite`, and nothing in it may.**
 * `shell/write.ts:235-241` is where `GLOBAL_WRITE_LOCK_KEY` is taken; every
 * read here is unlocked, exactly as `server/sweep.ts:32-38` describes its own
 * read. A Fantrax read that hangs, is refused or returns nonsense must never
 * block, delay or reverse an auction action, and the only way to guarantee
 * that is for it never to contend for the lock at all.
 *
 * **No event, no `team_rosters` row, no projection.** The only statements this
 * module issues against a writable table are one `insert into fantrax_reads`
 * and one `insert into fantrax_divergence_dismissals`; everything else is a
 * `select`. `tests/server/divergence.test.ts` drives it through a fake client
 * that THROWS on any statement it does not recognise, which is what makes that
 * a proof rather than a claim.
 */

import { env } from '$env/dynamic/private';

import { createFantraxRosterPort, normaliseFantraxPlayerId } from '../adapters/fantrax/roster-api.ts';
import type {
	FantraxRosterPort,
	FantraxRosterResult,
	FetchLike
} from '../adapters/fantrax/roster-api.ts';
import { DIVERGENCE_READ_INTERVAL, DIVERGENCE_VOLUME_FRACTION } from '../core/constants.ts';
import { fold } from '../core/projection/fold.ts';
import { INITIAL_CONTRACTS, contractsReducer } from '../core/projection/contracts.ts';
import { compareMembership } from '../core/rules/divergence.ts';
import type {
	AppRosterMember,
	DivergenceReport,
	DivergenceTeam,
	FantraxMember
} from '../core/rules/divergence.ts';
import type { RosterSlotKind } from '../core/types.ts';
import type { ConnectionGateway, TransactionalClient } from '../shell/write.ts';
import { loadEventsViaClient } from './event-log.ts';

/** Every Team and the Fantrax roster it is bound to. Ordered by name (AD-5). */
export const DIVERGENCE_TEAMS_SQL =
	'select id::text as id, name, fantrax_team_id from teams order by name';

/**
 * Every live roster row in the League, in one read.
 *
 * One statement rather than thirty: the comparison is about all thirty Teams
 * at one instant, and thirty reads could see them a moment apart — which would
 * show a Player traded between two of them as simultaneously on neither or on
 * both.
 */
export const DIVERGENCE_ROSTERS_SQL =
	'select team_id::text as team_id, fantrax_player_id, player_name, roster_slot_kind from team_rosters order by fantrax_player_id';

/** The most recent read of ANY outcome — what decides whether the surface is stopped. */
export const LATEST_READ_SQL =
	'select read_at, outcome, detail, membership, money_warnings from fantrax_reads order by read_at desc, id desc limit 1';

/** The most recent SUCCESSFUL read — the membership the comparison runs against. */
export const LATEST_OK_READ_SQL =
	"select read_at, outcome, detail, membership, money_warnings from fantrax_reads where outcome = 'ok' order by read_at desc, id desc limit 1";

/** The one append this module makes per attempt. */
export const INSERT_READ_SQL =
	'insert into fantrax_reads (outcome, detail, membership, money_warnings, money_warning_count) values ($1, $2, $3, $4, $5) returning read_at';

/** Every dismissal, so the core can suppress what the Commissioner has seen. */
export const DISMISSALS_SQL = 'select fingerprint from fantrax_divergence_dismissals';

/**
 * One dismissal. `on conflict do nothing` because dismissing twice is not an
 * error — it is one Commissioner clicking a second time, or two co-managers
 * clicking at once, and the table holds no column a second click would change.
 */
export const INSERT_DISMISSAL_SQL =
	'insert into fantrax_divergence_dismissals (fingerprint, dismissed_by) values ($1, $2) on conflict (fingerprint) do nothing';

/** The database clock, read unlocked — never Node's (AD-3). */
export const CLOCK_SQL = 'select now() as now';

/** The outcomes a `fantrax_reads` row can carry. */
export type FantraxReadOutcome = 'ok' | 'unreachable' | 'rate_limited' | 'malformed';

/** One stored read, as the render reads it back. */
export type StoredRead = {
	readonly readAt: string;
	readonly outcome: string;
	readonly detail: string | null;
	readonly membership: StoredMembership | null;
	/**
	 * The Players whose `salary` was off the grid, BY NAME — never a bare count.
	 *
	 * `fantrax_reads.money_warning_count` is deliberately NOT read back beside
	 * this. It is the same fact as a number, stored only so an operator can ask
	 * "did any read carry a warning" with a plain integer predicate; carrying it
	 * into the application as well would be a second representation of one fact,
	 * free to disagree with the names the surface actually prints.
	 */
	readonly moneyWarnings: readonly string[];
};

/**
 * The stored membership: Fantrax team id -> the Players on it.
 *
 * Exactly what the endpoint said, normalised and with NOTHING derived. Not an
 * event-sourced projection, never folded, never read by a rule, and never
 * consulted for money.
 */
export type StoredMembership = Readonly<
	Record<
		string,
		ReadonlyArray<{
			readonly playerId: string;
			readonly playerName: string;
			readonly rosterSlotKind: RosterSlotKind;
		}>
	>
>;

/** What `runFantraxRead` did. Every branch except `skipped` appended one row. */
export type FantraxReadSummary =
	| {
			readonly kind: 'skipped';
			/** When the next read becomes due, as an ISO instant. */
			readonly nextDueAt: string;
			readonly detail: string;
	  }
	| {
			readonly kind: 'recorded';
			readonly outcome: FantraxReadOutcome;
			readonly readAt: string;
			readonly detail: string;
	  };

/**
 * Run one read, if one is due.
 *
 * **The interval is enforced from the LAST STORED ROW, not from a timer.** A
 * timer belongs to one process; this rule has to hold across a re-enabled cron
 * job, a hand-called endpoint and two deployments at once, and the only thing
 * all three share is the table. A second invocation inside the interval is skipped
 * and says when the next read is due.
 *
 * **Exactly one row per attempt, whatever happens.** The port never throws, so
 * every outcome reaches the insert; the insert is the only statement that can
 * fail, and a failure of it is the one thing the caller reports as a non-2xx —
 * because a read whose record could not be written is the outage that looks
 * like health.
 */
export async function runFantraxRead(
	gateway: ConnectionGateway,
	port: FantraxRosterPort,
	options: { readonly intervalMs?: number } = {}
): Promise<FantraxReadSummary> {
	const intervalMs = options.intervalMs ?? DIVERGENCE_READ_INTERVAL;

	// **Two short connections rather than one long one, and the split is the
	// point.** `port.read()` reaches an undocumented third party that may hang
	// for the whole of `FANTRAX_READ_TIMEOUT`; holding a pooled connection
	// across that would take a slot out of the pool every auction action shares
	// for thirty seconds, which is precisely the "never block, delay or reverse
	// any auction action" this story promises. So the interval is decided and
	// the connection released, the HTTP read happens with nothing held, and a
	// second connection records the row.
	const due = await decideDue(gateway, intervalMs);
	if (due.kind === 'skipped') return due;

	const result: FantraxRosterResult = await port.read();
	const row = readRowFor(result);

	const client = await gateway.connect();
	try {
		const inserted = await client.query(INSERT_READ_SQL, [
			row.outcome,
			row.detail,
			row.membership === null ? null : JSON.stringify(row.membership),
			JSON.stringify(row.moneyWarnings),
			// Derived from the array on write rather than counted a second time —
			// the names are the fact and the number is only its queryable form.
			row.moneyWarnings.length
		]);

		const readAt = instantFrom(inserted.rows[0]?.['read_at']);
		if (readAt === '') {
			// The `INSERT ... RETURNING` produced no row. Whatever that is, it is
			// not a recorded read — and reporting `kind: 'recorded'` with an empty
			// instant would be the outage that looks like health, in the one
			// function written to prevent it. The endpoint turns this into its own
			// non-2xx, which is the only thing the scheduler must ever see.
			throw new Error('runFantraxRead: the fantrax_reads insert returned no row');
		}

		return { kind: 'recorded', outcome: row.outcome, readAt, detail: row.detail };
	} finally {
		releaseQuietly(client, 'runFantraxRead');
	}
}

/**
 * Is a read due? Decided from the last stored row against the database clock,
 * on a connection that is released before the HTTP read begins.
 */
async function decideDue(
	gateway: ConnectionGateway,
	intervalMs: number
): Promise<{ readonly kind: 'due' } | Extract<FantraxReadSummary, { kind: 'skipped' }>> {
	const client = await gateway.connect();
	try {
		const clock = await client.query(CLOCK_SQL);
		const now = instantFrom(clock.rows[0]?.['now']);

		const latest = await readLatest(client, LATEST_READ_SQL);
		if (latest === null) return { kind: 'due' };

		const dueAt = new Date(new Date(latest.readAt).getTime() + intervalMs);
		if (dueAt.getTime() <= new Date(now).getTime()) return { kind: 'due' };

		return {
			kind: 'skipped',
			nextDueAt: dueAt.toISOString(),
			detail: `The last read was at ${latest.readAt}. The next one is due at ${dueAt.toISOString()}.`
		};
	} finally {
		releaseQuietly(client, 'decideDue');
	}
}

/** One read result, as the row that records it. Membership only for `ok`. */
function readRowFor(result: FantraxRosterResult): {
	readonly outcome: FantraxReadOutcome;
	readonly detail: string;
	readonly membership: StoredMembership | null;
	readonly moneyWarnings: readonly string[];
} {
	if (result.kind !== 'ok') {
		return { outcome: result.kind, detail: result.detail, membership: null, moneyWarnings: [] };
	}

	const membership: Record<
		string,
		ReadonlyArray<{ playerId: string; playerName: string; rosterSlotKind: RosterSlotKind }>
	> = {};
	let playerCount = 0;
	for (const team of result.snapshot.teams) {
		membership[team.fantraxTeamId] = team.members.map((member) => ({
			playerId: member.playerId,
			playerName: member.playerName,
			rosterSlotKind: member.rosterSlotKind
		}));
		playerCount += team.members.length;
	}

	const warnings = result.snapshot.moneyWarnings;
	return {
		outcome: 'ok',
		detail:
			`Fantrax answered with ${String(result.snapshot.teams.length)} Team(s) and ` +
			`${String(playerCount)} roster row(s).` +
			// NAMED, never counted, for `server/import-status.ts:113-115`'s reason.
			// The Player stays a member either way — a membership-only detector
			// that discarded a row over an unused field would manufacture a
			// departure.
			(warnings.length === 0
				? ''
				: truncateDetail(
						` ${String(warnings.length)} salary figure(s) rounded to a value off the $500,000 grid: ${warnings.join(', ')}. The figure is refused, never the Player.`
					)),
		membership,
		moneyWarnings: warnings
	};
}

/**
 * How the surface describes the pipe itself. Never mistakable for a clean read.
 *
 * FIVE members, and every one of them has its own stated sentence on the page.
 * The dangerous shape this union exists to make unrepresentable is a failure
 * that renders as silence — so there is no catch-all, and `report: null` is
 * never rendered as an empty list.
 */
export type DivergenceReadState =
	/** Configured, but the reader has never run. */
	| { readonly kind: 'never_read' }
	/**
	 * NOT configured: a variable the reader needs is unset, so no read has ever
	 * been attempted and none ever will be until somebody sets it. Distinct from
	 * `never_read`, because "nobody has run it yet" and "it cannot run" call for
	 * different actions and only one of them resolves on its own.
	 */
	| { readonly kind: 'not_configured'; readonly missing: readonly string[] }
	/** The last attempt failed. Nothing is raised — see `loadDivergenceView`. */
	| {
			readonly kind: 'stopped';
			readonly outcome: string;
			readonly detail: string | null;
			readonly failedAt: string;
			readonly lastGoodReadAt: string | null;
	  }
	/**
	 * The last read succeeded but its stored `membership` will not read back as
	 * the shape this module wrote. Stated rather than silently compared against
	 * nothing: a page saying "the read succeeded" above an empty list would be
	 * the worst output on this surface.
	 */
	| { readonly kind: 'unreadable'; readonly readAt: string }
	| {
			readonly kind: 'read';
			readonly readAt: string;
			/** BY NAME — `import-status.ts:113-115`'s "named, never counted". */
			readonly moneyWarnings: readonly string[];
	  };

/** Everything the `/divergence` surface renders from. */
export type DivergenceView = {
	readonly read: DivergenceReadState;
	/** `null` when no successful read has ever been stored — there is nothing to compare. */
	readonly report: DivergenceReport | null;
	/** The effective volume fraction, so the surface can state the threshold it used. */
	readonly volumeFraction: number;
};

/**
 * Load everything the surface needs: the read state, and — when a successful
 * read exists — the comparison.
 *
 * Unlocked, and it takes no lock by construction: it opens a connection from
 * the gateway and issues `select`s.
 */
export async function loadDivergenceView(
	gateway: ConnectionGateway,
	options: { readonly volumeFraction?: number; readonly missingConfiguration?: readonly string[] } = {}
): Promise<DivergenceView> {
	const volumeFraction = options.volumeFraction ?? configuredVolumeFraction();
	const missing = options.missingConfiguration ?? missingFantraxConfiguration();
	const client = await gateway.connect();
	try {
		const latest = await readLatest(client, LATEST_READ_SQL);

		// **Not configured is stated BEFORE never-read**, because a deployment
		// that cannot read is not a deployment that has not yet read, and only
		// the second resolves by waiting. Reporting the first as the second is
		// the AD-19 shape — an outage wearing the face of health.
		if (latest === null && missing.length > 0) {
			return { read: { kind: 'not_configured', missing }, report: null, volumeFraction };
		}

		if (latest === null) {
			return { read: { kind: 'never_read' }, report: null, volumeFraction };
		}

		// **A failed latest read RAISES NOTHING.** The frozen I/O matrix is
		// explicit — "Read fails → renders stopped with the reason and the time of
		// the last good read | nothing raised" — and the reason is sound: an
		// stale membership compared against a roster that has moved since would
		// propose acts against a world nobody has confirmed. The last good read's
		// time is still named, so the Commissioner knows exactly how stale the
		// silence is.
		if (latest.outcome !== 'ok') {
			const lastGood = await readLatest(client, LATEST_OK_READ_SQL);
			return {
				read: {
					kind: 'stopped',
					outcome: latest.outcome,
					detail: latest.detail,
					failedAt: latest.readAt,
					lastGoodReadAt: lastGood?.readAt ?? null
				},
				report: null,
				volumeFraction
			};
		}

		if (latest.membership === null) {
			// An `ok` row whose stored JSON will not read back as a membership.
			// Stated, never silent.
			return { read: { kind: 'unreadable', readAt: latest.readAt }, report: null, volumeFraction };
		}

		const teams = await loadTeams(client);
		const appMembers = await loadAppMembers(client);
		const events = await loadEventsViaClient(client);
		const contracts = fold(INITIAL_CONTRACTS, events, contractsReducer);
		const dismissedFingerprints = await loadDismissals(client);

		return {
			read: { kind: 'read', readAt: latest.readAt, moneyWarnings: latest.moneyWarnings },
			report: compareMembership({
				teams,
				appMembers,
				fantraxMembers: fantraxMembersFrom(latest.membership),
				// The KEYS of the stored membership, which is what makes "Fantrax
				// returned an empty roster for this Team" distinguishable from
				// "Fantrax returned no roster for this Team" — see the input type.
				fantraxTeamIds: Object.keys(latest.membership),
				contracts,
				// **Both sides canonicalised HERE, by the shell, with the adapter's
				// one function.** The pure core normalises nothing and knows no
				// Fantrax string format (AD-24); this is the single place the
				// `01eon` the API answers and the `*04ewu*` the FR-1 importer stored
				// are brought into one form, so they cannot drift apart.
				canonicalContractIds: Object.keys(contracts.byPlayer).map(
					(key) => [key, normaliseFantraxPlayerId(key)] as const
				),
				volumeFraction,
				dismissedFingerprints
			}),
			volumeFraction
		};
	} finally {
		releaseQuietly(client, 'loadDivergenceView');
	}
}

/**
 * Record one dismissal — or one acknowledgement of a tripped guard, which is
 * the same row keyed on the guard's own fingerprint.
 *
 * **No event, no reason and no lock.** A dismissal changes nothing the
 * arithmetic computes: it says "not now" about an unconfirmed reading of a
 * third-party system, and it undoes itself the moment the underlying
 * difference changes, because the fingerprint is derived from content alone.
 */
export async function dismissDivergence(
	gateway: ConnectionGateway,
	fingerprint: string,
	dismissedBy: string | null
): Promise<void> {
	const client = await gateway.connect();
	try {
		await client.query(INSERT_DISMISSAL_SQL, [fingerprint, dismissedBy]);
	} finally {
		releaseQuietly(client, 'dismissDivergence');
	}
}

// --- Reads ------------------------------------------------------------------

async function readLatest(client: TransactionalClient, sql: string): Promise<StoredRead | null> {
	const result = await client.query(sql);
	const row = result.rows[0];
	if (row === undefined) return null;
	return {
		readAt: instantFrom(row['read_at']),
		outcome: String(row['outcome'] ?? ''),
		detail: row['detail'] === null || row['detail'] === undefined ? null : String(row['detail']),
		membership: membershipFrom(row['membership']),
		moneyWarnings: warningNamesFrom(row['money_warnings'])
	};
}

async function loadTeams(client: TransactionalClient): Promise<readonly DivergenceTeam[]> {
	const result = await client.query(DIVERGENCE_TEAMS_SQL);
	return result.rows.map((row) => {
		const raw = row['fantrax_team_id'];
		const id = raw === null || raw === undefined ? '' : String(raw).trim();
		return {
			teamId: String(row['id'] ?? ''),
			teamName: String(row['name'] ?? ''),
			// A blank is the same absence as a NULL. Treating `''` as a mapped id
			// would bind every unmapped Team to one another's roster.
			fantraxTeamId: id === '' ? null : id
		};
	});
}

async function loadAppMembers(client: TransactionalClient): Promise<readonly AppRosterMember[]> {
	const result = await client.query(DIVERGENCE_ROSTERS_SQL);
	return result.rows.map((row) => {
		// Verbatim — asterisks included. The pre-filled link names exactly this.
		const fantraxPlayerId = String(row['fantrax_player_id'] ?? '');
		return {
			teamId: String(row['team_id'] ?? ''),
			// Canonicalised HERE, by the shell, with the adapter's one function.
			playerId: normaliseFantraxPlayerId(fantraxPlayerId),
			fantraxPlayerId,
			playerName: String(row['player_name'] ?? ''),
			rosterSlotKind: String(row['roster_slot_kind'] ?? 'active_bench') as RosterSlotKind
		};
	});
}

async function loadDismissals(client: TransactionalClient): Promise<readonly string[]> {
	const result = await client.query(DISMISSALS_SQL);
	return result.rows.map((row) => String(row['fingerprint'] ?? '')).filter((value) => value !== '');
}

/** The stored membership, flattened into the shape the core compares. */
export function fantraxMembersFrom(membership: StoredMembership): readonly FantraxMember[] {
	const members: FantraxMember[] = [];
	for (const fantraxTeamId of Object.keys(membership).sort()) {
		if (!Object.prototype.hasOwnProperty.call(membership, fantraxTeamId)) continue;
		for (const member of membership[fantraxTeamId] ?? []) {
			members.push({
				fantraxTeamId,
				// Canonicalised again on the way out, so the two sides of the
				// comparison are brought into one form in ONE place whatever shape
				// an older stored row happens to carry.
				playerId: normaliseFantraxPlayerId(member.playerId),
				playerName: member.playerName,
				rosterSlotKind: member.rosterSlotKind
			});
		}
	}
	return members;
}

/**
 * The `jsonb` column, read back defensively.
 *
 * node-postgres hands `jsonb` back already parsed; a row written by an older
 * shape, or by hand, could be anything. A membership that will not read is the
 * same as no membership — the surface then says so rather than comparing
 * against a guess.
 */
function membershipFrom(value: unknown): StoredMembership | null {
	const parsed = typeof value === 'string' ? safeParse(value) : value;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const out: Record<
		string,
		ReadonlyArray<{ playerId: string; playerName: string; rosterSlotKind: RosterSlotKind }>
	> = {};
	for (const key of Object.keys(parsed as Record<string, unknown>)) {
		const rows = (parsed as Record<string, unknown>)[key];
		if (!Array.isArray(rows)) return null;
		const members: Array<{
			playerId: string;
			playerName: string;
			rosterSlotKind: RosterSlotKind;
		}> = [];
		for (const row of rows) {
			// **Refused, never coerced.** `(row ?? {})` would turn a `null`, a
			// number or a string into a member with a blank id and a blank name —
			// a Player the app cannot match, on a roster it will then propose
			// acts about. A membership that will not read is no membership, and
			// the surface has a stated branch for exactly that.
			if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
			const record = row as Record<string, unknown>;
			const playerId = record['playerId'];
			if (typeof playerId !== 'string' || playerId.trim() === '') return null;
			members.push({
				playerId,
				playerName: typeof record['playerName'] === 'string' ? record['playerName'] : playerId,
				rosterSlotKind: String(record['rosterSlotKind'] ?? 'active_bench') as RosterSlotKind
			});
		}
		out[key] = members;
	}
	return out;
}

/**
 * The `money_warnings` column, read back defensively.
 *
 * A row written before this column existed, or by hand, is not an array. An
 * unreadable warning list is an EMPTY one rather than a refusal: the warning is
 * advisory and the membership is the fact, so a malformed warnings column must
 * not take a read's whole comparison down with it.
 */
function warningNamesFrom(value: unknown): readonly string[] {
	const parsed = typeof value === 'string' ? safeParse(value) : value;
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * How much of a `detail` sentence may reach `fantrax_reads.detail`.
 *
 * `adapters/fantrax/roster-api.ts`'s own cap, restated on this side for the
 * same reason and applied to the SUCCESS path too: a read of thirty Teams can
 * name a great many off-grid figures, and a column that is unbounded on one
 * path and bounded on the other four is bounded by accident rather than by
 * design.
 */
const MAX_DETAIL_LENGTH = 500;

function truncateDetail(text: string): string {
	if (text.length <= MAX_DETAIL_LENGTH) return text;
	return `${text.slice(0, MAX_DETAIL_LENGTH)}… [truncated, ${String(text.length)} characters]`;
}

/** A `timestamptz` as an ISO instant, whichever shape the driver handed back. */
function instantFrom(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	return String(value ?? '');
}

function releaseQuietly(client: { release?: () => void }, where: string): void {
	try {
		client.release?.();
	} catch (error) {
		console.error(`${where}: releasing the read connection failed`, error);
	}
}

// --- Configuration ----------------------------------------------------------

/**
 * The Fantrax variables the reader needs, in one list.
 *
 * Named once, so the "which are missing" report and the port that reads them
 * cannot disagree about what the set is.
 */
export const FANTRAX_READ_VARIABLES: readonly string[] = Object.freeze([
	'FANTRAX_BASE_URL',
	'FANTRAX_LEAGUE_ID',
	'FANTRAX_PERIOD'
]);

/**
 * Which of them are unset or blank, in the order above. Empty means configured.
 *
 * **A first-class answer rather than a thrown error**, because a deployment
 * that was never configured is a state the surface has to STATE. Letting the
 * port constructor throw made a never-configured deployment answer exactly as a
 * failed insert does, appending no `fantrax_reads` row at all — which is the
 * outage that looks like health, in the story written to prevent it.
 */
export function missingFantraxConfiguration(): readonly string[] {
	return FANTRAX_READ_VARIABLES.filter((name) => {
		const value = env[name];
		return value === undefined || value.trim() === '';
	});
}

/**
 * The effective plausibility fraction: the environment's, or the core default.
 *
 * **The one value in `core/constants.ts` an environment variable may edit**,
 * and FR-42 requires it: the guard must trip at a new threshold after a
 * restart with no code change. A value that is not a number strictly between 0
 * and 1 is IGNORED rather than obeyed — a typo'd `25` would set the threshold
 * at twenty-five times the League and disarm the guard entirely, which is the
 * one outcome a misconfiguration here must not be able to produce.
 */
export function configuredVolumeFraction(): number {
	const raw = env['DIVERGENCE_VOLUME_FRACTION'];
	if (raw === undefined || raw.trim() === '') return DIVERGENCE_VOLUME_FRACTION;
	const parsed = Number(raw.trim());
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
		console.error(
			`DIVERGENCE_VOLUME_FRACTION is ${JSON.stringify(raw)}, which is not a fraction strictly between 0 and 1. Using the core default.`
		);
		return DIVERGENCE_VOLUME_FRACTION;
	}
	return parsed;
}

/**
 * How long one Fantrax read may take before it is abandoned.
 *
 * Chosen against `DIVERGENCE_READ_INTERVAL` the way `LIVENESS_TIMEOUT` is
 * chosen against `LIVENESS_INTERVAL`: far inside it, so a request that hangs
 * is aborted long before the next read rather than accumulating in flight. An
 * undocumented third party can hang where a webhook does not, and an abandoned
 * request becomes a recorded `unreachable` rather than an open socket.
 */
export const FANTRAX_READ_TIMEOUT = 30 * 1000;

/**
 * The configured reader, or `null` when a variable it needs is unset.
 *
 * **Returns rather than throws** — see `missingFantraxConfiguration`. The
 * endpoint builds this BEFORE it opens the try that records a read, so a
 * misconfiguration answers with its own status and its own wording naming the
 * missing variable, and is never mistaken for a write that failed.
 *
 * **Every Fantrax name it needs is a parameter it passes INTO the adapter**
 * (AD-24): this function knows the names of four environment variables and the
 * adapter knows what a Fantrax request looks like. Nothing outside
 * `adapters/fantrax/` learns that the endpoint exists, and `$env` is read here
 * rather than there so the adapter stays Deno-loadable and testable with a
 * hand-built transport.
 *
 * No database client is passed and none can be (AD-32).
 */
export function configuredFantraxPort(input: {
	readonly fetch: FetchLike;
	readonly signal?: AbortSignal | undefined;
}): FantraxRosterPort | null {
	if (missingFantraxConfiguration().length > 0) return null;
	return createFantraxRosterPort({
		baseUrl: String(env['FANTRAX_BASE_URL']).trim(),
		leagueId: String(env['FANTRAX_LEAGUE_ID']).trim(),
		period: String(env['FANTRAX_PERIOD']).trim(),
		fetch: input.fetch,
		signal: input.signal
	});
}

/** The status a never-configured deployment's invocation receives. */
export const NOT_CONFIGURED_STATUS = 503;

/**
 * The header the scheduled cron job presents. Named in
 * `supabase/migrations/20260915000000_fantrax_divergence.sql`, not guessed.
 *
 * Deliberately NOT the tick's `x-tick-invocation-secret`: two jobs that share
 * one secret cannot be revoked separately, and this one is presented to a route
 * that reaches a third party while the tick's reaches the auction itself.
 *
 * Declared here rather than in `routes/api/fantrax-read/+server.ts` because a
 * `+server.ts` may export only SvelteKit's own names — an extra export fails
 * the build outright.
 */
export const FANTRAX_READ_SECRET_HEADER = 'x-fantrax-read-invocation-secret';

/** The status an unauthorised caller receives, with a bare body and nothing else. */
export const UNAUTHORISED_STATUS = 401;

/**
 * The status a read whose RECORD could not be written receives.
 *
 * The ONLY non-2xx this endpoint answers apart from 401. An unreachable
 * Fantrax, a 429, a 5xx and malformed JSON are all normal outcomes of asking an
 * undocumented third party a question, and each appends a row the surface
 * renders as *stopped* — the scheduler has nothing to retry for those. A read
 * that left no record is the outage that looks like health (AD-19), and that is
 * the one thing the scheduler must see.
 */
export const RECORD_FAILED_STATUS = 500;

/** The shared secret `/api/fantrax-read` demands, or `undefined` when unset. */
export function fantraxReadInvocationSecret(): string | undefined {
	const value = env['FANTRAX_READ_INVOCATION_SECRET'];
	return value === undefined || value.trim() === '' ? undefined : value.trim();
}
