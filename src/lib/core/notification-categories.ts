/**
 * Which mention categories exist, and the refusal for a request to mute any of
 * them. Story 5.4, FR-27, AD-18.
 *
 * **Pure.** No I/O, no clock, relative `.ts` imports only (AD-2) — and today,
 * no imports at all. `adapters/discord/mention.ts` reaches this to name the
 * category it is about to render, and `routes/notifications/+page.server.ts`
 * reaches it to decide whether a posted request is one it may honour. Both
 * read one definition, so a category that becomes mutable becomes mutable in
 * exactly one place.
 *
 * **NO CATEGORY IS MUTABLE, and one used to be.** Story 5.4 shipped
 * `slot_release` as the single mutable category: a close freed the NOMINATING
 * Team's Nomination Slot, which was a notice of its own, addressed to somebody
 * who had not necessarily won anything, and genuinely optional. FR-9 was then
 * amended — a Slot is released by WINNING a Player, never by the nominated
 * Player's Auction closing — and that notice had nobody left to send to. The
 * Slot release is now half a sentence on the WINNER's close line
 * (`adapters/discord/mention.ts`), and the other half of that line reports a
 * Contract the Team is bound by, which was never mutable and is not now.
 *
 * FR-27's other two candidates are still unavailable for the reasons they
 * always were. The unbid-Nomination 24-hour warning was removed from scope by
 * user decision (2026-09-04). "Closes for Auctions their Team did not lead or
 * contend in" has no population at all: `server/close.ts`'s
 * `affectedTeamsForClose` addresses the winner and nobody else, so a Team that
 * neither won nor contended is never mentioned on a close.
 *
 * So the settings page has no control, and says so rather than looking broken.
 *
 * **Every category carries its REASON, not merely an absence.** A page that
 * simply omitted a control would leave a Manager to guess whether the setting
 * is missing or refused. Each reason is stated once, here, and the page prints
 * it.
 *
 * **The sentences still have the READER as their subject**, which is what they
 * had while the mute existed and is worth keeping: a notice mentions Managers
 * individually even though it names one Team, and a co-managed Team's line
 * carries two `<@id>`.
 *
 * Product voice, `core/rules/eligibility.ts`'s verbatim: state the fact, then
 * the arithmetic. No apology, no exclamation mark, no advice.
 */

/**
 * Every category a mention can belong to.
 *
 * These are not event types, and they no longer map one-to-one onto them
 * either: `AuctionClosed` is `led_at_close` for the Team that won it and
 * belongs to no category for anybody else, because it addresses nobody else.
 * It used to produce a second category, `slot_release`, for the nominator —
 * see the header for why that one is gone.
 */
export type NotificationCategory =
	| 'outbid'
	| 'led_at_close'
	| 'contender'
	| 'contract_assignment';

/**
 * Every category that cannot be muted — which is every category.
 *
 * Kept as its own name rather than collapsed into `NotificationCategory`, so
 * that the refusal below keeps saying what it is about, and so that a league
 * which ever makes one mutable again narrows this with `Exclude` in one edit
 * instead of re-threading the refusal's type.
 */
export type UnmutableNotificationCategory = NotificationCategory;

/**
 * Every category a Manager may mute. EMPTY, and empty as data rather than as a
 * deleted function: the gate below reads this list, so a league that ever
 * makes one mutable again adds one entry here and the refusal, the route and
 * the page all follow.
 */
export const MUTABLE_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [];

/** What one category is called, what its notice says, and why it has no control. */
export type NotificationCategoryCopy = {
	readonly id: NotificationCategory;
	/** The category's name, as the settings page heads it. */
	readonly label: string;
	/** What the notice tells the reader — one sentence, no urgency framing. */
	readonly statement: string;
	/**
	 * Why this category carries no control.
	 *
	 * Stated rather than implied, and no longer nullable: every category is
	 * unmutable, so a `null` here would be a category the page could say
	 * nothing about. The page lists each one with this sentence beside it, so
	 * the absence of a control is legible as a decision instead of an
	 * omission.
	 */
	readonly unmutableReason: string;
};

/**
 * Every category, in the order the page lists them. The order is not a sort
 * and no control changes it.
 *
 * `led_at_close` leads, because it is the one that reports an outcome a Team
 * is bound by — and, since FR-9's amendment, the one that also reports a
 * Nomination Slot coming back. The retired `slot_release` entry used to sit
 * above it.
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategoryCopy[] = [
	{
		id: 'led_at_close',
		label: 'Led an Auction at its close',
		statement:
			'Your Team led an Auction at the moment it closed. When your Team was holding a ' +
			'Nomination Slot, the same notice states that winning has freed it.',
		unmutableReason:
			'The close is where a Contract is decided. This is the notice that reports an ' +
			'outcome your Team is bound by, and there is no later surface that announces it.'
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
 * Whether `value` names a category a Manager may mute — which nothing does.
 *
 * **Kept as a function, and kept as the gate, although its answer is now
 * constant.** A posted request is still REFUSED with the wording below rather
 * than silently ignored, and "the control was absent from the page" was never
 * the check. Deleting this would have meant the route deciding for itself what
 * to do with a submission, which is the one thing this module exists to
 * prevent.
 */
export function isMutableNotificationCategory(value: unknown): boolean {
	return MUTABLE_NOTIFICATION_CATEGORIES.some((category) => category === value);
}

/**
 * What the settings page says instead of offering a control.
 *
 * It states the fact first and the consequence second, in the product voice
 * every other sentence here uses. It does not apologise for the absence and
 * does not describe a setting that used to exist: a Manager reading this page
 * wants to know what reaches them, not what the league changed its mind about.
 */
export const NO_MUTABLE_CATEGORY_STATEMENT =
	'Every category below is sent to your Team, and none of them can be muted. Each one ' +
	'states why.';

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

/**
 * The clause that says where a Manager stands after the refusal.
 *
 * It used to name the one category they could mute instead. There is none, so
 * it states that rather than pointing at a way through that does not exist —
 * a refusal whose second sentence sends somebody somewhere is worse than one
 * that ends the matter.
 */
const NO_WAY_THROUGH =
	'This league allows no notification category to be muted, so there is no category ' +
	'this would have worked for.';

/**
 * The one refusal sentence for each case.
 *
 * Every one ends with "Nothing was written", because in every one of these
 * cases nothing is — the route returns before it reaches a write.
 */
export function notificationMuteRefusalDetail(refusal: NotificationMuteRefusal): string {
	switch (refusal.kind) {
		case 'unmutable_category': {
			// Every category carries a reason now — `unmutableReason` is no
			// longer nullable — so the sentence always has one to print. The
			// fallbacks below are the LOOKUP's, not the wording's:
			// `notificationCategoryCopy` answers `null` for an id no module
			// names, which the type already rules out here.
			const copy = notificationCategoryCopy(refusal.category);
			const reason = copy?.unmutableReason ?? null;
			return (
				`The change was refused: ${copy?.label ?? refusal.category} cannot be muted. ` +
				`${reason === null ? '' : `${reason} `}` +
				`${NO_WAY_THROUGH} ` +
				'Nothing was written.'
			);
		}
		case 'unknown_category':
			return (
				`The change was refused: no notification category is named ${echoed(refusal.requested)}. ` +
				`${NO_WAY_THROUGH} ` +
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
