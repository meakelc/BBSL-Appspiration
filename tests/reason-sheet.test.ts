/**
 * The reason sheet: its words, and the claims its surface makes (Story 7.1).
 *
 * The view-model is called directly. The component's claims are SOURCE-TEXT
 * assertions, in the convention `tests/strip.test.ts:1-13` and
 * `tests/structure.test.ts:281-291` already use: `vite.config.ts` pins
 * `environment: 'node'` and no `.svelte` file is renderable under this suite,
 * so "the commit uses `.control-commissioner`", "the reason field carries no
 * placeholder" and "no `use:enhance` exists" are properties of the text. For
 * the ABSENCE claims — which are most of them here — that is exactly as
 * strong as a rendered assertion, and it is the point of them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	REASON_SHEET_AUDIT_FOOTER,
	REASON_SHEET_CANCEL_LABEL,
	REASON_SHEET_FIELD_LABEL,
	REASON_SHEET_ROWS_HEADING,
	REASON_SHEET_TITLE,
	reasonSheetView
} from '../src/lib/reason-sheet-view.ts';
import type { ReasonSheetRow } from '../src/lib/reason-sheet-view.ts';
import { OVERRIDE_REASON_FIELD } from '../src/lib/core/rules/override.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(...parts: string[]): string {
	return readFileSync(join(ROOT, ...parts), 'utf8');
}

const SHEET = read('src', 'lib', 'components', 'ReasonSheet.svelte');

/** The component's markup and script with every comment removed. */
const SHEET_CODE = SHEET.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/^\s*\/\/.*$/gm, '');

/** The `<textarea>` tag itself, which is the reason field. */
const TEXTAREA = SHEET_CODE.match(/<textarea[^>]*>/)?.[0] ?? '';

/**
 * The one `<button>` tag, which is the commit control.
 *
 * Extracted as a single element rather than asserted against the whole file:
 * `expect(SHEET).toContain('control-commissioner')` and
 * `expect(SHEET).toContain('type="submit"')` both pass when the class has been
 * moved onto the Cancel link and the submit button left unclassed, which is
 * precisely the swap `tests/signin-surface.test.ts` was written for. Both
 * claims have to hold of the SAME element or they hold of nothing.
 */
const BUTTONS = SHEET_CODE.match(/<button[^>]*>/g) ?? [];

const OBVIOUS_ROW: ReasonSheetRow = {
	label: 'Leading bid',
	before: '$14.5M',
	after: '$14.0M',
	attention: null
};

const CONSEQUENCE_ROW: ReasonSheetRow = {
	label: 'League Clock',
	before: '39h 02m',
	after: '33h 15m',
	attention:
		'This removes the bid’s League Clock reset. The Auction Phase will end 5h 47m sooner. ' +
		'Nothing already accepted is invalidated.'
};

const INPUT = {
	act: 'Void the leading bid on Jalen Duren.',
	commitLabel: 'Void the bid',
	cancelHref: '/auction/12345',
	rows: [OBVIOUS_ROW, CONSEQUENCE_ROW]
};

describe('reasonSheetView — the sheet’s words', () => {
	const view = reasonSheetView(INPUT);

	it('names the Commissioner before it names the act', () => {
		expect(view.title).toBe(REASON_SHEET_TITLE);
		expect(view.title.toLowerCase()).toContain('commissioner');
	});

	it('states the act as the caller’s finished sentence, unaltered', () => {
		expect(view.act).toBe('Void the leading bid on Jalen Duren.');
	});

	it('heads the states block with before → after', () => {
		expect(view.rowsHeading).toBe(REASON_SHEET_ROWS_HEADING);
		expect(view.rowsHeading).toContain('→');
	});

	it('pairs each row’s two states into one string, so the component pairs nothing', () => {
		expect(view.rows.map((row) => row.change)).toEqual([
			'$14.5M → $14.0M',
			'39h 02m → 33h 15m'
		]);
		expect(view.rows.map((row) => row.label)).toEqual(['Leading bid', 'League Clock']);
	});

	it('carries an attention note on the consequence row and none on the obvious one', () => {
		expect(view.rows.map((row) => row.attention)).toEqual([null, CONSEQUENCE_ROW.attention]);
	});

	it('collects the consequence sentences, in row order', () => {
		expect(view.attentionNotes).toEqual([CONSEQUENCE_ROW.attention]);
	});

	it('treats an empty or whitespace-only note as no note at all', () => {
		// An amber bar with nothing in it marks a row as consequential and
		// then explains nothing, which is worse than no marker.
		const blanks = reasonSheetView({
			...INPUT,
			rows: [
				{ ...OBVIOUS_ROW, attention: '' },
				{ ...OBVIOUS_ROW, label: 'Leading bidder', attention: '   \n\t ' }
			]
		});
		expect(blanks.rows.map((row) => row.attention)).toEqual([null, null]);
		expect(blanks.attentionNotes).toEqual([]);
	});

	it('gives every row a key that two identical rows cannot share', () => {
		const twins = reasonSheetView({
			...INPUT,
			rows: [OBVIOUS_ROW, OBVIOUS_ROW, CONSEQUENCE_ROW, CONSEQUENCE_ROW]
		});
		const keys = twins.rows.map((row) => row.key);
		expect(new Set(keys).size).toBe(keys.length);
		// And the key is not the text, so it cannot collide by wording.
		expect(keys.some((key) => key.includes('Leading bid'))).toBe(false);
	});

	it('carries no attention note at all when every affected value is obvious', () => {
		const plain = reasonSheetView({ ...INPUT, rows: [OBVIOUS_ROW] });
		expect(plain.attentionNotes).toEqual([]);
		expect(plain.rows).toHaveLength(1);
	});

	it('renders rows and no notes for an override that changes nothing visible', () => {
		const empty = reasonSheetView({ ...INPUT, rows: [] });
		expect(empty.rows).toEqual([]);
		expect(empty.attentionNotes).toEqual([]);
		expect(empty.act).toBe(INPUT.act);
	});

	it('labels the reason as required, permanent and public', () => {
		expect(view.reasonLabel).toBe(REASON_SHEET_FIELD_LABEL);
		for (const word of ['required', 'permanent', 'readable by every Manager']) {
			expect(view.reasonLabel).toContain(word);
		}
	});

	it('posts the reason under the guard’s field name, not a second literal', () => {
		expect(view.reasonFieldName).toBe(OVERRIDE_REASON_FIELD);
	});

	it('names the act on the commit control rather than saying "Confirm"', () => {
		expect(view.commitLabel).toBe('Void the bid');
		expect(view.commitLabel.toLowerCase()).not.toContain('confirm');
	});

	it('gives Cancel somewhere to go — leaving the sheet is never a dead end', () => {
		expect(view.cancelLabel).toBe(REASON_SHEET_CANCEL_LABEL);
		expect(view.cancelHref).toBe('/auction/12345');
	});

	it('states in the footer what is written and that it cannot be unwritten', () => {
		expect(view.auditFooter).toBe(REASON_SHEET_AUDIT_FOOTER);
		expect(view.auditFooter).toContain('Audit Log');
		expect(view.auditFooter).toContain('cannot be edited or deleted');
	});
});

describe('ReasonSheet.svelte — the surface, asserted against its source', () => {
	it('commits through the Epic 1 Commissioner class itself, not a look-alike', () => {
		// One button, and it is the commit: the class and the submit type are
		// asserted against the same tag, so moving the class onto Cancel fails.
		expect(BUTTONS).toHaveLength(1);
		const commit = BUTTONS[0] ?? '';
		expect(commit).toContain('class="control-commissioner"');
		expect(commit).toContain('type="submit"');
	});

	it('gives the commit no second submit to be confused with', () => {
		// Cancel is a link. A second `<button>` beside a dashed commit is the
		// thing a tired thumb gets wrong, and the count above is what holds it.
		expect(SHEET_CODE).toMatch(/<a class="reason-sheet-cancel"/);
		expect(SHEET_CODE).not.toContain('type="button"');
	});

	it('declares no property of the Commissioner class in its own styles', () => {
		// All four properties must survive unweakened, which means this file
		// must not restate — and therefore cannot weaken — any of them.
		const style = SHEET_CODE.slice(SHEET_CODE.indexOf('<style>'));
		expect(style).not.toContain('.control-commissioner');
		expect(style).not.toContain('.commissioner-block');
	});

	it('wraps the block the repo-wide control guard can read', () => {
		// `tests/signin-surface.test.ts:212-260` matches
		// `<section|div class="commissioner-block">…</section|div>` and proves
		// the commit sits inside one. A `<form class="commissioner-block ...">`
		// would be invisible to it — this sheet stays inside its reach.
		expect(SHEET_CODE).toContain('<section class="commissioner-block">');
	});

	it('puts no Manager-button variant anywhere on the sheet', () => {
		expect(SHEET_CODE).not.toContain('control-manager');
	});

	it('sits on the recessed Commissioner ground', () => {
		expect(SHEET_CODE).toContain('commissioner-block');
	});

	it('opens the reason field empty — no placeholder, no default, no skip', () => {
		expect(TEXTAREA).not.toBe('');
		expect(TEXTAREA).not.toContain('placeholder');
		expect(TEXTAREA).not.toContain('value');
		// A `<textarea>`'s default is its children; the tag must close immediately.
		expect(SHEET_CODE).toMatch(/<textarea[^>]*><\/textarea>/);
		expect(SHEET_CODE.toLowerCase()).not.toContain('skip');
	});

	it('marks the reason field required in the markup as well as on the server', () => {
		// The courtesy half. `requireOverrideReason` is the check and stays the
		// check — but a field the browser will submit empty without comment
		// makes the Commissioner discover the requirement as a refusal page,
		// which is a worse way to learn it. Asserted on the extracted tag, so
		// dropping the attribute cannot pass by matching some other element.
		expect(TEXTAREA).toContain('required');
	});

	it('is an ordinary form, reachable without client JavaScript', () => {
		expect(SHEET_CODE).toContain('method="POST"');
		expect(SHEET_CODE).not.toContain('use:enhance');
		expect(SHEET_CODE).not.toContain('<dialog');
		expect(SHEET_CODE).not.toContain('showModal');
		expect(SHEET_CODE).not.toContain('popover');
		expect(SHEET_CODE).not.toContain('on:click');
		expect(SHEET_CODE).not.toContain('onclick');
	});

	it('words nothing itself — every sentence comes from the view-model', () => {
		expect(SHEET_CODE).toContain('{view.act}');
		expect(SHEET_CODE).toContain('{view.reasonLabel}');
		expect(SHEET_CODE).toContain('{view.commitLabel}');
		expect(SHEET_CODE).toContain('{view.auditFooter}');
		expect(SHEET_CODE).not.toContain('Audit Log');
		expect(SHEET_CODE).not.toContain('Commissioner override');
	});

	it('renders each row’s consequence note ON that row', () => {
		// Deleting the note entirely used to leave this suite green, because
		// nothing asserted the sheet rendered it at all. Two claims now: the
		// note IS rendered, and it is rendered inside the rows loop — a note
		// in a detached list below the block cannot say which value it is
		// about, which is the whole reason the matrix puts it on the row.
		expect(SHEET_CODE).toContain('{row.attention}');
		expect(SHEET_CODE).toContain('class="reason-sheet-attention"');

		const loopStart = SHEET_CODE.indexOf('{#each view.rows as row');
		const loopEnd = SHEET_CODE.indexOf('{/each}', loopStart);
		const note = SHEET_CODE.indexOf('{row.attention}');
		expect(loopStart).toBeGreaterThan(-1);
		expect(note).toBeGreaterThan(loopStart);
		expect(note).toBeLessThan(loopEnd);
	});

	it('renders no marker on a row that has no consequence', () => {
		// The amber bar means something, so it is guarded rather than always
		// present with an empty body.
		expect(SHEET_CODE).toContain('{#if row.attention !== null}');
	});

	it('does not render the flattened note list — the rows carry them', () => {
		expect(SHEET_CODE).not.toContain('{#each view.attentionNotes');
	});

	it('keys the rows on something that cannot collide', () => {
		// Two rows reading "Leading bid", or two identical consequence
		// sentences, are ordinary things for an override to say; keying on
		// either is a duplicate-key crash waiting for the first one.
		expect(SHEET_CODE).toContain('{#each view.rows as row (row.key)}');
		expect(SHEET_CODE).not.toContain('(row.label)');
		expect(SHEET_CODE).not.toContain('(note)');
	});

	it('labels the reason field to the field itself', () => {
		expect(SHEET_CODE).toMatch(/<label[^>]*for="override-reason"/);
		expect(TEXTAREA).toContain('id="override-reason"');
		expect(TEXTAREA).toContain('name={view.reasonFieldName}');
	});

	it('imports nothing server-only', () => {
		expect(SHEET).not.toMatch(/\$lib\/server|\$env\/(dynamic|static)\/private/);
	});
});

describe('scope — exactly one override reaches for this mechanism', () => {
	/** Every source file under `src/`, recursively. */
	function sources(dir = 'src', found: string[] = []): string[] {
		for (const entry of readdirSync(join(ROOT, ...dir.split('/')), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) sources(path, found);
			else if (/\.(ts|svelte)$/.test(entry.name)) found.push(path);
		}
		return found;
	}

	it('is reached for by the mechanism itself and by one override', () => {
		// The mechanism shipped with ZERO call sites in Story 7.1, exactly as
		// `commissioner-guard.ts` did, and Story 7.7 is the first override to
		// use it (FR-41's Roster Trade). The list below is therefore the four
		// files that OWN the mechanism plus the two that make up that one
		// override — and it is still an exhaustive list, which is the whole
		// point: a second override appearing without this test being edited is
		// a second override nobody reviewed.
		const owners = [
			'src/lib/core/rules/override.ts',
			'src/lib/server/override-guard.ts',
			'src/lib/reason-sheet-view.ts',
			'src/lib/components/ReasonSheet.svelte',
			'src/routes/roster-trade/+page.server.ts',
			'src/routes/roster-trade/+page.svelte',
			// Story 7.8's Drop — the second override to reach the mechanism, and
			// it reaches exactly the same four names the Trade does.
			'src/routes/roster-drop/+page.server.ts',
			'src/routes/roster-drop/+page.svelte',
			// Story 7.11's Roster Move — the third, and the first that is only
			// HALF an override. The Commissioner's on-behalf branch renders the
			// reason sheet and calls `requireOverrideReason`; a Manager's own
			// branch renders `ManagerSheet.svelte` and calls neither, because
			// FR-44 gives a Manager a confirmation rather than a justification.
			// The sheet component itself is listed for the same reason the
			// Commissioner's is: it owns half of the mechanism's markup.
			'src/lib/components/ManagerSheet.svelte',
			'src/routes/roster-move/+page.server.ts',
			'src/routes/roster-move/+page.svelte'
		];
		const naming = sources().filter((path) =>
			/buildOverrideRecord|requireOverrideReason|requireOverridablePhase|reasonSheetView|ReasonSheet/.test(
				readFileSync(join(ROOT, ...path.split('/')), 'utf8')
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/^\s*\/\/.*$/gm, '')
			)
		);
		expect(naming.sort()).toEqual(owners.sort());
	});

	it('adds no override route but the one, wherever somebody might have put it', () => {
		// Checking only `src/routes/override` proves nothing: the story's own
		// placement rule is "in place, on the object acted on", so the route an
		// override would actually get is `/board/void-bid` or
		// `/auction/[id]/override` — neither of which that check can see. This
		// walks every route file instead, the same way the call-site scan
		// beside it walks every source file.
		const routeFiles = sources('src/routes');
		const named = routeFiles.filter((path) =>
			/override|void-bid|restore|refold|reason-sheet/i.test(path)
		);
		expect(named).toEqual([]);

		// Exactly three routes reach for the mechanism: the Roster Trade (Story
		// 7.7, FR-41), the Drop (Story 7.8, FR-43) and the Roster Move (Story
		// 7.11, FR-44). All three are acts on a Team rather than on an object a
		// Manager is looking at, so each gets a destination of its own rather
		// than a control placed in context. The list stays exhaustive — a fourth
		// appearing without this test being edited is one nobody reviewed.
		const reaching = routeFiles.filter((path) =>
			/override-guard|rules\/override|reason-sheet-view|ReasonSheet/.test(
				readFileSync(join(ROOT, ...path.split('/')), 'utf8')
			)
		);
		expect(reaching.sort()).toEqual([
			'src/routes/roster-drop/+page.server.ts',
			'src/routes/roster-drop/+page.svelte',
			'src/routes/roster-move/+page.server.ts',
			'src/routes/roster-move/+page.svelte',
			'src/routes/roster-trade/+page.server.ts',
			'src/routes/roster-trade/+page.svelte'
		]);
	});

	it('leaves the Epic 1 Commissioner stylesheet free of reason-sheet text', () => {
		// The same guard `tests/commissioner.test.ts:385-398` holds, restated
		// from this side: the sheet's anatomy lives in the component, so that
		// file stays untouched by this story.
		const css = read('src', 'lib', 'styles', 'commissioner.css').toLowerCase();
		expect(css).not.toContain('reason-sheet');
		expect(css).not.toContain('.reason-');
	});

	it('adds no migration and no auction_events column', () => {
		// The reason travels in the event `payload`; the core type is what
		// makes it present. See the module's own note.
		const migrations = readdirSync(join(ROOT, 'supabase', 'migrations'));
		expect(migrations.filter((name) => /override|reason/i.test(name))).toEqual([]);
	});
});
