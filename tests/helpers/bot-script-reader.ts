import type { BotScriptReader } from "../../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../../src/script/preprocessor.ts";
import type { IncludeRequest, ScriptSource } from "../../src/script/preprocessor.ts";

export class MemoryBotScriptReader implements BotScriptReader {
  readonly globals = new ScriptGlobalDefines();
  readonly reads: string[] = [];
  beforeRead: (path: string) => void = () => {};

  constructor(readonly files: Map<string, string>) {}

  resolveRoot(path: string): ScriptSource | undefined {
    if (!this.files.has(path)) return undefined;
    this.reads.push(path);
    this.beforeRead(path);
    const text = this.files.get(path);
    return text === undefined ? undefined : { path, text };
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    return this.resolveRoot(request.requestedPath);
  }
}
