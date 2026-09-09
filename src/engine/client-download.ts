// CL_InitDownloads/NextDownload/BeginDownload and CL_ParseDownload from
// id Software's code/client/cl_main.c and cl_parse.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { checkDownloadName, compareClientPaks } from "../assets/client-download.ts";
import type { CommonFileState } from "../assets/filesystem-state.ts";
import type { WritableBinaryFile } from "../assets/writable-files.ts";
import { CommonError } from "../core/common-error.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { Download } from "../protocol/server-message.ts";
import type { ClientConnectionState, ClientStaticState } from "./client-state.ts";

export interface ClientDownloadHost {
  readonly files: CommonFileState;
  readonly cvars: CvarRegistry;
  readonly connection: ClientConnectionState;
  readonly clientStatic: ClientStaticState;
  assertCurrentOperation(): void;
  print(text: string): void;
  addReliableCommand(text: string): void;
  writePacket(): void;
  downloadsComplete(): Promise<void | "retired">;
}

/** The connection owns this stream and worklist across individual gamestates. */
export class ClientDownloads {
  private list = "";
  private name = "";
  private file: WritableBinaryFile | null = null;
  private block = 0;
  private count = 0;
  private size = 0;
  private restart = false;
  private disposed = false;

  constructor(private readonly host: ClientDownloadHost) {}
  get pendingList(): string { return this.list; }
  get blockNumber(): number { return this.block; }
  get receivedBytes(): number { return this.count; }
  get fileSize(): number { return this.size; }
  get restartRequired(): boolean { return this.restart; }
  consumeRestart(): boolean { this.guard(); const restart = this.restart; this.restart = false; return restart; }
  private guard(): void {
    if (this.disposed) throw new Error("Client download resources are disposed");
    this.host.assertCurrentOperation();
  }
  private print(text: string): void { this.host.print(text); this.guard(); }
  private reliable(text: string): void { this.host.addReliableCommand(text); this.guard(); }
  private cvar(name: string, value: string | number): void {
    if (typeof value === "number") {
      value = Math.fround(value);
      if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648)
        throw new RangeError("Undefined native download Cvar_SetValue float-to-int conversion");
    }
    this.host.cvars.set(name, String(value), true); this.guard();
  }

  async initialize(): Promise<void | "retired"> {
    this.guard();
    const allow = this.host.cvars.get("cl_allowDownload");
    if (allow === undefined) throw new Error("Client downloads require cl_allowDownload registration");
    if (allow.integerValue === 0) {
      const missing = compareClientPaks(this.host.files, false);
      if (missing !== "") this.print("\nWARNING: You are missing some files referenced by the server:\n"
        + missing + "You might not be able to join the game\n"
        + "Go to the setting menu to turn on autodownload, or get the file elsewhere\n\n");
    } else {
      this.list = compareClientPaks(this.host.files, true);
      if (this.list !== "") {
        this.print(`Need paks: ${this.list}\n`);
        this.host.clientStatic.phase = "connected";
        return this.next();
      }
    }
    return this.host.downloadsComplete();
  }

  private async next(): Promise<void | "retired"> {
    this.guard();
    if (this.list !== "") {
      const start = this.list.startsWith("@") ? 1 : 0;
      const split = this.list.indexOf("@", start);
      if (split >= 0) {
        const end = this.list.indexOf("@", split + 1);
        const remote = this.list.slice(start, split);
        const local = this.list.slice(split + 1, end < 0 ? this.list.length : end);
        checkDownloadName(remote); checkDownloadName(local);
        const remaining = end < 0 ? "" : this.list.slice(end + 1);
        this.list = this.list.slice(0, split);
        if ((this.host.cvars.get("developer")?.integerValue ?? 0) !== 0)
          this.print("***** CL_BeginDownload *****\n"
            + `Localname: ${local}\nRemotename: ${remote}\n****************************\n`);
        this.name = local.slice(0, 4095);
        this.host.connection.downloadTempName = `${local}.tmp`.slice(0, 4095);
        this.cvar("cl_downloadName", remote); this.cvar("cl_downloadSize", 0); this.cvar("cl_downloadCount", 0);
        this.cvar("cl_downloadTime", this.host.clientStatic.realtime);
        this.block = 0; this.count = 0;
        this.reliable(`download ${remote}`);
        this.restart = true;
        this.list = remaining;
        return;
      }
    }
    return this.host.downloadsComplete();
  }

  /** CL_ParseDownload publishes the size before reading the error string or payload. */
  publishSize(fileSize: number): number {
    this.guard();
    this.size = fileSize; this.cvar("cl_downloadSize", this.size);
    return this.size;
  }

  async receive(download: Download): Promise<void | "retired"> {
    this.guard();
    if (download.kind === "error") {
      throw new CommonError("drop", download.message);
    }
    const block = download.kind === "start" ? 0 : download.number;
    if (block !== this.block) {
      if ((this.host.cvars.get("developer")?.integerValue ?? 0) !== 0)
        this.print(`CL_ParseDownload: Expected block ${this.block}, got ${block}\n`);
      return;
    }
    if (this.file === null) {
      const temporary = this.host.connection.downloadTempName;
      if (temporary === "") {
        this.print("Server sending download, but no download was requested\n"); this.reliable("stopdl"); return;
      }
      this.file = this.host.files.server.openWriteExclusive(temporary); this.guard();
      if (this.file === null) {
        this.print(`Could not create ${temporary}\n`); this.reliable("stopdl");
        return this.next();
      }
    }
    if (download.data.byteLength !== 0) { this.file.writeBytes(download.data); this.guard(); }
    this.reliable(`nextdl ${this.block}`); this.block = (this.block + 1) | 0;
    this.count = (this.count + download.data.byteLength) | 0; this.cvar("cl_downloadCount", this.count);
    if (download.data.byteLength === 0) {
      this.file.close(); this.file = null; this.guard();
      this.host.files.server.renameNoReplace(this.host.connection.downloadTempName, this.name); this.guard();
      this.host.connection.downloadTempName = ""; this.name = ""; this.cvar("cl_downloadName", "");
      this.host.writePacket(); this.guard(); this.host.writePacket(); this.guard();
      return this.next();
    }
  }

  /** Source disconnect closes a partial stream and leaves its temporary file. */
  close(): void {
    if (this.disposed) return;
    const file = this.file; this.file = null;
    file?.close();
    this.host.connection.downloadTempName = ""; this.name = "";
    this.host.cvars.set("cl_downloadName", "", true);
  }

  /** Final resource release does not replay CL_Disconnect's cvar or connection writes. */
  disposeResources(): void {
    if (this.disposed) return;
    this.disposed = true;
    const file = this.file; this.file = null;
    file?.close();
  }
}
