<script lang="ts">
	// How a Minimum-Bid Contention draw is checked, in prose (Story 3.6, AD-14).
	//
	// **This page is the half a Manager can actually run.** AD-14 makes a
	// Commissioner who is also a rival acceptable because the draw is
	// checkable; a 64-character hex string on an Auction page is not a check,
	// it is a value nobody has been told what to do with. So the procedure is
	// written out here: what is committed and when, how the winner is derived,
	// a worked example whose numbers the test suite runs through the real
	// derivation, the spreadsheet formula, and the one command that verifies
	// the reveal against the commitment.
	//
	// **No league data reaches this page.** There is no Auction, no Team, no
	// seed, no commitment and no `load` that fetches one — the worked example
	// below is an invented seed over invented Teams. That is deliberate: a
	// procedure that changed with the case would be a procedure nobody could
	// check twice.
	//
	// **Nothing here computes anything.** The page states arithmetic; it does
	// not perform it, hash anything, or import a rule. The one function these
	// words describe is `drawIndex` in `src/lib/core/rules/draw.ts`, and
	// `tests/core/draw.test.ts` asserts that the worked example printed here is
	// the answer that function gives. If the two ever disagree, this page is
	// the defect — it is the half a Manager can actually run.
</script>

<svelte:head>
	<title>How a draw is checked — Appspiration</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="page">
	<header>
		<h1>How a draw is checked</h1>
		<p class="section-label">Minimum-Bid Contention</p>
	</header>

	<section class="panel">
		<p class="section-label">What is committed, and when</p>
		<p class="prose">
			When a Minimum-Bid Contention opens, the server generates a random 32-byte seed and stores
			it where no account — yours, the Commissioner's, or the app's own — can read it. What it
			publishes at that moment is the SHA-256 hash of that seed, and only the hash. That
			published hash is the commitment: it fixes the seed before anybody knows who will join,
			and it cannot be changed afterwards without every Manager who wrote it down noticing.
		</p>
		<p class="prose">
			The seed itself stays sealed until the contention ends. When the clock runs out the draw
			opens it: the seed is revealed in the log beside the commitment it answers, the Contender
			list it ran over, and the position it selected. When a contention is dissolved by a higher
			bid instead, the seed is revealed the same way and no draw is run.
		</p>
		<p class="prose">
			The winner is derived from the seed. It is never derived from the published hash — if it
			were, anyone watching could work out in advance whether joining would make them win, which
			is the exact thing sealing the seed exists to prevent.
		</p>
	</section>

	<section class="panel">
		<p class="section-label">The procedure</p>
		<p class="prose">
			Take the revealed seed — 64 lowercase hex digits — and the Contender list exactly as it is
			recorded, in the order the Teams joined. Call the number of Teams on that list <em>n</em>.
			Start at zero and work through the seed one digit at a time, left to right:
		</p>
		<p class="prose procedure">r = 0
for each hex digit d of the seed, left to right:
    r = (r × 16 + value of d) mod n

winner = the Team at position r, counting from 0</p>
		<p class="prose">
			The value of a hex digit is the usual one: 0 through 9 are themselves, a is 10, b is 11, c
			is 12, d is 13, e is 14, f is 15. Nothing ever gets large: after each step r is smaller
			than n, so the biggest number you ever hold is <em>16n + 15</em>. With a dozen Contenders
			that is under 210, and every step fits on a line of paper.
		</p>
		<p class="prose">
			Counting starts at zero: r = 0 is the first Team on the list, r = 1 the second, and so on.
			The order of the list is part of the answer — it is the join order the log recorded, and
			it is never re-sorted for display.
		</p>
	</section>

	<section class="panel">
		<p class="section-label">A worked example</p>
		<p class="prose">
			Four Teams contended, in this join order: Team E, Team F, Team G, Team H. So n = 4. The
			revealed seed was:
		</p>
		<p class="prose procedure">4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e4d81f0b6a72c395e</p>
		<p class="prose">
			Working left to right: r starts at 0. The first digit is 4, so r = (0 × 16 + 4) mod 4 = 0.
			The second is d, worth 13, so r = (0 × 16 + 13) mod 4 = 1. The third is 8, so r = (1 × 16 +
			8) mod 4 = 0. Carry on for all 64 digits.
		</p>
		<p class="prose">
			The last digit is e, worth 14. It arrives with r = 1, so the final step is r = (1 × 16 +
			14) mod 4 = 30 mod 4 = 2. Position 2, counting from zero, is the third Team on the list:
			<strong>Team G</strong> wins. That is the position the log records beside the seed, and it
			is the number to compare against.
		</p>
	</section>

	<section class="panel">
		<p class="section-label">The same thing in a spreadsheet</p>
		<p class="prose">
			Put the seed in a cell and the Contender count in another. Put 0 in B1. Then in B2, and
			filled down 64 rows:
		</p>
		<p class="prose procedure">B2 = MOD(B1*16 + HEX2DEC(MID($seed, ROW()-1, 1)), $n)</p>
		<p class="prose">
			B65 holds the answer. Google Sheets and Excel both have HEX2DEC and MID; nothing else is
			needed, and no macro is involved.
		</p>
	</section>

	<section class="panel">
		<p class="section-label">Checking the commitment</p>
		<p class="prose">
			The derivation above proves the winner follows from the seed. Checking that the seed is the
			one that was sealed at the start is a separate step, and it is one command:
		</p>
		<p class="prose procedure">printf %s "&lt;the revealed seed&gt;" | sha256sum</p>
		<p class="prose">
			That prints 64 lowercase hex digits. They must match, character for character, the
			commitment published on the Auction page when the contention opened — which is why it is
			worth writing that value down at the time rather than reading it back later. If the two
			differ, the reveal does not answer the commitment and the draw should not be accepted.
		</p>
		<p class="prose">
			Occasionally a contention will say that no commitment was published for it. That is a
			defect in the log rather than a draw to be checked, and the seed is stated for the record
			only — there is nothing to compare it against.
		</p>
	</section>
</main>

<style>
	/*
	 * One class, and it introduces no token and no sizing literal: the same
	 * three declarations `.seed-hash` already uses on the Auction page, plus
	 * the whitespace preservation the four blocks above need to stay legible
	 * as the arithmetic they are.
	 */
	.procedure {
		color: var(--color-text-secondary);
		font-size: var(--size-12-5);
		white-space: pre-wrap;
		word-break: break-all;
	}
</style>
