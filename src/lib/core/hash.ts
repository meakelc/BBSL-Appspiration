/**
 * SHA-256, implemented pure (Story 3.2, AD-14).
 *
 * **Why this is written out by hand rather than imported.** AD-14 makes the
 * commit-reveal the whole reason a Commissioner who is also a rival is
 * acceptable: a seed is generated when a Minimum-Bid Contention opens, sealed
 * where no manager-facing role can read it, and only `hash(seed)` is
 * published. That commitment has to be computable by three parties who share
 * no runtime — Node, Deno (`supabase/functions/tick`) and a Manager checking
 * the reveal by hand with `sha256sum` — and it has to be computable HERE, in
 * the pure core, where `decide()` builds the payload.
 *
 * `node:crypto` is a Node built-in and AD-2 forbids the import outright.
 * `crypto.subtle` is a forbidden global (`scripts/check-core-purity.js`) and
 * is asynchronous besides, which `decide()` — a synchronous pure function —
 * cannot await. So the algorithm is written here in stdlib arithmetic, which
 * is deterministic, portable and testable against the published vectors.
 * `tests/core/hash.test.ts` checks it against FIPS 180-4's own `""`, `"abc"`
 * and 56-character vectors before anything in this codebase consumes it.
 *
 * The result is LOWERCASE HEX, which is what `sha256sum` prints and therefore
 * what a Manager comparing by hand will have in front of them. A second
 * casing would be a second commitment.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness,
 * stdlib only, relative .ts imports only so Deno can load it (AD-2). It
 * imports nothing at all — it is a leaf beside `constants.ts`.
 */

/**
 * The 64 round constants: the first 32 bits of the fractional parts of the
 * cube roots of the first 64 primes (FIPS 180-4 §4.2.2).
 */
const ROUND_CONSTANTS: readonly number[] = Object.freeze([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * The initial hash value: the first 32 bits of the fractional parts of the
 * square roots of the first eight primes (FIPS 180-4 §5.3.3).
 */
const INITIAL_STATE: readonly number[] = Object.freeze([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

/** Rotate a 32-bit word right, unsigned. */
function rotateRight(word: number, bits: number): number {
	return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

/**
 * A string as UTF-8 bytes, encoded here rather than through `TextEncoder`.
 *
 * `TextEncoder` is not on `check-core-purity.js`'s forbidden list, but it is a
 * platform global all the same, and this module's entire justification is that
 * the commitment is computed from stdlib arithmetic in every runtime that has
 * to agree about it. Twelve lines of shifting is a smaller surface than a
 * global whose presence differs between Node, Deno and a browser.
 *
 * A LONE surrogate is encoded as the three-byte form of its own code point
 * rather than replaced with U+FFFD, which is where this differs from
 * `TextEncoder`. It cannot arise for the one caller this module has — a seed
 * is `randomBytes(32).toString('hex')`, which is ASCII — and refusing to
 * encode would turn a hash into a throw inside `decide()`.
 */
function utf8Bytes(text: string): readonly number[] {
	const bytes: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		let code = text.charCodeAt(index);
		// A surrogate PAIR is one code point; the pair is combined before it is
		// encoded, or the four-byte forms would never be produced at all.
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const low = text.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				index += 1;
			}
		}
		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			bytes.push(
				0xf0 | (code >>> 18),
				0x80 | ((code >>> 12) & 0x3f),
				0x80 | ((code >>> 6) & 0x3f),
				0x80 | (code & 0x3f)
			);
		}
	}
	return bytes;
}

/** One 32-bit word as eight lowercase hex digits. */
function hex(word: number): string {
	let out = '';
	for (let shift = 28; shift >= 0; shift -= 4) {
		out += ((word >>> shift) & 0xf).toString(16);
	}
	return out;
}

/**
 * SHA-256 of a UTF-8 string, as 64 lowercase hex characters.
 *
 * The ONE commitment function. `decide()` publishes `hash(seed)` on the
 * opening `BidPlaced` payload and nothing else about the seed ever leaves the
 * server (AD-14); Story 3.6's reveal verifies against this same expression,
 * and so does a Manager running `printf %s "<seed>" | sha256sum`.
 *
 * Total: every string has a hash, including the empty one. Nothing here
 * throws.
 */
export function hash(text: string): string {
	const message = utf8Bytes(text);

	// Padding (FIPS 180-4 §5.1.1): the message, a single 1 bit, zeroes, then
	// the original length in bits as a 64-bit big-endian integer.
	const bitLength = message.length * 8;
	const padded: number[] = [...message, 0x80];
	while (padded.length % 64 !== 56) padded.push(0);
	// The high word is only ever non-zero for inputs over 512MB; it is written
	// out rather than assumed zero because a length field that is right by
	// accident is not right.
	const highBits = Math.floor(bitLength / 0x1_0000_0000);
	const lowBits = bitLength >>> 0;
	for (let shift = 24; shift >= 0; shift -= 8) padded.push((highBits >>> shift) & 0xff);
	for (let shift = 24; shift >= 0; shift -= 8) padded.push((lowBits >>> shift) & 0xff);

	const state = [...INITIAL_STATE];
	const schedule = new Array<number>(64);

	for (let block = 0; block < padded.length; block += 64) {
		for (let word = 0; word < 16; word += 1) {
			const at = block + word * 4;
			schedule[word] =
				(((padded[at] ?? 0) << 24) |
					((padded[at + 1] ?? 0) << 16) |
					((padded[at + 2] ?? 0) << 8) |
					(padded[at + 3] ?? 0)) >>>
				0;
		}
		for (let word = 16; word < 64; word += 1) {
			const back15 = schedule[word - 15] ?? 0;
			const back2 = schedule[word - 2] ?? 0;
			const s0 = (rotateRight(back15, 7) ^ rotateRight(back15, 18) ^ (back15 >>> 3)) >>> 0;
			const s1 = (rotateRight(back2, 17) ^ rotateRight(back2, 19) ^ (back2 >>> 10)) >>> 0;
			schedule[word] =
				(((schedule[word - 16] ?? 0) + s0 + (schedule[word - 7] ?? 0) + s1) >>> 0) >>> 0;
		}

		let [a, b, c, d, e, f, g, h] = state as [
			number,
			number,
			number,
			number,
			number,
			number,
			number,
			number
		];

		for (let round = 0; round < 64; round += 1) {
			const bigS1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
			const choose = ((e & f) ^ (~e & g)) >>> 0;
			const temp1 =
				(h + bigS1 + choose + (ROUND_CONSTANTS[round] ?? 0) + (schedule[round] ?? 0)) >>> 0;
			const bigS0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
			const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
			const temp2 = (bigS0 + majority) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		const round = [a, b, c, d, e, f, g, h];
		for (let index = 0; index < 8; index += 1) {
			state[index] = (((state[index] ?? 0) + (round[index] ?? 0)) >>> 0) >>> 0;
		}
	}

	return state.map(hex).join('');
}
