/**
 * Resolving a Team from an uploaded file's name. Server-only.
 *
 * `resolveTeamByFileName` is pure: it takes an already-fetched Team list —
 * `server/roster-import.ts` fetches it once per file, inside that file's own
 * transaction, via the same connection the write happens on — and a file
 * name, and answers which single Team, if any, the name resolves to (AD-24:
 * "a file resolves to one Team by file name"). Kept pure and separate from
 * the fetch so a test drives it with a synthetic Team list and no database at
 * all.
 *
 * Matching is deliberately conservative and, like the adapter's column map,
 * a documented placeholder (addendum.md B: file-naming shape is
 * TODO-confirm against a real Fantrax export). It normalises both sides to
 * lowercase alphanumerics, tries an exact match on the file's stem first,
 * and falls back to "the Team's name appears inside the file name" only when
 * no exact match exists — refusing (never guessing) when more than one Team
 * would match either way.
 *
 * **This module no longer computes "which Teams are outstanding" (removed at
 * review-loop-iteration 1).** A `listOutstandingTeams` used to live here,
 * duplicating `import-status.ts`'s `loadImportStatus`/`outstandingTeamNames`
 * against a second, independent query, with no production caller — the
 * `/import` route only ever used `import-status.ts`. Two implementations of
 * the same "outstanding" rule invite drift with nothing to catch it;
 * `import-status.ts` is the one source now, as it already was in practice.
 */

/** A Team as read for file-name resolution: just enough to match and to name. */
export type TeamRecord = {
	readonly id: string;
	readonly name: string;
};

/** What resolving a file name against the Team list found. */
export type TeamMatchResult =
	| { readonly kind: 'matched'; readonly team: TeamRecord }
	| { readonly kind: 'unmatched' }
	| { readonly kind: 'ambiguous'; readonly teams: readonly TeamRecord[] };

/** Strip everything but letters and digits, lowercased. */
function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Drop a trailing filename extension, e.g. "Lakers.csv" -> "Lakers". */
function stem(fileName: string): string {
	const dot = fileName.lastIndexOf('.');
	return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Resolve a file name to exactly one Team, or say why not.
 *
 * A Team with a blank/whitespace-only name can never match (its normalised
 * form is `''`, which every file name's normalised stem would otherwise
 * vacuously "contain") — the not-blank constraint on `teams.name` (Story
 * 1.4's migration) means this should never occur in practice, but the guard
 * costs nothing and keeps the fallback pass honest.
 */
export function resolveTeamByFileName(
	teams: readonly TeamRecord[],
	fileName: string
): TeamMatchResult {
	const normalizedStem = normalize(stem(fileName));

	const exact = teams.filter((team) => normalize(team.name) === normalizedStem);
	if (exact.length === 1) return { kind: 'matched', team: exact[0]! };
	if (exact.length > 1) return { kind: 'ambiguous', teams: exact };

	const contains = teams.filter((team) => {
		const normalizedName = normalize(team.name);
		return normalizedName !== '' && normalizedStem.includes(normalizedName);
	});
	if (contains.length === 1) return { kind: 'matched', team: contains[0]! };
	if (contains.length > 1) return { kind: 'ambiguous', teams: contains };

	return { kind: 'unmatched' };
}
