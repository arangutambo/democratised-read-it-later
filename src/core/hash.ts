/**
 * Content hashing for managed regions.
 *
 * FNV-1a, not SHA-256 as PLAN.md §4.1 first said. The hash detects whether a managed region
 * was hand-edited between writes; it is not a security boundary, and nobody is mounting a
 * collision attack on their own notes. FNV-1a is synchronous, which matters because region
 * parsing happens inside a markdown post-processor where an `await` would mean rendering
 * highlights a frame late. Web Crypto's digest is async-only.
 *
 * No `obsidian` import — see PLAN.md §3.1.
 */

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-16 code units, returned as 8 lowercase hex characters. */
export function contentHash(input: string): string {
	let hash = OFFSET_BASIS;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i) & 0xff;
		hash = Math.imul(hash, PRIME);
		// Code units above U+00FF contribute their high byte too, so that text differing
		// only in a non-Latin character still changes the hash.
		const high = input.charCodeAt(i) >>> 8;
		if (high !== 0) {
			hash ^= high;
			hash = Math.imul(hash, PRIME);
		}
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
