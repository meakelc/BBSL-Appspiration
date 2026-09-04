/**
 * Which mention categories exist, which single one a Manager may mute, and the
 * refusal for a request to mute any other. Story 5.4, FR-27, AD-18.
 *
 * **Pure.** No I/O, no clock, relative `.ts` imports only (AD-2) — and today,
 * no imports at all. `adapters/discord/mention.ts` reaches this to name the
 * category it is about to render, and `routes/notifications/+page.server.ts`
 * reaches it to decide whether a posted request is one it may honour. Both
 * read one definition, so a category that becomes mutable becomes mutable in
 * exactly one place.
 *
 * **Exactly one category is mutable, and it is `slot_release`.** FR-27 names
 * three candidates; only this one both has a trigger of its own and is
 * genuinely optional. The unbid-Nomination 24-hour warning was removed from
 * scope by user decision (2026-09-04). "Closes for Auctions their Team did not
 * lead or contend in" has no population: `server/close.ts`'s
 * `affectedTeamsForClose` addresses the leader and the nominator and nobody
 * else, so a Team that neither led nor contended is never mentioned on a close
 * at all, and the category reduces to a strict subset of `slot_release`.
 *
 * **Muting suppresses ONE MANAGER'S MENTION, never the post and never the
 * Team's line.** The preference is keyed on `managers.id`, so it is a fact
 * about the person and not about their Team: the broadcast notice still posts,
 * still names the Team and still states what happened, and a co-Manager of the
 * same Team who has not muted is still mentioned on the very same line. Every
 * sentence below has the READER as its subject for that reason — wording it as
 * "your Team is not mentioned" would be false in exactly the co-managed case
 * the story's matrix singles out, and a control that read as "turn this notice
 * off" would be describing something else again.
 *
 * **The unmutable categories carry their REASON, not merely an absence.** A
 * page that simply omitted a control would leave a Manager to guess whether
 * the setting is missing or refused. Each reason is stated once, here, and the
 * page prints it.
 *
 * Product voice, `core/rules/eligibility.ts`'s verbatim: state the fact, then
 * the arithmetic. No apology, no exclamation mark, no advice.
 */

/**
 * Every category a mention can belong to.
 *
 * These are not event types: `AuctionClosed` produces two of them depending on
 * whether the addressed Team led the Auction or merely had its Nomination Slot
 * released by the close, which is the distinction the whole story turns on.
 */
export type NotificationCategory =
	| 'outbid'
	| 'led_at_close'
	| 'slot_release'
	| 'contender'
	| 'contract_assignment';

/**
 * The one category a Manager may mute.
 *
 * A single value rather than a set, deliberately: a set invites a second entry
 * without the argument that earned the first one. See the header.
 */
export const MUTABLE_NOTIFICATION_CATEGORY = 'slot_release' as const;

/** The type of the one mutable category, so a caller cannot widen it silently. */
export type MutableNotificationCategory = typeof MUTABLE_NOTIFICATION_CATEGORY;

/**
 * Every category that is NOT mutable, derived rather than listed.
 *
 * The refusal for "that category cannot be muted" takes this rather than
 * `NotificationCategory`, so `{ kind: 'unmutable_category', category:
 * 'slot_release' }` is UNCONSTRUCTIBLE instead of merely unreached — as the
 * wider type it would have rendered a sentence claiming the mutable category
 * cannot be muted, with an empty reason clause where the reason belongs.
 * Derived with `Exclude` so adding a second mutable category removes it from
 * here in the same edit.
 */
export type UnmutableNotificationCategory = Exclude<
	NotificationCategory,
	MutableNotificationCategory
>;

/** What one category is called, what its notice says, and whether it is mutable. */
export type NotificationCategoryCopy = {
	readonly id: NotificationCategory;
	/** The category's name, as the settings page heads it. */
	readonly label: string;
	/** What the notice tells the reader — one sentence, no urgency framing. */
	readonly statement: string;
	/**
	 * Why this category carries no control, or `null` for the mutable one.
	 *
	 * Stated rather than implied: the page lists every unmutable category with
	 * this sentence beside it, so the absence of a control is legible as a
	 * decision instead of an omission.
	 */
	readonly unmutableReason: string | null;
};

/**
 * Every category, in the order the page lists them: the mutable one first,
 * then the four that are not. The order is not a sort and no control changes
 * it.
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategoryCopy[] = [
	{
		id: 'slot_release',
		label: 'Nomination Slot released',
		statement: 'A close released the Nomination Slot your Team was holding.',
		unmutableReason: null
	},
	{
		id: 'outbid',
		label: 'Outbid',
		statement: 'Another Team took the leading Bid on an Auction your Team was leading.',
		// The second sentence this once carried — that an Auction can be taken
		// while you are asleep — was urgency framing, which this story's
		// boundaries forbid and which the Positions surface already rejected in
		// the same words. The fairness premise is the whole reason and states
		// itself.
		unmutableReason:
			'Muting an outbid notice would undermine the fairness premise of a 24/7 clock.'
	},
	{
		id: 'led_at_close',
		label: 'Led an Auction at its close',
		statement: 'Your Team led an Auction at the moment it closed.',
		unmutableReason:
			'The close is where a Contract is decided. This is the notice that reports an ' +
			'outcome your Team is bound by, and there is no later surface that announces it.'
	},
	{
		id: 'contender',
		label: 'Contender in a draw',
		statement: 'Your Team was a Contender in a Minimum-Bid Contention draw.',
		unmutableReason:
			'A draw is resolved without a further Bid from any Contender, so the mention is ' +
			'the only place the draw is announced to the Teams it involved.'
	},
	{
		id: 'contract_assignment',
		label: 'Contract Assignment opened',
		statement: 'Contract Assignment is open for the league.',
		unmutableReason:
			'It is announced once, to every Team at once, and it opens the window in which ' +
			'each Team assigns its Contracts.'
	}
];

/** The copy for one category, or `null` for an id no module names. */
export function notificationCategoryCopy(id: string): NotificationCategoryCopy | null {
	return NOTIFICATION_CATEGORIES.find((category) => category.id === id) ?? null;
}

/** Whether `value` names a category at all. */
export function isNotificationCategory(value: unknown): value is NotificationCategory {
	return typeof value === 'string' && notificationCategoryCopy(value) !== null;
}

/**
 * Whether `value` names the one category a Manager may mute.
 *
 * The server-side gate. A posted request that fails this is REFUSED with the
 * wording below, never silently ignored — "the control was absent from the
 * page" is not a check.
 */
export function isMutableNotificationCategory(
	value: unknown
): value is MutableNotificationCategory {
	return value === MUTABLE_NOTIFICATION_CATEGORY;
}

/**
 * What muting the one mutable category does, in words.
 *
 * Two sentences and never one: the first says what stops, the second says what
 * does not, because the whole design of this story is that the second half
 * survives the mute. A bare toggle would state neither.
 */
export const MUTABLE_CATEGORY_MUTE_EFFECT =
	'Muting this withholds your own mention: you are no longer pinged when a close ' +
	'releases the Nomination Slot your Team was holding.';

export const MUTABLE_CATEGORY_MUTE_LIMIT =
	'The notice still posts in the league channel, still names your Team and still states ' +
	'that the Slot was released. A co-Manager of your Team who has not muted this is still ' +
	'mentioned on it. Muting withholds your mention, never the post.';

/** The two states of the one control, worded so neither reads as the default. */
export const MUTABLE_CATEGORY_MUTED_STATEMENT =
	'This category is muted. The notice posts and names your Team; you are not mentioned ' +
	'on it.';

export const MUTABLE_CATEGORY_UNMUTED_STATEMENT =
	'This category is not muted. You are mentioned on the notice, which is the default ' +
	'for a Manager who has set nothing.';

/**
 * Why a request to change a mute was refused.
 *
 * All four are decided by the route before anything is written, because none
 * of them has anything to decide about against stored state: `unmutable_category`
 * because the category is a fact about the codebase, `unknown_category` because
 * no such category exists to write a row for, `unstated_target` because which
 * way the change was meant is unknowable from the submission, and
 * `unregistered_actor` because a preference row is keyed on `managers.id` and an
 * unregistered session names no Manager. All four are worded here anyway, so the
 * route words no refusal of its own.
 */
export type NotificationMuteRefusal =
	| { readonly kind: 'unmutable_category'; readonly category: UnmutableNotificationCategory }
	| { readonly kind: 'unknown_category'; readonly requested: string }
	| { readonly kind: 'unstated_target' }
	| { readonly kind: 'unregistered_actor' };

/**
 * How much of an unrecognised category id the refusal repeats back.
 *
 * The id is named so the sentence is actionable, and clamped so a submission
 * carrying a kilobyte in that field cannot turn a refusal into a wall of the
 * sender's own text.
 */
const ECHOED_ID_LIMIT = 60;

/**
 * `requested`, trimmed, clamped and quoted — or a stated absence.
 *
 * **Clamped by CODE POINT, not by code unit.** `String.slice` counts UTF-16
 * units, so a cut landing between the halves of a surrogate pair would put a
 * lone surrogate in a sentence a page then renders — `Array.from` iterates code
 * points, so the cut can only ever fall between whole characters.
 *
 * **Embedded double quotes are escaped**, because the value is the sender's own
 * text and this function wraps it in double quotes: an id containing one would
 * otherwise close the quotation early and leave a mismatched pair in the middle
 * of a refusal.
 */
function echoed(requested: string): string {
	const trimmed = requested.trim();
	if (trimmed === '') return 'a blank id';
	const points = Array.from(trimmed);
	const clamped =
		points.length <= ECHOED_ID_LIMIT ? trimmed : points.slice(0, ECHOED_ID_LIMIT).join('');
	return `"${clamped.replace(/"/g, '\\"')}"`;
}

/** The label of the one mutable category, for a sentence that names the way through. */
function mutableLabel(): string {
	return (
		notificationCategoryCopy(MUTABLE_NOTIFICATION_CATEGORY)?.label ?? MUTABLE_NOTIFICATION_CATEGORY
	);
}

/**
 * The one refusal sentence for each case.
 *
 * Every one ends with "Nothing was written", because in every one of these
 * cases nothing is — the route returns before it reaches a write.
 */
export function notificationMuteRefusalDetail(refusal: NotificationMuteRefusal): string {
	switch (refusal.kind) {
		case 'unmutable_category': {
			// The reason is present for every category this variant can name —
			// `UnmutableNotificationCategory` excludes the one entry whose
			// `unmutableReason` is `null`. The fallbacks below are the lookup's,
			// not the wording's: `notificationCategoryCopy` answers `null` for
			// an id no module names, which the type already rules out here.
			const copy = notificationCategoryCopy(refusal.category);
			const reason = copy?.unmutableReason ?? null;
			return (
				`The change was refused: ${copy?.label ?? refusal.category} cannot be muted. ` +
				`${reason === null ? '' : `${reason} `}` +
				`${mutableLabel()} is the one category this league allows a Manager to mute. ` +
				'Nothing was written.'
			);
		}
		case 'unknown_category':
			return (
				`The change was refused: no notification category is named ${echoed(refusal.requested)}. ` +
				`${mutableLabel()} is the one category this league allows a Manager to mute. ` +
				'Nothing was written.'
			);
		case 'unstated_target':
			return (
				'The change was refused: the submission did not state whether to mute or unmute ' +
				'the category. Either value would have been a guess at what was meant. Nothing ' +
				'was written.'
			);
		case 'unregistered_actor':
			return (
				'The change was refused: the session is not a registered Manager, so there is ' +
				'nobody for a preference to belong to. Nothing was written.'
			);
	}
}

/**
 * The state the control is in, as a sentence.
 *
 * The page prints this beside the control rather than relying on the control's
 * own affordance, so the state reads as words and never as a tick mark alone —
 * a greyscale screenshot of this page states which state it is in.
 */
export function notificationMuteStateDetail(muted: boolean): string {
	return muted ? MUTABLE_CATEGORY_MUTED_STATEMENT : MUTABLE_CATEGORY_UNMUTED_STATEMENT;
}

/**
 * The sentence a Manager reads when a change landed.
 *
 * Distinct from `notificationMuteStateDetail` on purpose: one says what the
 * setting IS, the other says that a submission was accepted. Printing the same
 * sentence for both would leave a Manager unable to tell a page they merely
 * loaded from one they just changed.
 */
export function notificationMuteOutcomeDetail(muted: boolean): string {
	return muted
		? 'The change was accepted: this category is muted. The notice still posts and still ' +
				'names your Team; you are no longer mentioned on it.'
		: 'The change was accepted: this category is not muted. You are mentioned on the ' +
				'notice, which is the default.';
}
