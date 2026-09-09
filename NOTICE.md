# Attribution

Quake III Arena source code is Copyright 1999-2005 id Software, Inc. This project is an altered TypeScript translation and new implementation, distributed under GPL-2.0-or-later for the translated GPL portions. See LICENSE. It is not an official id Software release.

The JPEG decoder and encoder are altered TypeScript translations of portions of the Independent JPEG Group's release 6b. They include marker parsing and emission, Huffman coding, floating-point DCT and IDCT, sampling and color conversion. The production encoder uses Quake III's fixed SaveJPG destination allocation; its standalone diagnostic profile has a growing buffer. This software is based in part on the work of the Independent JPEG Group. The unaltered upstream README and its terms are in [licenses/IJG-README.txt](licenses/IJG-README.txt).

The raw DEFLATE decoder in [src/assets/inflate.ts](src/assets/inflate.ts) is an altered TypeScript implementation of the zlib inflater bundled in `qcommon/unzip.c`, Copyright 1995–1998 Jean-loup Gailly and Mark Adler. Its original permission and disclaimer are retained in that file. It uses canonical symbol decoding and bounded history rather than the original lookup tables and allocation structure.

The Intel/DVI ADPCM implementation in [src/audio/adpcm.ts](src/audio/adpcm.ts) is based on the IMA Compatibility Project implementation, Copyright 1992 Stichting Mathematisch Centrum, Amsterdam, The Netherlands. All Rights Reserved.

Permission to use, copy, modify, and distribute this software and its documentation for any purpose and without fee is hereby granted, provided that the above copyright notice appear in all copies and that both that copyright notice and this permission notice appear in supporting documentation, and that the names of Stichting Mathematisch Centrum or CWI not be used in advertising or publicity pertaining to distribution of the software without specific, written prior permission.

STICHTING MATHEMATISCH CENTRUM DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS, IN NO EVENT SHALL STICHTING MATHEMATISCH CENTRUM BE LIABLE FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

`src/core/native-random.ts` is an altered, instance-owned TypeScript translation of the GNU C Library's default TYPE_3 random-number generator. The original is Copyright Free Software Foundation, Inc., distributed under LGPL-2.1-or-later. Its license is included in [licenses/LGPL-2.1.txt](licenses/LGPL-2.1.txt). Source and native-sequence provenance are recorded in `tests/core/native-random.test.ts`.

Retail Quake III Arena and Team Arena artwork, maps, music and other game data remain separate installed inputs and are not included in this project or its executable. Bun, SDL2 and the OpenGL implementation are external runtime/tooling dependencies with their own licenses.

Additional notices must accompany translations of other upstream files covered by the source release README's exceptions. The source inventory tracks those inputs; a mapping alone does not establish complete translation.
