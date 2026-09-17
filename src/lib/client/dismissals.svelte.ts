/**
 * The outbid cards a Manager has dismissed from Your Positions.
 *
 * **View state, held in this browser and nowhere else.** Dismissing hides an
 * outbid card on `/positions` and the matching chip on `/board`; it posts
 * nothing, changes no figure, and no other Manager can see it — so there is no
 * write path here and none is needed (AD-9). The cost is that a dismissal does
 * not follow a Manager to another device.
 *
 * **A dismissal lasts only as long as the outbid it cleared.** Each page hands
 * `retain` the Players the reader is outbid on right now, and every other id
 * is dropped: a Manager who re-enters and leads again, or whose Auction
 * closes, is outbid afresh the next time, and that must be shown.
 *
 * **Nothing loads during SSR.** The set starts empty on both sides of
 * hydration and `load` is called from an `$effect`, so the server-rendered
 * HTML and the first client paint agree. Every storage access is wrapped: a
 * private window or blocked site data degrades to "nothing dismissed".
 */

const STORAGE_KEY = 'bbsl.positions.dismissed';

function read(): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

function write(ids: ReadonlySet<string>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		// Unwritable storage: the dismissal still holds for this visit.
	}
}

class Dismissals {
	ids = $state<ReadonlySet<string>>(new Set());

	has(fantraxPlayerId: string): boolean {
		return this.ids.has(fantraxPlayerId);
	}

	/** Reads storage and drops every id the reader is no longer outbid on. */
	load(outbidNow: Iterable<string>): void {
		const current = new Set(outbidNow);
		const kept = new Set(read().filter((id) => current.has(id)));
		this.ids = kept;
		write(kept);
	}

	dismiss(fantraxPlayerId: string): void {
		const next = new Set(this.ids);
		next.add(fantraxPlayerId);
		this.ids = next;
		write(next);
	}
}

export const dismissals = new Dismissals();
