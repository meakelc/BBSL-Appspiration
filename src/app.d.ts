// See https://svelte.dev/docs/kit/types#app
//
// Locals are populated server-side only. Team binding and the Commissioner flag
// resolve from application tables the Commissioner alone writes — never from
// auth metadata or any client-influenceable claim. Story 1.4 fills this in.

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
