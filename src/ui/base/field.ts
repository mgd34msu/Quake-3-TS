// Base UI menu fields from id Software q3_ui/ui_mfield.c. GPL-2.0-or-later.
import { CommonError } from "../../core/common-error.ts";
import type { FieldControls } from "../../core/edit-field.ts";
import { KEY_CHAR_FLAG, KeyCode } from "../../core/key-codes.ts";
import { sourceCommandText } from "../../core/text.ts";
import { UI_BLINK, UI_CENTER, UI_GIANTFONT, UI_PULSE, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import type { Vec4 } from "../../core/math.ts";
import { COLORS, MenuFlag, NO_SOUND, menuParent, menuSound, nativeInt } from "./state.ts";
import type { BaseUiState, MenuFieldItem, MenuSound } from "./state.ts";
import { drawChar, drawString, fillRect } from "./draw.ts";
function bufferIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 256)
    throw new RangeError("Undefined native menu field buffer index");
}
export class MenuField {
  cursor = 0;
  scroll = 0;
  widthInChars = 0;
  maxchars = 0;
  private readonly bytes = new Uint8Array(256);
  private pasteDepth = 0;
  private pasteWork = 0;
  get text(): string {
    let result = "";
    for (const byte of this.bytes) {
      if (byte === 0)
        return result;
      result += String.fromCharCode(byte);
    }
    throw new RangeError("Undefined native unterminated menu field");
  }
  clear(): void { this.bytes[0] = 0; this.cursor = 0; this.scroll = 0; }
  reset(): void {
    this.bytes.fill(0); this.cursor = 0; this.scroll = 0; this.widthInChars = 0; this.maxchars = 0;
  }
  setText(value: string): void {
    const text = sourceCommandText(value);
    if (text.length >= 256)
      throw new RangeError("Menu field exceeds source buffer");
    for (let index = 0; index < text.length; index++)
      this.bytes[index] = text.charCodeAt(index);
    this.bytes[text.length] = 0;
  }
  copyBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > this.bytes.length)
      throw new RangeError("Menu field copy exceeds source buffer");
    return this.bytes.slice(0, length);
  }
  setBytes(bytes: Uint8Array): void {
    if (bytes.length > this.bytes.length) throw new RangeError("Menu field write exceeds source buffer");
    this.bytes.set(bytes);
  }
  private move(destination: number, start: number, end: number): void {
    bufferIndex(destination);
    bufferIndex(start);
    if (!Number.isInteger(end) || end < start || end > 256 || destination + end - start > 256)
      throw new RangeError("Undefined native menu field memmove");
    this.bytes.copyWithin(destination, start, end);
  }
  private paste(controls: FieldControls): void {
    if (controls.clipboard.kind === "native-unix-unavailable")
      return;
    if (this.pasteDepth >= 32)
      throw new RangeError("Recursive menu field paste exceeded 32 clipboard reads");
    const bytes = controls.clipboard.read();
    if (bytes === null)
      return;
    if (this.pasteDepth === 0)
      this.pasteWork = 0;
    this.pasteDepth++;
    try {
      for (const byte of bytes.subarray(0, 63)) {
        if (byte === 0)
          break;
        if (++this.pasteWork > 65536)
          throw new RangeError("Menu field paste exceeded 65536 byte operations");
        this.charEvent(byte < 128 ? byte : byte - 256, controls);
      }
    }
    finally {
      this.pasteDepth--;
    }
  }
  keyDown(key: number, controls: FieldControls): void {
    if ((key === KeyCode.Insert || key === KeyCode.KeypadInsert) && controls.isDown(KeyCode.Shift)) {
      this.paste(controls);
      return;
    }
    const length = this.text.length;
    if (key === KeyCode.Delete || key === KeyCode.KeypadDelete) {
      if (this.cursor < length)
        this.move(this.cursor, this.cursor + 1, length + 1);
      return;
    }
    if (key === KeyCode.Right || key === KeyCode.KeypadRight) {
      if (this.cursor < length)
        this.cursor++;
      if (this.cursor >= this.scroll + this.widthInChars && this.cursor <= length)
        this.scroll++;
      return;
    }
    if (key === KeyCode.Left || key === KeyCode.KeypadLeft) {
      if (this.cursor > 0)
        this.cursor--;
      if (this.cursor < this.scroll)
        this.scroll--;
      return;
    }
    if (key === KeyCode.Home || key === KeyCode.KeypadHome || ((key === 65 || key === 97) && controls.isDown(KeyCode.Control))) {
      this.cursor = 0;
      this.scroll = 0;
      return;
    }
    if (key === KeyCode.End || key === KeyCode.KeypadEnd || ((key === 69 || key === 101) && controls.isDown(KeyCode.Control))) {
      this.cursor = length;
      this.scroll = Math.max(0, length - this.widthInChars + 1);
      return;
    }
    if (key === KeyCode.Insert || key === KeyCode.KeypadInsert)
      controls.setOverstrike(!controls.getOverstrike());
  }
  charEvent(character: number, controls: FieldControls): void {
    if (character === 22) {
      this.paste(controls);
      return;
    }
    if (character === 3) {
      this.clear();
      return;
    }
    const length = this.text.length;
    if (character === 8) {
      if (this.cursor > 0) {
        this.move(this.cursor - 1, this.cursor, length + 1);
        this.cursor--;
        if (this.cursor < this.scroll)
          this.scroll--;
      }
      return;
    }
    if (character === 1) {
      this.cursor = 0;
      this.scroll = 0;
      return;
    }
    if (character === 5) {
      this.cursor = length;
      this.scroll = Math.max(0, this.cursor - this.widthInChars + 1);
      return;
    }
    if (character < 32)
      return;
    if (!controls.getOverstrike()) {
      if (this.cursor === 255 || (this.maxchars !== 0 && this.cursor >= this.maxchars))
        return;
    }
    else {
      if (length === 255 || (this.maxchars !== 0 && length >= this.maxchars))
        return;
      this.move(this.cursor + 1, this.cursor, length + 1);
    }
    bufferIndex(this.cursor);
    this.bytes[this.cursor] = nativeInt(character) & 255;
    if (this.maxchars === 0 || this.cursor < this.maxchars - 1)
      this.cursor++;
    if (this.cursor >= this.widthInChars)
      this.scroll++;
    if (this.cursor === length + 1) {
      bufferIndex(this.cursor);
      this.bytes[this.cursor] = 0;
    }
  }
  draw(state: BaseUiState, x: number, y: number, style: number, color: Vec4): void {
    state.assertActive();
    let drawLength = this.widthInChars;
    const length = this.text.length + 1;
    let prestep = 0;
    if (length > drawLength) {
      if (this.scroll + drawLength > length)
        this.scroll = Math.max(0, length - drawLength);
      prestep = this.scroll;
    }
    if (prestep + drawLength > length)
      drawLength = length - prestep;
    if (drawLength >= 1024)
      throw new CommonError("drop", "drawLen >= MAX_STRING_CHARS");
    if (!Number.isInteger(prestep) || !Number.isInteger(drawLength) || prestep < 0 || drawLength < 0 || prestep + drawLength > 256)
      throw new RangeError("Undefined native menu field draw copy");
    let text = "";
    for (const byte of this.bytes.subarray(prestep, prestep + drawLength)) {
      if (byte === 0)
        break;
      text += String.fromCharCode(byte);
    }
    drawString(state, x, y, text, style, color);
    if ((style & UI_PULSE) === 0)
      return;
    const character = state.services.keys.getOverstrike() ? 11 : 10;
    style = (style & ~UI_PULSE) | UI_BLINK;
    const width = (style & UI_SMALLFONT) !== 0 ? 8 : (style & UI_GIANTFONT) !== 0 ? 32 : 16;
    if ((style & UI_CENTER) !== 0)
      x -= nativeInt(text.length * width / 2);
    else if ((style & UI_RIGHT) !== 0)
      x -= text.length * width;
    drawChar(state, x + (this.cursor - prestep) * width, y, character, style & ~(UI_CENTER | UI_RIGHT), color);
  }
}
export function initializeField(item: MenuFieldItem): void {
  item.field.clear();
  const common = item.common, small = (common.flags & MenuFlag.SmallFont) !== 0, width = small ? 8 : 16, height = 16;
  const length = common.name === null ? 0 : (sourceCommandText(common.name).length + 1) * width;
  common.left = common.x - length;
  common.top = common.y;
  common.right = common.x + width + item.field.widthInChars * width;
  common.bottom = common.y + height;
}
export function drawField(state: BaseUiState, item: MenuFieldItem): void {
  state.assertActive();
  const common = item.common, small = (common.flags & MenuFlag.SmallFont) !== 0, width = small ? 8 : 16;
  let style = small ? UI_SMALLFONT : 0;
  const parent = menuParent(item), focused = parent.cursor >= 0 && parent.cursor < parent.itemCount && parent.items[parent.cursor] === item;
  if (focused)
    style |= UI_PULSE;
  const color = (common.flags & MenuFlag.Grayed) !== 0 ? COLORS.disabled : focused ? COLORS.highlight : COLORS.normal;
  if (focused) {
    fillRect(state, common.left, common.top, common.right - common.left + 1, common.bottom - common.top + 1, COLORS.listbar);
    drawChar(state, common.x, common.y, 13, UI_CENTER | UI_BLINK | style, color);
  }
  if (common.name !== null)
    drawString(state, common.x - width, common.y, common.name, style | UI_RIGHT, color);
  item.field.draw(state, common.x + width, common.y, style, color);
}
export function fieldKey(state: BaseUiState, item: MenuFieldItem, key: number): {
  readonly key: number;
  readonly sound: MenuSound;
} {
  state.assertActive();
  const controls: FieldControls = { isDown: key => state.services.keys.isDown(key), getOverstrike: () => state.services.keys.getOverstrike(),
    setOverstrike: value => state.services.keys.setOverstrike(value), clipboard: state.services.clipboard };
  if (key === KeyCode.Enter || key === KeyCode.KeypadEnter || (key >= KeyCode.Joy1 && key <= KeyCode.Joy4))
    return { key: KeyCode.Tab, sound: NO_SOUND };
  if (key === KeyCode.Tab || key === KeyCode.Down || key === KeyCode.Up || key === KeyCode.KeypadDown || key === KeyCode.KeypadUp)
    return { key, sound: NO_SOUND };
  if ((key & KEY_CHAR_FLAG) !== 0) {
    let character = key & ~KEY_CHAR_FLAG;
    if ((item.common.flags & MenuFlag.Uppercase) !== 0 && character >= 97 && character <= 122)
      character -= 32;
    else if ((item.common.flags & MenuFlag.Lowercase) !== 0 && character >= 65 && character <= 90)
      character += 32;
    else if ((item.common.flags & MenuFlag.NumbersOnly) !== 0 && ((character >= 65 && character <= 90) || (character >= 97 && character <= 122)))
      return { key, sound: menuSound(state.media.buzz) };
    item.field.charEvent(character, controls);
  }
  else
    item.field.keyDown(key, controls);
  return { key, sound: NO_SOUND };
}
