/**
 * The Commissioner override record, and the reason without which it cannot
 * exist. Pure (Story 7.1).
 *
 * **The other half of the Commissioner control class.** Epic 1 shipped the
 * four visual properties (`styles/commissioner.css`) and the server-side
 * Commissioner guard. The class's other half — *no Commissioner act is ever a
 * single tap* — is this module: every override carries who acted, what the
 * state was, what the state became, and why, and the "why" is not optional in
 * the sense a validation message is optional. It is structural. There is no
 * exported way to obtain an `OverrideRecord` whose `reason` is blank, so "no
 * override path can skip the reason" is a property of the type rather than a
 * thing every future override route has to remember.
 *
 * **Why the reason is not a database column.**
 * `supabase/migrations/20260821020000_auction_events.sql:24-30` states the
 * table "has no opinion on what `event_type` values are legal", so a `check`
 * keyed on the override event types contradicts its stated design, and an
 * unkeyed `not null` column breaks every existing insert. The reason travels
 * in the event `payload`; this type is what makes it present.
 *
 * **Nothing here emits an event, and no override exists yet.** This module
 * ships with zero call sites, exactly as `server/commissioner-guard.ts` did:
 * Story 7.2 adds the first override and reaches for this rather than
 * inventing a record shape under deadline.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2).
 */

/**
 * The form field the reason arrives in.
 *
 * Declared here, in the core, because both sides need the same string and
 * neither may import the other: `server/override-guard.ts` parses it out of
 * submitted form data, and `reason-sheet-view.ts` names the field the sheet
 * renders. A literal `'reason'` written twice is a rename waiting to
 * silently disarm the guard.
 */
export const OVERRIDE_REASON_FIELD = 'reason';

/**
 * Why a reason was not acceptable.
 *
 * Two kinds rather than one, because they are two different mistakes and a
 * later surface may want to distinguish them: `absent` is a submission with
 * no reason field at all — a hand-rolled POST, or a sheet that was bypassed
 * — and `blank` is a field that arrived carrying only whitespace. Both are
 * refused identically today (the I/O matrix requires "identical refusal"),
 * and the wording lives in the shell guard, not here.
 */
export type ReasonRefusal = { readonly kind: 'absent' } | { readonly kind: 'blank' };

/** A validated reason, or why it was refused. Never a throw — this is the core. */
export type ReasonOutcome =
	| { readonly ok: true; readonly reason: string }
	| { readonly ok: false; readonly refusal: ReasonRefusal };

/**
 * Everything that looks like nothing, at either edge of a reason.
 *
 * `\s` is every Unicode whitespace character and every line terminator — the
 * set `String.prototype.trim` itself removes, which covers the spaces, tabs
 * and newlines a `<textarea>` submits, plus the non-breaking space and the
 * ideographic space a paste can carry in.
 *
 * The four code points named explicitly are the ones `trim()` does NOT
 * remove, because they are formatting characters rather than whitespace:
 * U+200B zero-width space, U+200C zero-width non-joiner, U+200D zero-width
 * joiner, and U+FEFF the byte-order mark. A reason consisting only of those
 * survives `trim()` with a non-zero length and renders as an empty permanent
 * Audit Log entry — a record that asserts something was explained, showing
 * nothing. That is the exact failure this module exists to make unreachable,
 * so they count as blank.
 *
 * **Edges only, never the interior.** U+200D is the joiner inside every
 * multi-part emoji, and U+200C is load-bearing in Persian and Indic scripts;
 * stripping them globally would silently corrupt a reason somebody typed. A
 * reason with visible content keeps its interior exactly as written.
 */
const BLANK_EDGES = /^[\s\u200b\u200c\u200d\ufeff]+|[\s\u200b\u200c\u200d\ufeff]+$/gu;

/**
 * Strip the leading and trailing nothing from a reason.
 *
 * Exported so the shell and the tests measure blankness the same way this
 * module does, rather than each reaching for `trim()` and disagreeing about
 * the zero-width cases.
 */
export function trimReason(raw: string): string {
	return raw.replace(BLANK_EDGES, '');
}

/**
 * Validate a submitted reason.
 *
 * **Blank means blank after `trimReason()`.** A reason of spaces, tabs,
 * newlines, zero-width characters or any mixture of them is not a reason, and
 * the Audit Log entry it would produce is worse than no entry: it is a
 * permanent record that asserts something was explained when nothing was.
 *
 * Takes `unknown` deliberately. The caller's value comes from
 * `FormData.get()`, which returns `string | File | null`, and a `File` named
 * `reason` is an absent reason rather than a type error to throw over.
 *
 * The returned reason is the TRIMMED text — the record stores what the
 * Commissioner meant, not their trailing newline.
 */
export function validateReason(raw: unknown): ReasonOutcome {
	if (typeof raw !== 'string') return { ok: false, refusal: { kind: 'absent' } };
	const reason = trimReason(raw);
	if (reason.length === 0) return { ok: false, refusal: { kind: 'blank' } };
	return { ok: true, reason };
}

/**
 * The acting Commissioner, resolved server-side from the session's
 * `managers` row (AD-15) — never from a form field.
 *
 * `auction_events` has no `actor` column: `manager_id` and `team_id` carry
 * the actor and the `payload` carries the rest (`shell/write.ts:170-177`).
 * The actor is named here anyway, because a record whose actor is implicit
 * in a column somewhere else is a record that can be constructed without one.
 *
 * `teamId` is the Commissioner's own bound Team, present for the same reason
 * every other Manager's is: it is the actor column's other half. It confers
 * nothing. Nothing in this epic gives the Commissioner's own Team a different
 * Cap Space, Maximum Bid or Nomination Slot, and this field is not the place
 * that would start.
 */
export type OverrideActor = {
	readonly managerId: string;
	readonly teamId: string;
	readonly displayName: string;
};

/**
 * One side of an override — the state as it stands, or as it will stand.
 *
 * A plain field-name to stated-value map rather than a domain type, because
 * this module must hold every override Epic 7 will add without being edited
 * for each one, and the values it holds are the ones the sheet will show a
 * human. The rendering to words has already happened by the time a value
 * reaches here (`describeAmount` is the core's one money renderer, AD-8);
 * this is a record of what was said, not a place to say it.
 */
export type OverrideState = { readonly [field: string]: string };

/**
 * The brand that makes `OverrideRecord` NOMINAL rather than structural.
 *
 * Without it, `OverrideRecord` is a plain object shape and
 * `const record: OverrideRecord = { actor, before, after, reason: '   ' }`
 * typechecks — which would make the whole structural argument of this module
 * a comment. The symbol is `declare`d, so it has no runtime existence and
 * costs the payload nothing; and it is NOT exported, so no module outside
 * this file can name it, satisfy it, or cast to it by writing the shape out.
 * `buildOverrideRecord` below is therefore the only expression in the
 * repository that can produce this type.
 */
declare const OVERRIDE_RECORD: unique symbol;

/** An override, complete: who, from what, to what, and why. */
export type OverrideRecord = {
	/** Present only on the type. Unnameable outside this module — see above. */
	readonly [OVERRIDE_RECORD]: true;
	readonly actor: OverrideActor;
	readonly before: OverrideState;
	readonly after: OverrideState;
	/** Non-blank, trimmed. Unconstructible otherwise — see `buildOverrideRecord`. */
	readonly reason: string;
};

/** A built record, or why it was refused. Never a throw — this is the core. */
export type OverrideRecordOutcome =
	| { readonly ok: true; readonly record: OverrideRecord }
	| { readonly ok: false; readonly refusal: ReasonRefusal };

/**
 * The ONLY way to obtain an `OverrideRecord`.
 *
 * Refuses rather than throws, and refuses rather than repairing: there is no
 * default reason, no "(none given)" and no partial record handed back for a
 * caller to finish. A caller that ignores the outcome has nothing to append.
 *
 * The reason it stores is `validateReason`'s trimmed text, so two callers
 * that differ only in trailing whitespace produce the same permanent record.
 *
 * The assertion on the return is the ONE place the brand is applied, and it
 * sits immediately after the only check that can refuse — which is what makes
 * "no override path can skip the reason" a fact about the type system rather
 * than a thing a future route has to remember.
 */
export function buildOverrideRecord(input: {
	readonly actor: OverrideActor;
	readonly before: OverrideState;
	readonly after: OverrideState;
	readonly reason: unknown;
}): OverrideRecordOutcome {
	const outcome = validateReason(input.reason);
	if (!outcome.ok) return { ok: false, refusal: outcome.refusal };
	const record = {
		actor: input.actor,
		before: input.before,
		after: input.after,
		reason: outcome.reason
	} as OverrideRecord;
	return { ok: true, record };
}
