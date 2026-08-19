/**
 * Branded integer-dollar money type and its edge parsers (AD-8).
 *
 * Stub. Story 1.2 fills this in.
 *
 * Constraints already fixed for that story:
 *  - Integer dollars end to end. Never a float, never an unparsed string, never
 *    formatted before the view.
 *  - Branded at every runtime boundary — the same int8 arrives as a string
 *    through one client and a number through the other, so both parse at the
 *    edge.
 *  - Rendered $14.5M: always exactly one decimal, never dropped; a true minus
 *    sign (U+2212) for negatives; fails loudly rather than rounding off the
 *    $500,000 grid.
 *  - The renderer must be structurally unable to reach a CSV cell — exports emit
 *    integers, never the rendering.
 *
 * This module is part of the PURE core: no I/O, no clock, no randomness, stdlib
 * only, relative .ts imports only so Deno can load it (AD-2).
 */

export {};
