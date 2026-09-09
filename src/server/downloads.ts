// Port of id Software's server/sv_client.c download window and acknowledgement handling.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { ServerFileSystem } from "../assets/server-files.ts";
import { ServerDownloadError } from "../assets/download-file.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { MessageWriter } from "../protocol/message.ts";
import { ServerOpcode } from "../protocol/server-message.ts";
import { SERVER_DOWNLOAD_WINDOW } from "./state.ts";
import type { ServerClient, ServerStaticState } from "./state.ts";

const BLOCK_BYTES = 2048;

export interface ServerDownloadHost {
  readonly files: Pick<ServerFileSystem, "openDownload">;
  readonly cvars: Pick<CvarRegistry, "get" | "set">;
  readonly print: (text: string) => void;
  readonly debugPrint: (text: string) => void;
  readonly dropClient: (client: ServerClient, reason: string) => CallSteps;
  readonly sendClientGameState: (client: ServerClient) => void;
}

function sourceName(value: string): string {
  const nul = value.indexOf("\0");
  const name = value.slice(0, Math.min(63, nul < 0 ? value.length : nul));
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) > 255) throw new RangeError("Download names require source byte characters");
  }
  return name;
}

/** FS_idPak's extensionless names, plus an explicit retail-data protection for wire .pk3 names. */
function stockProduct(name: string): "baseq3" | "missionpack" | null {
  const normalized = name.replaceAll("\\", "/").replaceAll(":", "/").toLowerCase();
  for (const product of ["baseq3", "missionpack"]) {
    for (let index = 0; index < 9; index++) {
      const stem = `${product}/pak${index}`;
      if (normalized === stem || normalized === `${stem}.pk3`) return product === "baseq3" ? "baseq3" : "missionpack";
    }
  }
  return null;
}

/** Owns no second download state; all window counters and the open file live in client_t. */
export class ServerDownloadRuntime {
  private disposed = false;
  constructor(readonly staticState: ServerStaticState, readonly host: ServerDownloadHost) {}

  private own(client: ServerClient): void {
    if (this.disposed) throw new Error("Server download resources have been disposed");
    if (this.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
  }

  private integer(name: string): number {
    const value = this.host.cvars.get(name);
    if (value === undefined) throw new Error(`Required server cvar is not registered: ${name}`);
    return value.integerValue;
  }

  close(client: ServerClient): void {
    this.own(client);
    const download = client.download;
    if (download.file !== null) download.file.close();
    download.file = null;
    download.name = "";
    download.blocks.fill(null);
  }

  /** Terminal resource release, without the source download protocol or console callbacks. */
  disposeResources(): void {
    if (this.disposed) return;
    this.disposed = true;
    const files = this.staticState.clients.map(client => {
      const download = client.download, file = download.file;
      download.file = null; download.name = ""; download.blocks.fill(null);
      return file;
    });
    const errors: unknown[] = [];
    for (const file of files) {
      try { file?.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Server download resource disposal failed");
  }

  stop(client: ServerClient): void {
    this.own(client);
    if (client.download.name.length !== 0) this.host.debugPrint(`clientDownload: ${client.slot} : file "${client.download.name}" aborted\n`);
    this.close(client);
  }

  done(client: ServerClient): void {
    this.own(client);
    this.host.debugPrint(`clientDownload: ${client.name} Done\n`);
    this.own(client);
    this.host.sendClientGameState(client);
  }

  begin(client: ServerClient, argv: readonly string[]): void {
    this.close(client);
    this.own(client);
    client.download.name = sourceName(argv[1] === undefined ? "" : argv[1]);
  }

  *next(client: ServerClient, argv: readonly string[]): CallSteps {
    this.own(client);
    const download = client.download;
    const block = nativeAtoi(argv[1] === undefined ? "" : argv[1]);
    if (block !== download.clientBlock) {
      yield* this.host.dropClient(client, "broken download");
      return;
    }
    this.host.debugPrint(`clientDownload: ${client.slot} : client acknowledge of block ${block}\n`);
    this.own(client);
    const size = download.blockSizes[download.clientBlock % SERVER_DOWNLOAD_WINDOW];
    if (size === undefined) throw new RangeError("Download acknowledgement references an invalid window slot");
    if (size === 0) {
      this.host.print(`clientDownload: ${client.slot} : file "${download.name}" completed\n`);
      this.close(client);
      return;
    }
    download.sendTime = this.staticState.time;
    download.clientBlock = (download.clientBlock + 1) | 0;
  }

  private open(client: ServerClient, writer: MessageWriter): boolean {
    const download = client.download;
    this.host.print(`clientDownload: ${client.slot} : begining "${download.name}"\n`);
    this.own(client);
    const stock = stockProduct(download.name);
    if (this.integer("sv_allowDownload") !== 0 && stock === null) {
      const file = this.host.files.openDownload(download.name);
      try { this.own(client); }
      catch (ownershipFailure) {
        try { file?.close(); }
        catch (releaseFailure) {
          throw new AggregateError([ownershipFailure, releaseFailure], "Download ownership and late file release failed");
        }
        throw ownershipFailure;
      }
      download.file = file;
      download.size = download.file === null ? -1 : download.file.size;
      if (download.size > 0) {
        download.currentBlock = 0; download.clientBlock = 0; download.xmitBlock = 0;
        download.count = 0; download.eof = false;
        return true;
      }
    }
    let error: string;
    if (stock !== null) {
      this.host.print(`clientDownload: ${client.slot} : "${download.name}" cannot download id pk3 files\n`);
      error = stock === "missionpack"
        ? `Cannot autodownload Team Arena file "${download.name}"\nThe Team Arena mission pack can be found in your local game store.`
        : `Cannot autodownload id pk3 file "${download.name}"`;
    } else if (this.integer("sv_allowDownload") === 0) {
      this.host.print(`clientDownload: ${client.slot} : "${download.name}" download disabled`);
      error = `Could not download "${download.name}" because autodownloading is disabled on the server.\n\n`
        + (this.integer("sv_pure") !== 0
          ? "You will need to get this file elsewhere before you can connect to this pure server.\n"
          : "The server you are connecting to is not a pure server, set autodownload to No in your settings and you might be able to join the game anyway.\n");
    } else {
      this.host.print(`clientDownload: ${client.slot} : "${download.name}" file not found on server\n`);
      error = `File "${download.name}" not found on server for autodownloading.\n`;
    }
    this.own(client);
    writer.writeByte(ServerOpcode.Download); writer.writeShort(0); writer.writeLong(-1); writer.writeString(error.slice(0, 1023));
    download.name = "";
    return false;
  }

  writeToClient(client: ServerClient, writer: MessageWriter): void {
    this.own(client);
    try { this.write(client, writer); }
    catch (error) {
      if (this.disposed) throw error;
      if (!(error instanceof ServerDownloadError)) throw error;
      const name = client.download.name;
      this.close(client);
      this.own(client);
      this.host.print(`clientDownload: ${client.slot} : "${name}" rejected: ${error.message}\n`);
      this.own(client);
      writer.writeByte(ServerOpcode.Download); writer.writeShort(0); writer.writeLong(-1);
      writer.writeString(`File "${name}" could not be read safely for autodownloading.\n`);
    }
  }

  private write(client: ServerClient, writer: MessageWriter): void {
    const download = client.download;
    if (download.name.length === 0) return;
    if (download.file === null && !this.open(client, writer)) return;
    const file = download.file;
    if (file === null) throw new Error("Download opened without a file resource");
    while (download.currentBlock - download.clientBlock < SERVER_DOWNLOAD_WINDOW && download.size !== download.count) {
      const index = download.currentBlock % SERVER_DOWNLOAD_WINDOW;
      let buffer = download.blocks[index];
      if (buffer === undefined) throw new RangeError("Download read references an invalid window slot");
      if (buffer === null) { buffer = new Uint8Array(BLOCK_BYTES); download.blocks[index] = buffer; }
      const bytes = file.read(buffer);
      download.blockSizes[index] = bytes;
      download.count = (download.count + bytes) | 0;
      download.currentBlock = (download.currentBlock + 1) | 0;
    }
    if (download.count === download.size && !download.eof && download.currentBlock - download.clientBlock < SERVER_DOWNLOAD_WINDOW) {
      download.blockSizes[download.currentBlock % SERVER_DOWNLOAD_WINDOW] = 0;
      download.currentBlock = (download.currentBlock + 1) | 0;
      download.eof = true;
    }
    let rate = client.rate;
    if (this.integer("sv_maxRate") !== 0) {
      if (this.integer("sv_maxRate") < 1000) this.host.cvars.set("sv_MaxRate", "1000", true);
      if (this.integer("sv_maxRate") < rate) rate = this.integer("sv_maxRate");
    }
    let blocks = rate === 0 ? 1 : Math.trunc(((Math.trunc(Math.imul(rate, client.snapshotMsec) / 1000) + BLOCK_BYTES) | 0) / BLOCK_BYTES);
    if (blocks < 0) blocks = 1;
    while (blocks-- > 0) {
      if (download.clientBlock === download.currentBlock) return;
      if (download.xmitBlock === download.currentBlock) {
        if (((this.staticState.time - download.sendTime) | 0) > 1000) download.xmitBlock = download.clientBlock;
        else return;
      }
      const index = download.xmitBlock % SERVER_DOWNLOAD_WINDOW;
      const size = download.blockSizes[index];
      if (size === undefined) throw new RangeError("Download send references an invalid window slot");
      writer.writeByte(ServerOpcode.Download); writer.writeShort(download.xmitBlock);
      if (download.xmitBlock === 0) writer.writeLong(download.size);
      writer.writeShort(size);
      if (size !== 0) {
        const buffer = download.blocks[index];
        if (buffer === undefined || buffer === null) throw new Error("Download block has bytes but no buffer");
        writer.writeData(buffer.subarray(0, size));
      }
      this.host.debugPrint(`clientDownload: ${client.slot} : writing block ${download.xmitBlock}\n`);
      this.own(client);
      download.xmitBlock = (download.xmitBlock + 1) | 0;
      download.sendTime = this.staticState.time;
    }
  }
}
