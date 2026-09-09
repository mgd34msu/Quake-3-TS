// FS_ComparePaks from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommonFileState } from "./filesystem-state.ts";
import { isCredentialPath } from "./vfs.ts";

/** Names enter reliable commands and home-relative writes, never a shell. */
export function checkDownloadName(name: string): void {
  if (name.length === 0 || name.length >= 4096 || name.includes("..")
    || !/^[A-Za-z0-9_+./-]+$/.test(name) || name.startsWith("/")
    || name.split("/").some(component => component === "" || component === ".")
    || isCredentialPath(name.toLowerCase()) || !name.toLowerCase().endsWith(".pk3")) {
    throw new RangeError(`Unsafe package download name: ${JSON.stringify(name)}`);
  }
}

/** Source bounded @remote@local list, or the bounded missing-file diagnostic. */
export function compareClientPaks(files: CommonFileState, download: boolean, capacity = 1024): string {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Package comparison needs a nonempty source buffer");
  const loaded = new Set(files.current.pakReferences.snapshot().map(entry => entry.pack.checksum >>> 0));
  let result = "";
  const append = (text: string): void => { result += text.slice(0, Math.max(0, capacity - 1 - result.length)); };
  for (const pack of files.serverReferencedPaks) {
    if (pack.name === null || pack.name === "" || loaded.has(pack.checksum >>> 0)) continue;
    // FS_idPak compares paths case-insensitively and protects pak0 through pak8.
    if (/^(baseq3|missionpack)\/pak[0-8]$/i.test(pack.name.replaceAll("\\", "/").replaceAll(":", "/"))) continue;
    const remote = `${pack.name}.pk3`;
    checkDownloadName(remote);
    const exists = files.server.exists(remote);
    if (download) {
      append(`@${remote}@`);
      append(exists ? `${pack.name}.${(pack.checksum >>> 0).toString(16).padStart(8, "0")}.pk3` : remote);
    } else {
      append(remote);
      if (exists) append(" (local file exists with wrong checksum)");
      append("\n");
    }
  }
  return result;
}
