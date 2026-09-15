#!/usr/bin/env node
/**
 * Point a Manager's Discord @mention at a DIFFERENT Discord account from the
 * one they sign in with.
 *
 * **Why this is ever needed.** `managers.discord_user_id` is the account that
 * authenticates: `src/lib/server/supabase.ts` matches it against the OAuth
 * subject, and it is the only thing that decides whether a session is a
 * registered Manager. It is also, by default, the account the notification path
 * @mentions. Those are the same account for twenty-nine of the thirty Managers
 * — but a Manager who is a MEMBER of the league server under one Discord
 * account and signs in to the app with another has two snowflakes, and a
 * `<@id>` naming an account that is not in the guild renders as the literal
 * text `@unknown-user`. Nobody is pinged and nothing reports it.
 *
 * `managers.discord_mention_user_id` is the override, and this script is how it
 * is set. See
 * `supabase/migrations/20260917000000_manager_discord_mention_user_id.sql`.
 *
 * **It cannot break a sign-in, and that is the design.** The statement touches
 * `discord_mention_user_id` and nothing else. `discord_user_id` is untouched,
 * `managers.id` — the surrogate key every other table points at — is untouched,
 * and no session is invalidated. The worst a mistake here can do is misdirect a
 * notification, which is the thing it already does.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://...' node scripts/set-discord-mention-id.js --manager=Victor --mention-id=123
 *   SUPABASE_DB_URL='postgresql://...' node scripts/set-discord-mention-id.js --manager=Victor --mention-id=123 --confirm
 *   SUPABASE_DB_URL='postgresql://...' node scripts/set-discord-mention-id.js --manager=Victor --clear --confirm
 *
 * Without `--confirm` it reports what would change and writes nothing. Flags:
 *   --manager=<display name>  whose address to set (required; matched exactly)
 *   --mention-id=<snowflake>  the GUILD account to @mention them at
 *   --clear                   drop the override, addressing them at discord_user_id again
 *   --allow-prod              required when SUPABASE_ENVIRONMENT is `prod`
 *
 * Prod is guarded but NOT forbidden: unlike a pilot wipe, this is a correction
 * a live league legitimately needs, and whoever runs it has just watched a real
 * Manager miss a real notice. The guard is checked before connecting — one that
 * only fires after a successful connection fails open the moment the network
 * does.
 *
 * NOTE: `npm run check` does NOT type-check `scripts/`, so this is plain JS
 * written defensively rather than TypeScript leaning on the compiler.
 */

import process from 'node:process';

import pg from 'pg';

/** Read a `--name=value` argument, or undefined when it is absent. */
function arg(name) {
	const prefix = `--${name}=`;
	const found = process.argv.find((a) => a.startsWith(prefix));
	return found === undefined ? undefined : found.slice(prefix.length);
}

/**
 * A Discord snowflake, as Discord itself serialises one: a run of digits.
 *
 * Validated rather than trusted because the failure it prevents is silent. A
 * value with a stray space, an `<@…>` wrapper pasted out of a message, or a
 * username typed where an id was meant would satisfy the column's not-blank
 * check, sit in the row looking set, and produce `@unknown-user` forever — the
 * exact symptom this script exists to cure.
 */
function isSnowflake(value) {
	return /^[0-9]{5,25}$/.test(value);
}

async function main() {
	const url = process.env['SUPABASE_DB_URL'];
	if (url === undefined || url.trim() === '') {
		process.stderr.write(
			'SUPABASE_DB_URL is not set.\n' +
				"Run as: SUPABASE_DB_URL='postgresql://...' node scripts/set-discord-mention-id.js --manager=NAME --mention-id=ID\n"
		);
		process.exitCode = 1;
		return;
	}

	if (process.env['SUPABASE_ENVIRONMENT'] === 'prod' && !process.argv.includes('--allow-prod')) {
		process.stderr.write(
			'Refusing: SUPABASE_ENVIRONMENT is prod. Pass --allow-prod if that is genuinely meant.\n'
		);
		process.exitCode = 1;
		return;
	}

	const manager = arg('manager');
	if (manager === undefined || manager.trim() === '') {
		process.stderr.write('--manager=<display name> is required.\n');
		process.exitCode = 1;
		return;
	}

	const clearing = process.argv.includes('--clear');
	const mentionId = arg('mention-id');
	if (clearing && mentionId !== undefined) {
		process.stderr.write('--clear and --mention-id contradict each other. Pass one.\n');
		process.exitCode = 1;
		return;
	}
	if (!clearing) {
		if (mentionId === undefined || mentionId.trim() === '') {
			process.stderr.write('--mention-id=<snowflake> is required (or pass --clear).\n');
			process.exitCode = 1;
			return;
		}
		if (!isSnowflake(mentionId.trim())) {
			process.stderr.write(
				`'${mentionId}' is not a Discord snowflake — expected digits only.\n` +
					'In Discord, enable Developer Mode and use "Copy User ID" on the GUILD member.\n'
			);
			process.exitCode = 1;
			return;
		}
	}
	const target = clearing ? null : mentionId.trim();
	const confirmed = process.argv.includes('--confirm');

	const client = new pg.Client({ connectionString: url });
	try {
		await client.connect();
	} catch (error) {
		process.stderr.write(
			`Could not connect: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
		return;
	}

	try {
		// Matched on `display_name` because that is the name a human knows a
		// Manager by — and required to be UNIQUE among the rows returned rather
		// than taking the first. `display_name` carries no unique constraint, so
		// two Managers could share one; picking either would silently redirect
		// the wrong person's every notice.
		const { rows } = await client.query(
			`select id, display_name, discord_user_id, discord_mention_user_id
			 from public.managers
			 where display_name = $1
			 order by id asc`,
			[manager]
		);
		if (rows.length === 0) {
			process.stderr.write(`No Manager with display_name '${manager}'.\n`);
			process.exitCode = 1;
			return;
		}
		if (rows.length > 1) {
			process.stderr.write(
				`${String(rows.length)} Managers share display_name '${manager}'.\n` +
					'Which is meant is unknowable from the name. Disambiguate them first.\n'
			);
			process.exitCode = 1;
			return;
		}

		const row = rows[0];
		const before = row['discord_mention_user_id'];
		const beforeText = before === null ? `(none — addressed at ${row['discord_user_id']})` : before;
		const afterText = target === null ? `(none — addressed at ${row['discord_user_id']})` : target;

		process.stdout.write(
			`${String(row['display_name'])}\n` +
				`  signs in as   ${String(row['discord_user_id'])}  (unchanged)\n` +
				`  mentioned at  ${String(beforeText)}\n` +
				`             -> ${String(afterText)}\n\n`
		);

		if (String(beforeText) === String(afterText)) {
			process.stdout.write('Already set. Nothing to do.\n');
			return;
		}

		if (!confirmed) {
			process.stdout.write('DRY RUN — nothing written. Pass --confirm to apply.\n');
			return;
		}

		await client.query('update public.managers set discord_mention_user_id = $1 where id = $2', [
			target,
			row['id']
		]);
		process.stdout.write('Done.\n\n');
		// Said plainly because it is the first question the operator will have
		// next, and the answer is counter-intuitive: `notification_outbox` is
		// INSERT-ONLY and `recipient` is copied at insert, never joined at
		// dispatch. Intents queued before this runs still carry the old address
		// and will ping @unknown-user once more as they drain.
		process.stdout.write(
			'Intents already queued keep the OLD address — recipient is copied at insert,\n' +
				'never joined at dispatch. Notices enqueued from now on use the new one.\n'
		);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	} finally {
		await client.end();
	}
}

await main();
