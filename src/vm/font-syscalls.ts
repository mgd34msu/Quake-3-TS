/*
 * Font traps and fontInfo_t from id Software's cl_ui.c, cl_cgame.c,
 * renderer/tr_font.c and game/q_shared.h. GPL-2.0-or-later.
 */
import type { RendererFontRegistry } from "../render/font-registry.ts";
import type { QvmMemory } from "./memory.ts";

export const QVM_FONT_INFO_BYTES = 20548;

export interface QvmFontServices {
  readonly fonts: RendererFontRegistry;
  print(text: string): undefined;
  /** Advances the actual renderer's entity, polygon and light scene boundaries. */
  clearScene(): undefined;
}

/** The selected renderer profile loads DAT fonts without FreeType. */
export function qvmFontSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, services: QvmFontServices,
): number | Promise<number> | null {
  if (role === "game") return null;
  if (words.getInt32(0, true) !== (role === "ui" ? 55 : 59)) return null;
  // fontName is unused in this source profile, even when its pointer is null.
  words.getInt32(4, true);
  const pointSize = words.getInt32(8, true), destination = words.getInt32(12, true);
  return services.fonts.registerFont("", pointSize, text => services.print(text),
    () => memory.span(destination, QVM_FONT_INFO_BYTES)).then(() => {
    // CG_R_REGISTERFONT falls through to CG_R_CLEARSCENE in cl_cgame.c.
    if (role === "cgame") services.clearScene();
    return 0;
  });
}
