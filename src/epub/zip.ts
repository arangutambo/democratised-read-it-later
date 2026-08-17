/**
 * Reading a ZIP archive, which is what an EPUB is.
 *
 * Written rather than depended on. `JSZip` is ~100 KB for a format whose reading half is a
 * few hundred lines, and this plugin already refuses to ship `pdfjs-dist` for the same reason.
 * Decompression uses `DecompressionStream`, a web standard present in Obsidian's Chromium and
 * in Node — so the same code runs on desktop, on mobile, and in a test.
 *
 * Only the reading half exists, and deliberately: Reader never writes an EPUB.
 *
 * No `obsidian` import — see PLAN-V2.md §3.1.
 */

export class ZipError extends Error {}

/** Signatures, little-endian, as they appear in the file. */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

interface Entry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

export class ZipArchive {
	private readonly bytes: Uint8Array;
	private readonly view: DataView;
	private readonly entries = new Map<string, Entry>();

	private constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.readCentralDirectory();
	}

	static open(bytes: Uint8Array): ZipArchive {
		return new ZipArchive(bytes);
	}

	/** Every path in the archive, in central-directory order. */
	get names(): string[] {
		return [...this.entries.keys()];
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	/**
	 * The central directory is at the end, which is what makes a ZIP readable without
	 * scanning it: find the end-of-central-directory record, then walk the entries it points
	 * at. Scanning from the front would mean inflating everything to find one file.
	 */
	private readCentralDirectory(): void {
		const start = this.findEndOfCentralDirectory();

		const count = this.view.getUint16(start + 10, true);
		let at = this.view.getUint32(start + 16, true);

		for (let i = 0; i < count; i++) {
			if (this.view.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
				throw new ZipError("This archive's central directory is malformed.");
			}

			const nameLength = this.view.getUint16(at + 28, true);
			const extraLength = this.view.getUint16(at + 30, true);
			const commentLength = this.view.getUint16(at + 32, true);

			const name = new TextDecoder().decode(this.bytes.subarray(at + 46, at + 46 + nameLength));

			this.entries.set(name, {
				name,
				method: this.view.getUint16(at + 10, true),
				compressedSize: this.view.getUint32(at + 20, true),
				uncompressedSize: this.view.getUint32(at + 24, true),
				localHeaderOffset: this.view.getUint32(at + 42, true),
			});

			at += 46 + nameLength + extraLength + commentLength;
		}
	}

	private findEndOfCentralDirectory(): number {
		/*
		 * The record is 22 bytes plus a comment of up to 64 KB, and there is no pointer to it —
		 * so it is found by scanning backwards for the signature. Starting from the end rather
		 * than a fixed offset is what makes an archive with a comment readable at all.
		 */
		const minimum = 22;
		if (this.bytes.byteLength < minimum) throw new ZipError("This file is too short to be a ZIP.");

		const earliest = Math.max(0, this.bytes.byteLength - minimum - 0xffff);
		for (let at = this.bytes.byteLength - minimum; at >= earliest; at--) {
			if (this.view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at;
		}

		throw new ZipError("This file is not a ZIP archive.");
	}

	/** The raw bytes of one entry, inflated if it needs to be. */
	async read(name: string): Promise<Uint8Array> {
		const entry = this.entries.get(name);
		if (!entry) throw new ZipError(`${name} is not in this archive.`);

		/*
		 * The local header repeats the name and extra fields, and its extra-field length can
		 * differ from the central directory's. So the data offset must be computed from the
		 * *local* header — using the central one silently reads from the wrong place.
		 */
		const local = entry.localHeaderOffset;
		if (this.view.getUint32(local, true) !== LOCAL_FILE_HEADER) {
			throw new ZipError(`${name} has a malformed local header.`);
		}

		const nameLength = this.view.getUint16(local + 26, true);
		const extraLength = this.view.getUint16(local + 28, true);
		const from = local + 30 + nameLength + extraLength;
		const raw = this.bytes.subarray(from, from + entry.compressedSize);

		if (entry.method === STORED) return raw;
		if (entry.method !== DEFLATED) {
			throw new ZipError(`${name} uses an unsupported compression method (${entry.method}).`);
		}

		return inflateRaw(raw);
	}

	/** One entry as text. EPUB content is UTF-8 throughout. */
	async readText(name: string): Promise<string> {
		return new TextDecoder().decode(await this.read(name));
	}
}

/**
 * Raw DEFLATE, via the platform.
 *
 * `deflate-raw` rather than `deflate`: ZIP stores the compressed stream with no zlib header,
 * and asking for the wrapped format fails on every entry.
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === "undefined") {
		throw new ZipError("This build has no DecompressionStream, so compressed archives cannot be read.");
	}

	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
