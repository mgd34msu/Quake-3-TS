/*
 * Bot source loading from id Software's botlib/l_script.c and l_precomp.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { VirtualFileSystem } from "../assets/vfs.ts";
import { allocateScriptSource } from "../script/lexer.ts";
import type { ScriptMemory } from "../script/memory.ts";
import type { SourceTokenMemory } from "../script/token-memory.ts";
import { ScriptSourceReader } from "../script/preprocessor.ts";
import type { IncludeRequest, IncludeResolver, ScriptGlobalDefines, ScriptSource,
  ScriptSourcePosition, ScriptTokenRecord } from "../script/preprocessor.ts";
import { BotMemory } from "./memory.ts";

const MAX_SOURCE_FILES = 64;
const MAX_SOURCE_PATH = 64;

export interface BotScriptReader extends IncludeResolver {
  readonly globals: ScriptGlobalDefines;
  resolveRoot(path: string): ScriptSource | undefined;
}

function sourceString(text: string): string {
  const zero = text.indexOf("\0");
  const value = zero < 0 ? text : text.slice(0, zero);
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 255) throw new RangeError("bot source filenames must contain source bytes");
  }
  return value;
}

export class BotScriptSources implements BotScriptReader {
  private readonly sourceFiles: (ScriptSourceReader | undefined)[] = Array.from(
    { length: MAX_SOURCE_FILES }, (): ScriptSourceReader | undefined => undefined,
  );
  private baseFolder = "";
  private terminal = false;

  constructor(
    private readonly assets: Pick<VirtualFileSystem, "openRead" | "readInto" | "closeFile">,
    readonly globals: ScriptGlobalDefines,
    private readonly print: (severity: 2 | 3, text: string) => undefined,
    private readonly commonPrint: (text: string) => undefined,
    private readonly memory: ScriptMemory = new BotMemory(),
  ) {}

  /** Bot consumers pair PC_SetBaseFolder("botfiles") with LoadSourceFile. */
  resolveRoot(path: string): ScriptSource | undefined {
    this.setBaseFolder("botfiles");
    return this.readFile(path);
  }

  setBaseFolder(path: string): void {
    this.requireLive();
    const source = sourceString(path);
    let folder = "";
    // PS_SetBaseFolder passes its path as the Com_sprintf format with no arguments.
    for (let index = 0; index < source.length; index++) {
      const character = source.charAt(index);
      if (character === "%") {
        if (source.charAt(index + 1) !== "%") {
          throw new RangeError("PC_SetBaseFolder format conversion requires absent source arguments");
        }
        index++;
      }
      folder += character;
    }
    this.baseFolder = this.boundedPath(folder);
  }

  loadSourceHandle(filename: string | (() => string)): number {
    this.requireLive();
    let handle = 1;
    for (; handle < MAX_SOURCE_FILES; handle++) {
      if (this.sourceFiles[handle] === undefined) break;
    }
    if (handle === MAX_SOURCE_FILES) return 0;
    this.setBaseFolder("");
    const root = this.readFile(typeof filename === "string" ? filename : filename());
    if (root === undefined) return 0;
    const source = ScriptSourceReader.open(root, this, {
      globals: this.globals,
      report: diagnostic => {
        this.requireLive();
        this.print(diagnostic.severity === "warning" ? 2 : 3,
          `file ${diagnostic.location.path}, line ${diagnostic.location.line}: ${diagnostic.message}\n`);
        this.requireLive();
      },
    });
    this.sourceFiles[handle] = source;
    return handle;
  }

  freeSourceHandle(handle: number): boolean {
    this.requireLive();
    if (handle < 1 || handle >= MAX_SOURCE_FILES) return false;
    const source = this.sourceFiles[handle];
    if (source === undefined) return false;
    source.dispose();
    this.sourceFiles[handle] = undefined;
    return true;
  }

  readTokenHandle(handle: number): ScriptTokenRecord | undefined {
    const result = this.readTokenHandleResult(handle);
    if (result === undefined || !result.read) return undefined;
    const source = this.sourceFiles[handle];
    if (source === undefined) throw new Error("script handle retired during a completed read");
    return source.currentRecord;
  }

  readTokenHandleResult(handle: number): { readonly read: boolean; readonly token: SourceTokenMemory } | undefined {
    this.requireLive();
    if (handle < 1 || handle >= MAX_SOURCE_FILES) return undefined;
    const source = this.sourceFiles[handle];
    if (source === undefined) return undefined;
    try { return { read: source.next() !== undefined, token: source.rawToken }; }
    catch (error) {
      if (source.isSourceFailure(error)) return { read: false, token: source.rawToken };
      throw error;
    }
  }

  sourceFileAndLine(handle: number): ScriptSourcePosition | undefined {
    this.requireLive();
    if (handle < 1 || handle >= MAX_SOURCE_FILES) return undefined;
    const position = this.sourceFiles[handle]?.position;
    if (position === undefined) return undefined;
    // LoadSourceFile copies MAX_PATH bytes into its cleared 1024-byte filename.
    return { filename: position.filename.slice(0, MAX_SOURCE_PATH), line: position.line };
  }

  checkOpenSourceHandles(): void {
    this.requireLive();
    for (let handle = 1; handle < MAX_SOURCE_FILES; handle++) {
      const source = this.sourceFiles[handle];
      if (source === undefined) continue;
      this.print(3, `file ${source.currentScriptFilename} still open in precompiler\n`);
      this.requireLive();
    }
  }

  disposeResources(): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const source of this.sourceFiles) source?.dispose();
    this.sourceFiles.fill(undefined);
  }

  private readFile(path: string): ScriptSource | undefined {
    this.requireLive();
    const filename = sourceString(path);
    const assetPath = this.boundedPath(this.baseFolder.length === 0 ? filename : `${this.baseFolder}/${filename}`);
    const opened = this.assets.openRead(assetPath);
    this.requireLive();
    if (opened === undefined) return undefined;
    const source = allocateScriptSource(opened.length, filename, this.memory);
    this.assets.readInto(opened.file, source.buffer);
    this.requireLive();
    this.assets.closeFile(opened.file);
    this.requireLive();
    source.compress();
    return source;
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    this.requireLive();
    const requested = sourceString(request.requestedPath);
    if (request.kind === "system" && requested.length >= MAX_SOURCE_PATH) {
      throw new RangeError("PC_Directive_include system filename exceeds its 64-byte source path");
    }
    const filename = requested.replace(/[\\/]+/g, "/");
    const source = this.readFile(filename);
    if (source !== undefined || request.kind === "system") return source;
    const retry = sourceString(request.includePath ?? "") + filename;
    if (retry.length >= MAX_SOURCE_PATH) {
      throw new RangeError("PC_Directive_include quoted retry exceeds its 64-byte source path");
    }
    return this.readFile(retry);
  }

  private requireLive(): void {
    if (this.terminal) throw new Error("Bot script source resources have been disposed");
  }

  private boundedPath(text: string): string {
    if (text.length >= 32000) {
      throw new RangeError("Com_sprintf formatted bot path exceeds its 32000-byte source buffer");
    }
    if (text.length >= MAX_SOURCE_PATH) {
      this.commonPrint(`Com_sprintf: overflow of ${text.length} in ${MAX_SOURCE_PATH}\n`);
      this.requireLive();
    }
    return text.slice(0, MAX_SOURCE_PATH - 1);
  }
}
