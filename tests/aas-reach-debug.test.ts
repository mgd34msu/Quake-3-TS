import { expect, test } from "bun:test";
import { AasReachabilityDebugState } from "../src/botlib/aas-reachability.ts";

test("reach DEBUG owners start independently and keep counts while output is disabled", () => {
  const profile = { debug: false, reachDebug: false };
  const state = new AasReachabilityDebugState(profile), messages: string[] = [];
  const print = (_severity: number, text: string): undefined => { messages.push(text); };
  state.count("swim"); state.count("swim"); state.printCounts(print);
  expect(messages).toEqual([]);
  profile.debug = true; state.printCounts(print);
  expect(messages[0]).toBe("     2 reach swim\n");
  expect(messages).toHaveLength(15);
  messages.length = 0;
  new AasReachabilityDebugState(profile).printCounts(print);
  expect(messages[0]).toBe("     0 reach swim\n");
});
