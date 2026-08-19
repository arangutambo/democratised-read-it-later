/**
 * Generates `test/fixtures/sample.epub`.
 *
 * There was no EPUB on the machine this was written on, and the ones in the user's library are
 * copyrighted textbooks that cannot be committed. So the fixture is a real EPUB — a genuine
 * ZIP with a genuine container, package document and spine — carrying invented text.
 *
 * The same approach as `make-books-fixture.ts`: the *structure* is real, the *content* is not.
 * That catches format bugs, which is what a fixture is for; it does not catch the oddities of
 * a 22 MB Goodman & Gilman, which is why that is on the real-window checklist instead.
 *
 * Run with: npm run epub:fixture
 */

import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { say } from "./report";

interface Member {
	name: string;
	data: Buffer;
	/** The mimetype entry must be stored, not deflated — see below. */
	store?: boolean;
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:0f9b1b4e-0000-4000-8000-000000000001</dc:identifier>
    <dc:title>A Short Book About Nothing</dc:title>
    <dc:creator>Ada Placeholder</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav"   href="nav.xhtml"      media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1"   href="ch1.xhtml"      media-type="application/xhtml+xml"/>
    <item id="ch2"   href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="fig1"  href="images/fig1.png" media-type="image/png"/>
    <item id="css"   href="style.css"      media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="ch1.xhtml">One: Beginnings</a>
          <ol><li><a href="ch1.xhtml#s2">A subsection</a></li></ol>
        </li>
        <li><a href="text/ch2.xhtml">Two: Middles</a></li>
      </ol>
    </nav>
  </body>
</html>
`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title><link rel="stylesheet" href="style.css"/></head>
  <body>
    <h1>One: Beginnings</h1>
    <p>The first paragraph says something plain, so that a quote taken from it can be
       checked against what the reader believes it captured.</p>
    <h2 id="s2">A subsection</h2>
    <p>A second paragraph, containing the phrase <em>needle in the haystack</em> exactly once.</p>
    <figure>
      <img src="images/fig1.png" alt="A figure"/>
      <figcaption>Figure 1: a caption.</figcaption>
    </figure>
  </body>
</html>
`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Two</title></head>
  <body>
    <h1>Two: Middles</h1>
    <p>A chapter reached by a relative path from a subfolder, which is where naive path
       joining goes wrong.</p>
    <p>It mentions the needle in the haystack a second time, on a different section.</p>
  </body>
</html>
`;

/** A 1×1 PNG. Enough to be a real image without being a real picture. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function crc32(data: Buffer): number {
	let crc = ~0;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

/**
 * Write a ZIP by hand, so the fixture exercises the reader rather than a library's idea of a
 * ZIP. `mimetype` is stored uncompressed and written first: that is the one EPUB-specific
 * requirement in the container format, and a reader that cannot cope with a stored entry
 * would pass every other test and fail on every real book.
 */
function zip(members: Member[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const member of members) {
		const name = Buffer.from(member.name, "utf8");
		const stored = member.store === true;
		const body = stored ? member.data : deflateRawSync(member.data);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(stored ? 0 : 8, 8); // method
		local.writeUInt32LE(crc32(member.data), 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(member.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(stored ? 0 : 8, 10);
		central.writeUInt32LE(crc32(member.data), 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(member.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);

		locals.push(local, body);
		centrals.push(central);
		offset += local.length + body.length;
	}

	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(members.length, 8);
	end.writeUInt16LE(members.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);

	return Buffer.concat([...locals, directory, end]);
}

/*
 * Relative to the working directory, not to `__dirname`.
 *
 * esbuild bundles this to a temporary file elsewhere, so `__dirname` is the bundle's home and
 * the fixture landed two directories above the repo. npm scripts always run at the package
 * root, which is what this resolves against.
 */
const out = path.resolve(process.cwd(), "test/fixtures/sample.epub");
mkdirSync(path.dirname(out), { recursive: true });

writeFileSync(
	out,
	zip([
		{ name: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
		{ name: "META-INF/container.xml", data: Buffer.from(CONTAINER) },
		{ name: "OEBPS/content.opf", data: Buffer.from(OPF) },
		{ name: "OEBPS/nav.xhtml", data: Buffer.from(NAV) },
		{ name: "OEBPS/ch1.xhtml", data: Buffer.from(CH1) },
		{ name: "OEBPS/text/ch2.xhtml", data: Buffer.from(CH2) },
		{ name: "OEBPS/images/fig1.png", data: PNG },
		{ name: "OEBPS/style.css", data: Buffer.from("body { font-family: serif; }\n") },
	]),
);

say(`wrote ${out}`);
