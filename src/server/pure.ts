// Port of id Software's server/sv_client.c SV_VerifyPaks_f.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { TrackedVirtualFileSystem } from "../assets/vfs.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { ServerClientLifecycleRuntime } from "./client-lifecycle.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerClient } from "./state.ts";

export interface ServerPureHost {
  readonly cvars: Pick<CvarRegistry, "get">;
  readonly files: TrackedVirtualFileSystem;
  debugPrint(text: string): void;
  tokenize(text: string): readonly string[];
}

/** PK3 attestation only. It does not attest the TypeScript client runtime's executable code. */
export class ServerPureRuntime {
  constructor(readonly lifecycle: ServerClientLifecycleRuntime, readonly host: ServerPureHost) {
    if (host.files.pakReferences.checksumFeed !== (lifecycle.world.checksumFeed >>> 0)) {
      throw new Error("Pure filesystem catalog and server world must share the checksum feed");
    }
  }

  *verifyPaks(client: ServerClient, argv: readonly string[]): CallSteps {
    if (this.lifecycle.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
    const pure = this.host.cvars.get("sv_pure");
    if (pure === undefined) throw new Error("Pure verification requires registered cvar sv_pure");
    if (pure.integerValue === 0) return;
    const files = this.host.files;
    const cgame = files.pakPureChecksum("vm/cgame.qvm");
    const ui = cgame === undefined ? undefined : files.pakPureChecksum("vm/ui.qvm");
    let good = cgame !== undefined && ui !== undefined;
    // Cmd_Argv returns a non-null empty string when an index is outside Cmd_Argc.
    const argument = (index: number): string => { const value = argv[index]; return value === undefined ? "" : value; };
    if (nativeAtoi(argument(1)) < this.lifecycle.world.checksumFeedServerId) {
      this.host.debugPrint(`ignoring outdated cp command from client ${client.name}\n`);
      return;
    }
    while (good) {
      if (argv.length < 6) { good = false; break; }
      const first = argument(2);
      if (first.startsWith("@") || cgame === undefined || nativeAtoi(first) !== (cgame | 0)) { good = false; break; }
      const second = argument(3);
      if (second.startsWith("@") || ui === undefined || nativeAtoi(second) !== (ui | 0)) { good = false; break; }
      if (!argument(4).startsWith("@")) { good = false; break; }
      // Normal Cmd tokenization caps total tokens at 1024. Bound direct callers too,
      // at the source copy stage, rather than reproducing a C stack-buffer overflow.
      if (argv.length - 5 > 1024) { good = false; break; }
      const checksums: number[] = [];
      for (let index = 5; index < argv.length; index++) checksums.push(nativeAtoi(argument(index)));
      const referenceCount = checksums.length - 1;
      const unique = new Set<number>();
      for (let index = 0; index < referenceCount; index++) {
        const checksum = checksums[index];
        if (checksum === undefined) throw new Error("Missing copied pure checksum");
        if (unique.has(checksum)) { good = false; break; }
        unique.add(checksum);
      }
      if (!good) break;
      // The source copies client tokens before this non-reentrant server tokenization.
      const serverChecksums = this.host.tokenize(files.pakReferences.loadedPakPureChecksums()).slice(0, 1024).map(nativeAtoi);
      for (const checksum of unique) {
        if (!serverChecksums.includes(checksum)) { good = false; break; }
      }
      if (!good) break;
      let checksum = this.lifecycle.world.checksumFeed;
      for (const reference of unique) checksum ^= reference;
      checksum ^= referenceCount;
      if (checksum !== checksums[referenceCount]) good = false;
      break;
    }
    client.gotCP = true;
    if (good) { client.pureAuthentic = true; return; }
    client.pureAuthentic = false;
    client.nextSnapshotTime = -1;
    if (client.connection.kind !== "initialized") throw new Error("Pure rejection requires an initialized client channel");
    client.connection.phase = ServerClientPhase.Active;
    this.lifecycle.host.sender.sendClientSnapshot(client);
    yield* this.lifecycle.dropClient(client, "Unpure client detected. Invalid .PK3 files referenced!");
  }
}
