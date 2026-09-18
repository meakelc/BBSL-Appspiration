/**
 * The Bid Board's sticky view state: whether the closed Auctions are hidden,
 * and whether the ones above the viewer's Cap are.
 *
 * **View state, held in this browser and nowhere else.** The switches narrow a
 * list; they post nothing, change no figure, and no other Manager can see them
 * — so there is no write path here and none is needed (AD-9). The cost is that
 * the settings do not follow a Manager to another device, which is the same
 * trade `dismissals.svelte.ts` already makes for the same reason.
 *
 * **They have to outlive the page, which is the whole point of the module.** A
 * plain `$state` in `+page.svelte` is destroyed when the component is, so a
 * Manager who hid the closed cards, opened an Auction and came back would find
 * them all there again — the setting would last exactly one screen. Holding it
 * here survives client navigation, and `localStorage` survives the reload as
 * well.
 *
 * **One key per switch, and never one object.** They are two independent
 * answers to two questions, and a single serialised record would make a
 * half-written or older-shaped value able to reset both at once; separate keys
 * degrade one at a time, and each falls back to its own core default.
 *
 * **Nothing loads during SSR.** Both values start at their core defaults on
 * both sides of hydration and `load` is called from an `$effect`, so the
 * server-rendered HTML and the first client paint agree and Svelte has nothing
 * to correct. Every storage access is wrapped: a private window or blocked
 * site data degrades to the defaults, which is the board showing everything.
 *
 * A setting that persists carries an obligation the one-visit version did not:
 * the board it produces must account for itself. The SWITCHES are what
 * discharge it — labelled controls on the panel, each stating its own
 * position, that a Manager cannot reach the cards without passing. Two
 * sentences were tried for the job first and both said, more weakly, what the
 * controls themselves show; `core/board.ts` records why neither survived.
 */

import { DEFAULT_HIDE_ABOVE_CAP, DEFAULT_HIDE_CLOSED } from '$lib/core/board.ts';

const HIDE_CLOSED_KEY = 'bbsl.board.hideClosed';
const HIDE_ABOVE_CAP_KEY = 'bbsl.board.hideAboveCap';

function read(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		// Anything but the two strings this module writes — an absent key, a
		// value from an older shape, a half-written one — is the default. A
		// setting that hides cards is never inferred from a string nobody here
		// wrote.
		if (raw === 'true') return true;
		if (raw === 'false') return false;
		return fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// Unwritable storage: the switch still holds for this visit.
	}
}

class BoardView {
	hideClosed = $state<boolean>(DEFAULT_HIDE_CLOSED);
	hideAboveCap = $state<boolean>(DEFAULT_HIDE_ABOVE_CAP);

	/** Reads storage. Called from an `$effect`, so never during SSR. */
	load(): void {
		this.hideClosed = read(HIDE_CLOSED_KEY, DEFAULT_HIDE_CLOSED);
		this.hideAboveCap = read(HIDE_ABOVE_CAP_KEY, DEFAULT_HIDE_ABOVE_CAP);
	}

	set(hideClosed: boolean): void {
		this.hideClosed = hideClosed;
		write(HIDE_CLOSED_KEY, hideClosed);
	}

	setAboveCap(hideAboveCap: boolean): void {
		this.hideAboveCap = hideAboveCap;
		write(HIDE_ABOVE_CAP_KEY, hideAboveCap);
	}
}

export const boardView = new BoardView();
