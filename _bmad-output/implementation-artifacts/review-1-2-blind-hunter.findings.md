# Review Findings — Story 1.2 Diff

## `src/lib/core/money.ts`

**`parseMoney` accepts negative-zero strings with leading zeros, contradicting its own "rejects leading zeros" guarantee**
For input `"-00"`: `Number("-00")` is `-0`, and `-0 === 0` is `true`, so `parsed = 0`. The round-trip check then collapses to the special case:
```js
if (String(parsed) !== (text.startsWith('-') && parsed === 0 ? '0' : text)) {
```
Since `text.startsWith('-')` and `parsed === 0` are both true, the right side becomes the literal `'0'`, and `String(0) !== '0'` is false, so no error is thrown — `parseMoney("-00")` silently returns `0`. The equivalent positive string `"00"` is correctly rejected by the same function (comment: `"// Round-trip: rejects leading zeros..."`), and the `REFUSED` fixture list in `tests/money.test.ts` only tests `['leading zeros', '008500000']`, never a negative-leading-zero variant like `"-00"`. This is an untested asymmetry in the boundary parser that AD-8 exists to make airtight.

**`parseMoney(-0)` (numeric, not string) is untested**
`tests/money.test.ts` asserts `Object.is(parseMoney('-0'), 0)).toBe(true)` for the string path but never exercises `parseMoney(-0)` through the `typeof value === 'number'` branch, even though that branch has its own separate `(value === 0 ? 0 : value)` normalization that could regress independently.

**`multiplyMoney` has no test with a negative factor**
Every test in `tests/money.test.ts`'s "arithmetic keeps the brand" block uses positive factors (`multiplyMoney(bid, 12)`). `0 * -1` produces `-0` in JS, which `brand()` normalizes, but that path — and any sign-propagation concern for a negative amount times a negative factor — is never exercised.

**`formatMoney` has no upper bound or grouping**
Nothing in `money.ts` prevents an amount like `1_234_500_000` from reaching `formatMoney`, which would render `$1234.5M` with no thousands separator and no switch to a larger unit. Current constants (cap `$165,000,000`) never reach this, but nothing structurally forbids it.

## `scripts/check-core-purity.js`

**`FORBIDDEN_GLOBALS` omits `eval` and `Function`**
The set is:
```js
export const FORBIDDEN_GLOBALS = new Set([
	'Date', 'fetch', 'process', 'require', 'globalThis', 'crypto', 'performance',
	'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Deno', 'Buffer',
	'__dirname', '__filename', 'window', 'document', 'navigator', 'localStorage',
	'sessionStorage', 'XMLHttpRequest', 'WebSocket'
]);
```
Neither `eval` nor `Function` appears. `eval('Date.now()')` or `new Function('return Math.random()')()` would pass the entire static check, defeating the purpose of a gate whose own doc comment calls the divergence it protects against "the most dangerous divergence available in this design."

**`FORBIDDEN_MEMBERS` (`Math.random`) is bypassable via bracket notation**
The check that enforces `FORBIDDEN_MEMBERS` only fires inside:
```js
} else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
```
`ts.isElementAccessExpression` (bracket/computed access) is never visited, so `Math['random']()` is not caught — `Math` itself is deliberately allowed (`Math.abs`/`Math.trunc` are fine), and only the dot-notation form of `.random` is checked. `tests/purity.test.ts`'s "no clock, no randomness" block tests only dot-notation forms (`'Date.now()'`, `'Math.random()'`, etc.), never a bracket-notation variant.

**`ImportEqualsDeclaration` is never visited**
The visitor branches on `ts.isImportDeclaration(node) || ts.isExportDeclaration(node)` and `ts.isImportTypeNode(node)`, but never checks `ts.isImportEqualsDeclaration(node)` — the `import x = require('y')` / `import x = Foo.Bar` legacy TS syntax is not run through `checkSpecifier` at all.

**`Intl` is absent from `FORBIDDEN_GLOBALS`**
The stated purpose of this gate is identical behavior between Node and Deno. `Intl`/ICU data can differ across runtimes and even runtime versions — exactly the class of divergence AD-1/AD-2 exist to close off — yet nothing statically prevents a future core file from calling `Intl.NumberFormat`. `money.ts` currently avoids it only via a text-containment test in `money.test.ts` (`.not.toContain('Intl.NumberFormat')`), not via the purity gate itself.

## `src/lib/core/constants.ts`

**`FRESHNESS_WINDOW`/`STALE_WINDOW` cite no external authority, unlike every other constant in the file**
```
* `FRESHNESS_WINDOW` and `STALE_WINDOW` are named verbatim as AD-29 and the
* epic AC require. No planning artifact assigned them a number; 30s and 120s
* are a human decision of 2026-08-20, taken against CAP-10's 5-second board
* floor.
```
Every other value in this module quotes a PRD section (e.g. `SALARY_CAP` → "PRD §11 '$165M cap'"). These two are instead sourced to "a human decision" recorded only in this comment — a weaker traceability chain than the module's own premise that these values "live in code and no admin UI, configuration file or environment variable can edit them," since here the comment itself is the only record of where the number came from.

## `tsconfig.json`

**The `allowImportingTsExtensions` justification is unverified within this diff**
```
// ...the option is only legal because the generated config sets noEmit —
// nothing here emits JavaScript.
"allowImportingTsExtensions": true,
```
Nothing in this diff shows `.svelte-kit/tsconfig.json` (the extended config) actually sets `noEmit`, nor shows `moduleResolution` set to a value (`bundler`/`node16`/`nodenext`) compatible with `allowImportingTsExtensions`. The claim rests entirely on a comment that can't be checked against the content provided.

## `tests/constants.test.ts`

**"declared exactly once" actually checks textual occurrence, not declaration**
```js
it('is declared exactly once', () => {
	expect(CONSTANTS_SOURCE.match(/GLOBAL_WRITE_LOCK_KEY/g)).toHaveLength(1);
});
```
This counts every appearance of the substring `GLOBAL_WRITE_LOCK_KEY` anywhere in the file, including doc comments. It will fail if someone later adds a second mention of the name in prose (e.g. clarifying documentation elsewhere in the file) even though nothing about the actual declaration changed — a brittle proxy for the intended invariant.

## Cross-file / process gaps

**Deferral of `types.ts` isn't traceable in the reviewed content**
`src/lib/core/types.ts`'s new comment says: `"Stub. Epic 2 fills this in... Story 1.2 deliberately left it alone rather than declaring a gate set before any gate existed."` Per the git status supplied alongside this task, both `_bmad-output/implementation-artifacts/deferred-work.md` and `sprint-status.yaml` are modified in this working tree, but neither is included in the diff under review, so this deferral claim cannot be cross-checked against the artifact that's supposed to record deferred scope.

**`scripts/run-review-layers.sh` interpolates cost values into a `python -c` string**
```bash
total=$(python -c "print($total + $c)")
```
`$total` and `$c` are shell-expanded directly into Python source rather than passed as arguments or via stdin. If `total_cost_usd` from the Claude JSON response were ever non-numeric, this is a code-injection-shaped construction, not just an arithmetic error.

**`scripts/bmad-cost-report.py` silently widens scope on a match miss**
```python
hits = [d for d in base.iterdir() if d.is_dir() and d.name.lower().endswith(want)]
return hits or [d for d in base.iterdir() if d.is_dir()]
```
If no transcript directory matches the current project name, the function silently falls back to scanning *every* project under `~/.claude/projects`, with no message printed indicating the fallback occurred — a cost report could aggregate an unrelated project's spend while presenting itself as scoped to this repo.
