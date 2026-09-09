import { expect, test } from "bun:test";
import { ClientReliableCommands } from "../src/protocol/reliable.ts";

test("CL_ChangeReliableCommand changes the current source slot without advancing or acknowledging it", () => {
  const reliable = new ClientReliableCommands();
  reliable.changeLatest();
  expect(reliable.lookupMasked(0)).toBe("\n");
  expect(reliable.sequence).toBe(0);
  reliable.add("first");
  reliable.add("second");
  reliable.acknowledgeThrough(1);
  reliable.changeLatest();
  reliable.changeLatest();
  expect(reliable.lookupMasked(1)).toBe("first");
  expect(reliable.pending()).toEqual([{ sequence: 2, text: "second\n\n" }]);
  expect(reliable.sequence).toBe(2);
  expect(reliable.acknowledge).toBe(1);
});

test("CL_ChangeReliableCommand replaces the last byte of a full source string and follows ring wrap", () => {
  const reliable = new ClientReliableCommands();
  for (let index = 1; index <= 64; index++) {
    reliable.add(index === 64 ? "x".repeat(1023) : String(index));
    reliable.acknowledgeThrough(index);
  }
  reliable.changeLatest();
  expect(reliable.lookupMasked(0)).toBe("x".repeat(1022) + "\n");
  expect(reliable.sequence).toBe(64);
  expect(reliable.acknowledge).toBe(64);
  reliable.changeLatest();
  expect(reliable.lookupMasked(64)).toBe("x".repeat(1022) + "\n");
});
