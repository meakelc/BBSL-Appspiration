/**
 * The Supabase clients. Server-only, and the ONE place the service-role key is
 * read.
 *
 * AD-16: the service-role key, the Discord OAuth client secret and the Discord
 * webhook URL are server-only environment variables and must never appear
 * behind a `PUBLIC_`-prefixed name, which SvelteKit inlines into the client
 * bundle. Concentrating the key here means no route can reach it by accident —
 * a route that wants privileged access has to import this module, which is a
 * visible act in a diff.
 *
 * Two clients, two jobs:
 *
 *   - `serviceRoleClient()` bypasses row-level security and answers the one
 *     question this story asks of the database: is this Discord account in the
 *     `managers` registry? It never handles a request cookie and never carries
 *     a user's session.
 *   - `requestClient(cookies)` is a per-request `@supabase/ssr` client bound to
 *     the request's cookies. It holds the anon key, is subject to RLS like any
 *     browser would be, and is what performs the OAuth handshake. A new one is
 *     built for every render; a client is never shared across requests.
 *
 * Environment variables are read through `$env/dynamic/private`, not
 * `$env/static/private`, so a missing variable is a runtime failure with a
 * sentence in it rather than a build that fails in Netlify's log at 2am.
 */

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { Cookies } from '@sveltejs/kit';

import { discordIdentityOf } from './auth.ts';
import type { DiscordOAuthPort, ExchangeResult, ManagerRegistry, RegisteredManager } from './auth.ts';

/** Read a required server-only variable, failing with the name that is missing. */
function required(name: string, value: string | undefined): string {
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is not set. Server-side Supabase access is unavailable.`);
	}
	return value;
}

/** The project URL for this deploy context. production -> prod, else dev. */
export function supabaseUrl(): string {
	return required('SUPABASE_URL', env['SUPABASE_URL']);
}

/**
 * The service-role client. Bypasses RLS, so nothing built from it may ever be
 * handed to a browser. `persistSession: false` and `autoRefreshToken: false`
 * because this client has no user and must never write an auth cookie.
 */
export function serviceRoleClient(): SupabaseClient {
	return createClient(
		supabaseUrl(),
		required('SUPABASE_SERVICE_ROLE_KEY', env['SUPABASE_SERVICE_ROLE_KEY']),
		{
			auth: {
				persistSession: false,
				autoRefreshToken: false,
				detectSessionInUrl: false
			}
		}
	);
}

/**
 * A per-request client bound to this request's cookies.
 *
 * `getAll`/`setAll` rather than the deprecated `get`/`set`/`remove`: the
 * library's own documentation is explicit that the three-method form misses
 * edge cases and produces random logouts. `setAll` also receives the
 * no-store headers a response carrying a refreshed token must have, so they
 * are applied rather than dropped.
 */
export function requestClient(cookies: Cookies, responseHeaders?: Headers): SupabaseClient {
	return createServerClient(
		supabaseUrl(),
		required('PUBLIC_SUPABASE_ANON_KEY', publicEnv['PUBLIC_SUPABASE_ANON_KEY']),
		{
			cookies: {
				getAll: () => cookies.getAll(),
				setAll: (toSet, headers) => {
					for (const { name, value, options } of toSet) {
						// SvelteKit requires an explicit path on every cookie it sets.
						cookies.set(name, value, { ...options, path: options.path ?? '/' });
					}
					if (responseHeaders !== undefined) {
						for (const [key, headerValue] of Object.entries(headers)) {
							responseHeaders.set(key, headerValue);
						}
					}
				}
			}
		}
	);
}

// --- The concrete ports -----------------------------------------------------

/**
 * The registry, backed by the `managers` table through the service role.
 *
 * The lookup is by `discord_user_id` and returns identity only. It reads no
 * auth metadata: AD-15's whole point is that a self-writable claim cannot be
 * the binding, so the answer comes from a table the Commissioner alone writes.
 */
export function managerRegistry(client: SupabaseClient = serviceRoleClient()): ManagerRegistry {
	return {
		async findByDiscordUserId(discordUserId: string): Promise<RegisteredManager | null> {
			const { data, error } = await client
				.from('managers')
				.select('id, discord_user_id, display_name')
				.eq('discord_user_id', discordUserId)
				.maybeSingle();

			// A query error is not "not registered" — conflating them would turn a
			// database outage into a league-wide lockout that reads like a refusal.
			if (error !== null) {
				throw new Error(`managers lookup failed: ${error.message}`);
			}
			if (data === null) return null;

			const row = data as { id: string; discord_user_id: string; display_name: string };
			return {
				id: row.id,
				discordUserId: row.discord_user_id,
				displayName: row.display_name
			};
		}
	};
}

/**
 * The Discord provider, behind the port `auth.ts` declares.
 *
 * Everything Supabase Auth knows about Discord is confined to this function, so
 * a test substitutes an object literal and never touches the network — which is
 * how "Discord is down" becomes an assertion instead of a hope.
 */
export function discordOAuthPort(client: SupabaseClient, origin: string): DiscordOAuthPort {
	return {
		async authorizeUrl({ returnTo }): Promise<string> {
			const redirectTo = new URL('/auth/callback', origin);
			if (returnTo !== '/') redirectTo.searchParams.set('next', returnTo);
			const { data, error } = await client.auth.signInWithOAuth({
				provider: 'discord',
				options: { redirectTo: redirectTo.toString(), skipBrowserRedirect: true }
			});
			if (error !== null) throw new Error(`Discord authorize failed: ${error.message}`);
			if (data.url === null || data.url === '') throw new Error('Discord returned no authorize URL');
			return data.url;
		},

		async exchangeCode({ code }): Promise<ExchangeResult> {
			const { data, error } = await client.auth.exchangeCodeForSession(code);
			// A replayed code is refused by Supabase, and the refusal must say
			// nothing about the registry — the registry has not been consulted.
			if (error !== null) return { kind: 'refused' };
			// `discordIdentityOf` is the ONLY reader of identity in this codebase.
			// It deliberately ignores `user_metadata`, which is self-writable.
			const identity = discordIdentityOf(data.user);
			if (identity === null) return { kind: 'refused' };
			return { kind: 'exchanged', discordUserId: identity };
		},

		async destroySession(): Promise<void> {
			await client.auth.signOut({ scope: 'local' });
		}
	};
}
