// System ABI facts used by the unix_main.c console replacement.
// glibc sysdeps/unix/sysv/linux/bits/{sigaction,termios-struct,termios-c_cc}.h:
// https://github.com/bminor/glibc/tree/master/sysdeps/unix/sysv/linux/bits
// Darwin LP64 sys/{signal,termios,_types}.h:
// https://github.com/apple-oss-distributions/xnu/tree/main/bsd/sys
export type ConsolePlatform = "linux" | "darwin" | "win32";

export function consolePlatform(platform: string, architecture: string): ConsolePlatform {
  if ((platform === "linux" || platform === "darwin") && (architecture === "x64" || architecture === "arm64")) return platform;
  if (platform === "win32" && architecture === "x64") return platform;
  throw new Error(`Unsupported console platform ${platform}-${architecture}`);
}

export function signalActionSize(platform: "linux" | "darwin"): number {
  // Both targets use an eight-byte handler pointer. glibc follows it with a
  // 128-byte mask, int flags, padding and restorer; Darwin has u32 mask/int flags.
  return platform === "linux" ? 152 : 16;
}

export function termiosSize(platform: "linux" | "darwin"): number {
  // glibc: four u32 flags, line byte, 32 cc bytes, padding, two u32 speeds.
  // Darwin: four ulong flags, 20 cc bytes, padding, two ulong speeds.
  return platform === "linux" ? 60 : 72;
}

export function consoleTermios(saved: Uint8Array, platform: "linux" | "darwin"): { readonly bytes: Uint8Array; readonly erase: number } {
  if (saved.byteLength !== termiosSize(platform)) throw new RangeError("Unexpected terminal ABI record length");
  const bytes = new Uint8Array(saved), settings = new DataView(bytes.buffer);
  if (platform === "linux") {
    settings.setUint32(12, settings.getUint32(12, true) & ~0x0a, true);
    settings.setUint32(0, settings.getUint32(0, true) & ~0x30, true);
    settings.setUint8(23, 1); settings.setUint8(22, 0);
    return { bytes, erase: settings.getUint8(19) };
  }
  // ECHO=8, ICANON=0x100, ISTRIP=0x20, INPCK=0x10. Keep all 64 flag bits.
  settings.setBigUint64(24, settings.getBigUint64(24, true) & ~0x108n, true);
  settings.setBigUint64(0, settings.getBigUint64(0, true) & ~0x30n, true);
  settings.setUint8(48, 1); settings.setUint8(49, 0);
  return { bytes, erase: settings.getUint8(35) };
}
