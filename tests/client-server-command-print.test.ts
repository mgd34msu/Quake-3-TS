import { expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientActiveState, getClientServerCommand } from "../src/engine/client-active.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";

function fixture(print: (text: string) => void) {
  const active = new ClientActiveState(print), connection = new ClientConnectionState();
  const state = new ClientStaticState(), commands = new CommandBuffer(), cvars = new CvarRegistry();
  const read = (sequence: number) => getClientServerCommand(sequence, active, connection, state, {
    cvars, consoleCommands: commands, assertCurrentOperation: () => undefined,
    applyServerPackages: async () => { throw new Error("Unexpected package change"); },
    emitEvent: () => { throw new Error("Unexpected command event"); },
    fail: (kind, text) => { throw new CommonError(kind, text); },
  });
  return { active, connection, state, commands, read };
}

test("server command diagnostics observe the executed number before tokenization and preserve output reentry", async () => {
  const prints: string[] = [];
  const f = fixture(text => {
    prints.push(text);
    expect(f.connection.lastExecutedServerCommand).toBe(1);
    expect(f.commands.tokenizedArguments).toEqual(["previous", "arguments"]);
    f.commands.tokenize("nested output command");
    f.connection.serverCommands[1] = 'print "changed during output"';
  });
  f.commands.tokenize("previous arguments");
  f.connection.serverCommandSequence = 1;
  f.connection.serverCommands[1] = 'print "original text"';
  expect(await f.read(1)).toEqual(["print", "changed during output"]);
  expect(f.commands.tokenizedArguments).toEqual(["print", "changed during output"]);
  expect(prints).toEqual(['serverCommand: 1 : print "original text"\n']);
});

test("output failure leaves the executed number updated and previous tokens untouched", async () => {
  const failure = new Error("output failed"), f = fixture(() => { throw failure; });
  f.commands.tokenize("previous"); f.connection.serverCommandSequence = 1;
  f.connection.serverCommands[1] = 'print "next"';
  await expect(f.read(1)).rejects.toBe(failure);
  expect(f.connection.lastExecutedServerCommand).toBe(1);
  expect(f.commands.tokenizedArguments).toEqual(["previous"]);
});

test("rejected and expired demo commands do not print; assembled commands print only the incoming fragments", async () => {
  const prints: string[] = [], f = fixture(text => { prints.push(text); });
  await expect(f.read(1)).rejects.toThrow("requested a command not received");
  f.connection.serverCommandSequence = 64; f.connection.demoPlaying = true;
  expect(await f.read(0)).toBeNull(); expect(prints).toEqual([]);
  f.connection.serverCommands[62] = 'bcs0 2 "first"';
  f.connection.serverCommands[63] = 'bcs1 2 " middle"';
  f.connection.serverCommands[0] = 'bcs2 2 " last"';
  expect(await f.read(62)).toBeNull(); expect(await f.read(63)).toBeNull();
  expect(await f.read(64)).toEqual(["cs", "2", "first middle last"]);
  expect(prints).toEqual(['serverCommand: 62 : bcs0 2 "first"\n',
    'serverCommand: 63 : bcs1 2 " middle"\n', 'serverCommand: 64 : bcs2 2 " last"\n']);
});
