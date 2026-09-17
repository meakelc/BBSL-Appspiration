/**
 * The Bid Board's one sticky piece of view state: whether the closed Auctions
 * are hidden.
 *
 * **View state, held in this browser and nowhere else.** The switch narrows a
 * list; it posts nothing, changes no figure, and no other Manager can see it —
 * so there is no write path here and none is needed (AD-9). The cost is that
 * the setting does not follow a Manager to another device, which is the same
 * trade `dismissals.svelte.ts` already makes for the same reason.
 *
 * **It has to outlive the page, which is the whole point of the module.** A
 * plain `$state` in `+page.svelte` is destroyed when the component is, so a
 * Manager who hid the closed cards, opened an Auction and came back would find
 * them all there again — the setting would last exactly one screen. Holding it
 * here survives client navigation, and `localStorage` survives the reload as
 * well.
 *
 * **Nothing loads during SSR.** The value starts at `DEFAULT_HIDE_CLOSED` on
 * both sides of hydration and `load` is called from an `$effect`, so the
 * server-rendered HTML and the first client paint agree and Svelte has nothing
 * to correct. Every storage access is wrapped: a private window or blocked
 * site data degrades to the default, which is the board showing everything.
 *
 * A setting that persists carries an obligation the one-visit version did not:
 * the board it produces must account for itself. `closedCountSentence` is what
 * discharges it — the board's own count line says the closed Auctions are
 * closed AND HIDDEN, so a Manager returning to a short board is told why it is
 * short rather than left to infer a quiet league.
 */

import { DEFAULT_HIDE_CLOSED } from '$lib/core/board.ts';

const STORAGE_KEY = 'bbsl.board.hideClosed';

function read(): boolean {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		// Anything but the two strings this module writes — an absent key, a
		// value from an older shape, a half-written one — is the default. A
		// setting that hides cards is never inferred from a string nobody here
		// wrote.
		if (raw === 'true') return true;
		if (raw === 'false') return false;
		return DEFAULT_HIDE_CLOSED;
	} catch {
		return DEFAULT_HIDE_CLOSED;
	}
}

function write(hideClosed: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, String(hideClosed));
	} catch {
		// Unwritable storage: the switch still holds for this visit.
	}
}

class BoardView {
	hideClosed = $state<boolean>(DEFAULT_HIDE_CLOSED);

	/** Reads storage. Called from an `$effect`, so never during SSR. */
	load(): void {
		this.hideClosed = read();
	}

	set(hideClosed: boolean): void {
		this.hideClosed = hideClosed;
		write(hideClosed);
	}
}

export const boardView = new BoardView();
