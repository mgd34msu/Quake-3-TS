import { BinaryWriter } from "../src/core/binary.ts";

export interface FixtureSurface { readonly shader: string; readonly lightmap: number }

/** Two authored quads in separate visible areas, with independently colored lightmaps. */
export function renderBspFixture(surfaces: readonly [FixtureSurface, FixtureSurface], lightmapColors: readonly (readonly [number, number, number])[]): Uint8Array {
  const lumps: Uint8Array[] = Array.from({ length: 17 }, () => new Uint8Array(0));
  function lump(index: number, write: (writer: BinaryWriter) => void): void {
    const writer = new BinaryWriter(1024 + lightmapColors.length * 128 * 128 * 3); write(writer); lumps[index] = writer.finish();
  }
  const names = [...new Set(surfaces.map(surface => surface.shader))];
  lumps[0] = new TextEncoder().encode('{ "classname" "worldspawn" }\n{ "classname" "info_player_start" "origin" "0 0 -26" }\n\0');
  lump(1, writer => { for (const name of names) { const bytes = new TextEncoder().encode(name); writer.bytes(bytes); writer.bytes(new Uint8Array(64 - bytes.length)); writer.i32(0); writer.i32(1); } });
  lump(2, writer => { for (const value of [1, 0, 0, 48]) writer.f32(value); });
  lump(3, writer => { for (const value of [0, -2, -1, 0, -64, -64, 96, 64, 64]) writer.i32(value); });
  lump(4, writer => { for (let area = 0; area < 2; area++) for (const value of [area, area, area * 48, -64, -64, (area + 1) * 48, 64, 64, area, 1, 0, 0]) writer.i32(value); });
  lump(5, writer => { writer.i32(0); writer.i32(1); });
  lump(7, writer => { for (const value of [0, -64, -64, 96, 64, 64]) writer.f32(value); for (const value of [0, 2, 0, 0]) writer.i32(value); });
  lump(10, writer => {
    for (let surface = 0; surface < 2; surface++) for (const [dy, dz] of [[-4, -4], [4, -4], [4, 4], [-4, 4]] satisfies readonly (readonly [number, number])[]) {
      for (const value of [surface === 0 ? 32 : 64, (surface === 0 ? -12 : 24) + dy, dz, (dy + 4) / 8, (dz + 4) / 8, 0.5, 0.5, -1, 0, 0]) writer.f32(value);
      for (const value of [32, 48, 64, 255]) writer.u8(value);
    }
  });
  lump(11, writer => { for (let surface = 0; surface < 2; surface++) for (const value of [0, 1, 2, 0, 2, 3]) writer.i32(value); });
  lump(13, writer => {
    for (const [index, surface] of surfaces.entries()) {
      for (const value of [names.indexOf(surface.shader), -1, 1, index * 4, 4, index * 6, 6, surface.lightmap, 0, 0, 128, 128]) writer.i32(value);
      for (const value of [0, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0]) writer.f32(value);
      writer.i32(0); writer.i32(0);
    }
  });
  lump(14, writer => { for (const color of lightmapColors) for (let index = 0; index < 128 * 128; index++) for (const channel of color) writer.u8(channel); });
  lump(16, writer => { writer.i32(2); writer.i32(1); writer.u8(3); writer.u8(3); });
  const output = new BinaryWriter(144 + lumps.reduce((sum, bytes) => sum + bytes.length, 0)); output.bytes(new TextEncoder().encode("IBSP")); output.i32(46);
  let offset = 144;
  for (const bytes of lumps) { output.i32(offset); output.i32(bytes.length); offset += bytes.length; }
  for (const bytes of lumps) output.bytes(bytes);
  return output.finish();
}

export function solidTga(red: number, green: number, blue: number): Uint8Array {
  const bytes = new Uint8Array(21); bytes[2] = 2; bytes[12] = 1; bytes[14] = 1; bytes[16] = 24; bytes[17] = 0x20;
  bytes.set([blue, green, red], 18); return bytes;
}
