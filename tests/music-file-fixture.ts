// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { BinaryWriter } from "../src/core/binary.ts";

export function musicWav(sound: PcmSound): Uint8Array {
  const bytes = sound.samples.byteLength;
  const out = new BinaryWriter(44 + bytes);
  const name = (value: string): void => { out.bytes(new TextEncoder().encode(value)); };
  name("RIFF"); out.u32(36 + bytes); name("WAVE");
  name("fmt "); out.u32(16); out.u16(1); out.u16(sound.channels);
  out.u32(sound.sampleRate); out.u32(sound.sampleRate * sound.channels * 2);
  out.u16(sound.channels * 2); out.u16(16); name("data"); out.u32(bytes);
  for (const sample of sound.samples) out.i16(sample);
  return out.finish();
}

export async function musicFiles(tracks: ReadonlyMap<string, PcmSound | Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "quake3-music-"));
  try {
    await mkdir(join(root, "baseq3"));
    for (const [name, sound] of tracks) {
      const path = join(root, "baseq3", name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, sound instanceof Uint8Array ? sound : musicWav(sound));
    }
    const files = await VirtualFileSystem.openInspection({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" });
    return {
      root, files,
      async close(): Promise<void> {
        try { files.close(); } finally { await rm(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
