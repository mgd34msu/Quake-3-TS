import { expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { LanAddresses } from "../src/platform/lan.ts";
import type { Ipv4Host } from "../src/platform/network.ts";

test("source LAN classification uses local classful networks, not a private-address shortcut", () => {
  const lan = new LanAddresses([[8, 2, 3, 4], [172, 17, 0, 1], [150, 151, 3, 4], [192, 168, 7, 1], [203, 0, 113, 5]]);
  const cases: readonly (readonly [Ipv4Host, boolean])[] = [
    [[8, 250, 250, 250], true], [[10, 2, 3, 4], false], [[127, 0, 0, 1], false],
    [[172, 16, 99, 1], true], [[172, 31, 255, 1], true], [[172, 15, 0, 1], false], [[172, 32, 0, 1], false],
    [[150, 151, 255, 255], true], [[150, 152, 3, 4], false],
    [[192, 168, 99, 1], true], [[192, 167, 7, 1], false],
    [[203, 0, 113, 250], true], [[203, 0, 114, 5], false],
  ];
  for (const [host, expected] of cases) expect(lan.isLanAddress({ kind: "ipv4", host })).toBe(expected);
  expect(lan.isLanAddress({ kind: "loopback" })).toBe(true);
  expect(lan.isLanAddress({ kind: "bot" })).toBe(false);
  expect(new LanAddresses([]).isLanAddress({ kind: "ipv4", host: [192, 168, 1, 1] })).toBe(false);
});

test("source final comparison also applies to class-D addresses and local storage is owned", () => {
  const local: [number, number, number, number] = [224, 1, 2, 3];
  const lan = new LanAddresses([local]); local[2] = 9;
  expect(lan.isLanAddress({ kind: "ipv4", host: [224, 1, 2, 99] })).toBe(true);
  expect(lan.isLanAddress({ kind: "ipv4", host: [224, 1, 9, 99] })).toBe(false);
  expect(() => new LanAddresses([[256, 0, 0, 0]])).toThrow("octets");
});

test("Sys_ShowIP prints each retained address in order, including duplicates and boundary octets", () => {
  const lan = new LanAddresses([[203, 0, 113, 5], [0, 0, 0, 0], [255, 255, 255, 255], [127, 0, 0, 1], [203, 0, 113, 5]]);
  const output: string[] = [];
  lan.showIp(text => { output.push(text); });
  expect(output).toEqual(["IP: 203.0.113.5\n", "IP: 0.0.0.0\n", "IP: 255.255.255.255\n", "IP: 127.0.0.1\n", "IP: 203.0.113.5\n"]);
});

test("Sys_ShowIP keeps the network initialization snapshot across repeated commands", () => {
  const first: [number, number, number, number] = [192, 168, 7, 1];
  const second: [number, number, number, number] = [172, 17, 0, 1];
  const hosts: Ipv4Host[] = [first, second];
  const lan = new LanAddresses(hosts);
  const output: string[] = [];
  lan.showIp(text => {
    output.push(text);
    first[3] = 9;
    second[3] = 9;
    hosts.length = 0;
  });
  lan.showIp(text => { output.push(text); });
  expect(output).toEqual(["IP: 192.168.7.1\n", "IP: 172.17.0.1\n", "IP: 192.168.7.1\n", "IP: 172.17.0.1\n"]);
});

test("Sys_ShowIP emits no output when the retained network list is empty", () => {
  const output: string[] = [];
  new LanAddresses([]).showIp(text => { output.push(text); });
  expect(output).toEqual([]);
});

test("platform initialization discovers actual IPv4 interface addresses", () => {
  const lan = LanAddresses.current();
  for (const interfaces of Object.values(networkInterfaces())) {
    if (interfaces === undefined) continue;
    for (const address of interfaces) {
      if (address.family !== "IPv4") continue;
      const [a, b, c, d] = address.address.split(".").map(Number);
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("Malformed fixture local address");
      expect(lan.isLanAddress({ kind: "ipv4", host: [a, b, c, d] })).toBe(true);
    }
  }
});
