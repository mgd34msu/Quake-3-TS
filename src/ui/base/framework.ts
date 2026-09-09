// Base menu widgets and stack from id Software q3_ui/ui_qmenu.c/ui_atoms.c. GPL-2.0-or-later.
import { CommonError } from "../../core/common-error.ts";
import { KeyCatcher, KeyCode } from "../../core/key-codes.ts";
import { sourceCommandText } from "../../core/text.ts";
import { UI_BLINK, UI_CENTER, UI_INVERSE, UI_PULSE, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import { COLORS, MenuEvent, MenuFlag, NO_SOUND, itemAt, menuParent, menuSound, nativeInt } from "./state.ts";
import type { BaseMenu, BaseMenuItem, BaseUiState, MenuBitmap, MenuScroll, MenuSlider, MenuSound, MenuSpin } from "./state.ts";
import { cursorInRect, drawBanner, drawChar, drawHandle, drawProportional, drawString, drawRect, fillRect, proportionalScale, stringWidth } from "./draw.ts";
import { drawField, fieldKey, initializeField } from "./field.ts";
const f = Math.fround;
const unavailable = MenuFlag.Grayed | MenuFlag.Inactive;
const skipFocus = unavailable | MenuFlag.MouseOnly;
const textLength = (value: string | null) => value === null ? 0 : sourceCommandText(value).length;
function active(state: BaseUiState): BaseMenu {
  if (state.activeMenu === null)
    throw new Error("Undefined native active menu dereference");
  return state.activeMenu;
}
async function callback(state: BaseUiState, item: BaseMenuItem, event: MenuEvent): Promise<void> {
  const handler = item.common.callback;
  if (handler !== null) {
    await handler(item, event);
    state.assertActive();
  }
}
export function menuItemAtCursor(menu: BaseMenu): BaseMenuItem | null { return menu.cursor < 0 || menu.cursor >= menu.itemCount ? null : itemAt(menu.items, menu.cursor); }
export function addItem(state: BaseUiState, menu: BaseMenu, item: BaseMenuItem): void {
  state.assertActive();
  if (menu.itemCount >= 64)
    throw new CommonError("drop", "Menu_AddItem: excessive items");
  menu.items[menu.itemCount] = item;
  const c = item.common;
  c.parent = menu;
  c.menuPosition = menu.itemCount;
  c.flags &= ~MenuFlag.HasMouseFocus;
  if ((c.flags & MenuFlag.NoDefaultInit) === 0) {
    switch (item.kind) {
      case "text":
      case "banner":
        c.flags |= MenuFlag.Inactive;
        break;
      case "field":
        initializeField(item);
        break;
      case "action":
        c.left = c.x;
        c.right = c.x + textLength(c.name) * 16;
        c.top = c.y;
        c.bottom = c.y + 16;
        break;
      case "radio":
        c.left = c.x - (textLength(c.name) + 1) * 8;
        c.right = c.x + 48;
        c.top = c.y;
        c.bottom = c.y + 16;
        break;
      case "slider":
        c.left = c.x - (textLength(c.name) + 1) * 8;
        c.right = c.x + 104;
        c.top = c.y;
        c.bottom = c.y + 16;
        break;
      case "proportional": {
        const scale = proportionalScale(item.style), width = nativeInt(f(stringWidth(item.text) * scale)), height = nativeInt(f(27 * scale));
        let x = c.x;
        if ((c.flags & MenuFlag.RightJustify) !== 0)
          x -= width;
        else if ((c.flags & MenuFlag.CenterJustify) !== 0)
          x -= nativeInt(width / 2);
        c.left = nativeInt(f(x - f(3 * scale)));
        c.right = nativeInt(f(x + width + f(3 * scale)));
        c.top = c.y;
        c.bottom = c.y + height;
        break;
      }
      case "bitmap": {
        const width = Math.abs(item.width), height = Math.abs(item.height);
        let x = c.x;
        if ((c.flags & MenuFlag.RightJustify) !== 0)
          x -= width;
        else if ((c.flags & MenuFlag.CenterJustify) !== 0)
          x -= nativeInt(width / 2);
        c.left = x;
        c.right = x + width;
        c.top = c.y;
        c.bottom = c.y + height;
        item.shader = null;
        item.focusshader = null;
        break;
      }
      case "spin": {
        c.left = c.x - 8 - textLength(c.name) * 8;
        let length = 0;
        item.numitems = 0;
        for (const name of item.itemnames) {
          length = Math.max(length, textLength(name));
          item.numitems++;
        }
        c.top = c.y;
        c.right = c.x + (length + 1) * 8;
        c.bottom = c.y + 16;
        break;
      }
      case "scroll": {
        item.oldvalue = 0;
        item.curvalue = 0;
        item.top = 0;
        if (item.columns === 0) {
          item.columns = 1;
          item.separation = 0;
        }
        else if (item.separation === 0)
          item.separation = 3;
        const width = ((item.width + item.separation) * item.columns - item.separation) * 8;
        c.left = c.x;
        c.top = c.y;
        c.right = c.x + width;
        c.bottom = c.y + item.height * 16;
        if ((c.flags & MenuFlag.CenterJustify) !== 0) {
          c.left -= nativeInt(width / 2);
          c.right -= nativeInt(width / 2);
        }
        break;
      }
      default: {
        const exhaustive: never = item;
        throw new Error(`Unknown menu item ${String(exhaustive)}`);
      }
    }
  }
  menu.itemCount++;
}
export async function cursorMoved(state: BaseUiState, menu: BaseMenu): Promise<void> {
  state.assertActive();
  if (menu.cursorPrev === menu.cursor)
    return;
  if (menu.cursorPrev >= 0 && menu.cursorPrev < menu.itemCount)
    await callback(state, itemAt(menu.items, menu.cursorPrev), MenuEvent.LostFocus);
  state.assertActive();
  if (menu.cursor >= 0 && menu.cursor < menu.itemCount)
    await callback(state, itemAt(menu.items, menu.cursor), MenuEvent.GotFocus);
  state.assertActive();
}
export async function setCursor(state: BaseUiState, menu: BaseMenu, cursor: number): Promise<void> {
  state.assertActive();
  if ((itemAt(menu.items, cursor).common.flags & unavailable) !== 0)
    return;
  menu.cursorPrev = menu.cursor;
  menu.cursor = cursor;
  await cursorMoved(state, menu);
  state.assertActive();
}
export async function setCursorToItem(state: BaseUiState, menu: BaseMenu, item: BaseMenuItem): Promise<void> {
  state.assertActive();
  for (let i = 0; i < menu.itemCount; i++)
    if (itemAt(menu.items, i) === item) {
      await setCursor(state, menu, i);
      state.assertActive();
      return;
    }
}
export function adjustCursor(state: BaseUiState, menu: BaseMenu, direction: 1 | -1): void {
  state.assertActive();
  let wrapped = false;
  while (true) {
    while (menu.cursor >= 0 && menu.cursor < menu.itemCount) {
      if ((itemAt(menu.items, menu.cursor).common.flags & skipFocus) !== 0)
        menu.cursor += direction;
      else
        break;
    }
    if (direction === 1 ? menu.cursor >= menu.itemCount : menu.cursor < 0) {
      if (menu.wrapAround && !wrapped) {
        menu.cursor = direction === 1 ? 0 : menu.itemCount - 1;
        wrapped = true;
        continue;
      }
      menu.cursor = menu.cursorPrev;
    }
    return;
  }
}
export async function pushMenu(state: BaseUiState, menu: BaseMenu): Promise<void> {
  state.assertActive();
  let index = 0;
  for (; index < state.menuDepth; index++)
    if (itemAt(state.stack, index) === menu) {
      state.menuDepth = index;
      break;
    }
  if (index === state.menuDepth) {
    if (state.menuDepth >= 8)
      throw new CommonError("drop", "UI_PushMenu: menu stack overflow");
    state.stack[state.menuDepth++] = menu;
  }
  state.activeMenu = menu;
  menu.cursor = 0;
  menu.cursorPrev = 0;
  state.enterSound = true;
  state.services.keys.setCatcher(KeyCatcher.Ui);
  for (let i = 0; i < menu.itemCount; i++)
    if ((itemAt(menu.items, i).common.flags & skipFocus) === 0) {
      menu.cursorPrev = -1;
      await setCursor(state, menu, i);
      state.assertActive();
      break;
    }
  state.firstDraw = true;
}
export async function forceMenuOff(state: BaseUiState): Promise<void> {
  state.assertActive();
  state.menuDepth = 0;
  state.activeMenu = null;
  state.services.keys.setCatcher(state.services.keys.getCatcher() & ~KeyCatcher.Ui);
  await state.services.keys.clearStates();
  state.assertActive();
  state.services.cvars.registry.set("cl_paused", "0", true);
}
export async function popMenu(state: BaseUiState): Promise<void> {
  state.assertActive();
  state.play(state.media.out);
  state.menuDepth--;
  if (state.menuDepth < 0)
    throw new CommonError("drop", "UI_PopMenu: menu stack underflow");
  if (state.menuDepth !== 0) {
    state.activeMenu = itemAt(state.stack, state.menuDepth - 1);
    state.firstDraw = true;
  }
  else {
    await forceMenuOff(state);
    state.assertActive();
  }
}
export function isFullscreen(state: BaseUiState): boolean {
  state.assertActive();
  return state.activeMenu !== null && (state.services.keys.getCatcher() & KeyCatcher.Ui) !== 0 ? state.activeMenu.fullscreen : false;
}
export async function mouseEvent(state: BaseUiState, dx: number, dy: number): Promise<void> {
  state.assertActive();
  if (state.activeMenu === null)
    return;
  state.cursorX = Math.min(640, Math.max(0, (state.cursorX + nativeInt(dx)) | 0));
  state.cursorY = Math.min(480, Math.max(0, (state.cursorY + nativeInt(dy)) | 0));
  for (let i = 0; i < active(state).itemCount; i++) {
    const c = itemAt(active(state).items, i).common;
    if ((c.flags & unavailable) !== 0 || state.cursorX < c.left || state.cursorX > c.right || state.cursorY < c.top || state.cursorY > c.bottom)
      continue;
    if (active(state).cursor !== i) {
      await setCursor(state, active(state), i);
      state.assertActive();
      itemAt(active(state).items, active(state).cursorPrev).common.flags &= ~MenuFlag.HasMouseFocus;
      if ((itemAt(active(state).items, active(state).cursor).common.flags & MenuFlag.Silent) === 0)
        state.play(state.media.move);
    }
    itemAt(active(state).items, active(state).cursor).common.flags |= MenuFlag.HasMouseFocus;
    return;
  }
  if (active(state).itemCount > 0)
    itemAt(active(state).items, active(state).cursor).common.flags &= ~MenuFlag.HasMouseFocus;
}
async function sliderKey(state: BaseUiState, item: MenuSlider, key: number): Promise<MenuSound> {
  let sound = NO_SOUND;
  if (key === KeyCode.Mouse1) {
    const x = state.cursorX - item.common.x - 16, old = nativeInt(item.curvalue);
    item.curvalue = f(f(f(x / 80) * f(item.maxvalue - item.minvalue)) + item.minvalue);
    if (item.curvalue < item.minvalue)
      item.curvalue = item.minvalue;
    else if (item.curvalue > item.maxvalue)
      item.curvalue = item.maxvalue;
    if (item.curvalue !== old)
      sound = menuSound(state.media.move);
  }
  else if (key === KeyCode.Left || key === KeyCode.KeypadLeft) {
    if (item.curvalue > item.minvalue) {
      item.curvalue = f(item.curvalue - 1);
      sound = menuSound(state.media.move);
    }
    else
      sound = menuSound(state.media.buzz);
  }
  else if (key === KeyCode.Right || key === KeyCode.KeypadRight) {
    if (item.curvalue < item.maxvalue) {
      item.curvalue = f(item.curvalue + 1);
      sound = menuSound(state.media.move);
    }
    else
      sound = menuSound(state.media.buzz);
  }
  if (sound.kind !== "none")
    await callback(state, item, MenuEvent.Activated);
  state.assertActive();
  return sound;
}
async function spinKey(state: BaseUiState, item: MenuSpin, key: number): Promise<MenuSound> {
  let sound = NO_SOUND;
  if (key === KeyCode.Mouse1) {
    item.curvalue++;
    if (item.curvalue >= item.numitems)
      item.curvalue = 0;
    sound = menuSound(state.media.move);
  }
  else if (key === KeyCode.Left || key === KeyCode.KeypadLeft) {
    if (item.curvalue > 0) {
      item.curvalue--;
      sound = menuSound(state.media.move);
    }
    else
      sound = menuSound(state.media.buzz);
  }
  else if (key === KeyCode.Right || key === KeyCode.KeypadRight) {
    if (item.curvalue < item.numitems - 1) {
      item.curvalue++;
      sound = menuSound(state.media.move);
    }
    else
      sound = menuSound(state.media.buzz);
  }
  if (sound.kind !== "none")
    await callback(state, item, MenuEvent.Activated);
  state.assertActive();
  return sound;
}
export async function scrollKey(state: BaseUiState, item: MenuScroll, key: number): Promise<MenuSound> {
  state.assertActive();
  const c = item.common;
  const changed = async () => { await callback(state, item, MenuEvent.GotFocus); state.assertActive(); return menuSound(state.media.move); };
  if (key === KeyCode.Mouse1 && (c.flags & MenuFlag.HasMouseFocus) !== 0) {
    const width = ((item.width + item.separation) * item.columns - item.separation) * 8;
    const x = c.x - ((c.flags & MenuFlag.CenterJustify) !== 0 ? nativeInt(width / 2) : 0);
    if (cursorInRect(state, x, c.y, width, item.height * 16)) {
      const column = nativeInt(nativeInt((state.cursorX - x) / 8) / (item.width + item.separation)), row = nativeInt((state.cursorY - c.y) / 16), index = column * item.height + row;
      if (item.top + index < item.numitems) {
        item.oldvalue = item.curvalue;
        item.curvalue = item.top + index;
        if (item.oldvalue !== item.curvalue && c.callback !== null)
          return await changed();
      }
    }
    return state.media.nullSound;
  }
  if (key === KeyCode.Home || key === KeyCode.KeypadHome) {
    item.oldvalue = item.curvalue;
    item.curvalue = 0;
    item.top = 0;
    if (item.oldvalue !== item.curvalue && c.callback !== null)
      return await changed();
    return menuSound(state.media.buzz);
  }
  if (key === KeyCode.End || key === KeyCode.KeypadEnd) {
    item.oldvalue = item.curvalue;
    item.curvalue = item.numitems - 1;
    item.top = item.columns > 1 ? (nativeInt(item.curvalue / item.height) + 1) * item.height - item.columns * item.height : item.curvalue - (item.height - 1);
    if (item.top < 0)
      item.top = 0;
    if (item.oldvalue !== item.curvalue && c.callback !== null)
      return await changed();
    return menuSound(state.media.buzz);
  }
  if (key === KeyCode.PageUp || key === KeyCode.KeypadPageUp) {
    if (item.columns > 1)
      return state.media.nullSound;
    if (item.curvalue <= 0)
      return menuSound(state.media.buzz);
    item.oldvalue = item.curvalue;
    item.curvalue = Math.max(0, item.curvalue - (item.height - 1));
    item.top = Math.max(0, item.curvalue);
    return await changed();
  }
  if (key === KeyCode.PageDown || key === KeyCode.KeypadPageDown) {
    if (item.columns > 1)
      return state.media.nullSound;
    if (item.curvalue >= item.numitems - 1)
      return menuSound(state.media.buzz);
    item.oldvalue = item.curvalue;
    item.curvalue = Math.min(item.numitems - 1, item.curvalue + item.height - 1);
    item.top = Math.max(0, item.curvalue - (item.height - 1));
    return await changed();
  }
  if (key === KeyCode.Up || key === KeyCode.KeypadUp) {
    if (item.curvalue === 0)
      return menuSound(state.media.buzz);
    item.oldvalue = item.curvalue;
    item.curvalue--;
    if (item.curvalue < item.top)
      item.top -= item.columns === 1 ? 1 : item.height;
    return await changed();
  }
  if (key === KeyCode.Down || key === KeyCode.KeypadDown) {
    if (item.curvalue === item.numitems - 1)
      return menuSound(state.media.buzz);
    item.oldvalue = item.curvalue;
    item.curvalue++;
    if (item.curvalue >= item.top + item.columns * item.height)
      item.top += item.columns === 1 ? 1 : item.height;
    return await changed();
  }
  if (key === KeyCode.Left || key === KeyCode.KeypadLeft) {
    if (item.columns === 1)
      return state.media.nullSound;
    if (item.curvalue < item.height)
      return menuSound(state.media.buzz);
    item.oldvalue = item.curvalue;
    item.curvalue -= item.height;
    if (item.curvalue < item.top)
      item.top -= item.height;
    return await changed();
  }
  if (key === KeyCode.Right || key === KeyCode.KeypadRight) {
    if (item.columns === 1)
      return state.media.nullSound;
    const next = item.curvalue + item.height;
    if (next >= item.numitems)
      return menuSound(state.media.buzz);
    item.oldvalue = item.curvalue;
    item.curvalue = next;
    if (item.curvalue > item.top + item.columns * item.height - 1)
      item.top += item.height;
    return await changed();
  }
  if (key < 32 || key > 126)
    return NO_SOUND;
  if (key >= 65 && key <= 90)
    key += 32;
  for (let i = 1; i <= item.numitems; i++) {
    const j = (item.curvalue + i) % item.numitems, name = itemAt(item.itemnames, j);
    let character = name.length === 0 ? 0 : name.charCodeAt(0);
    if (character >= 128)
      character -= 256;
    if (character >= 65 && character <= 90)
      character += 32;
    if (character !== key)
      continue;
    if (j < item.top)
      item.top = j;
    else if (j > item.top + item.height - 1)
      item.top = j + 1 - item.height;
    if (item.curvalue !== j) {
      item.oldvalue = item.curvalue;
      item.curvalue = j;
      return await changed();
    }
    return menuSound(state.media.buzz);
  }
  return menuSound(state.media.buzz);
}
export async function activateItem(state: BaseUiState, item: BaseMenuItem): Promise<MenuSound> {
  state.assertActive();
  if (item.common.callback !== null) {
    await callback(state, item, MenuEvent.Activated);
    state.assertActive();
    if ((item.common.flags & MenuFlag.Silent) === 0)
      return menuSound(state.media.move);
  }
  return NO_SOUND;
}
export async function defaultKey(state: BaseUiState, menu: BaseMenu | null, key: number): Promise<MenuSound> {
  state.assertActive();
  if (key === KeyCode.Escape || key === KeyCode.Mouse2) {
    await popMenu(state);
    state.assertActive();
    return menuSound(state.media.out);
  }
  if (menu === null || menu.itemCount === 0)
    return NO_SOUND;
  let sound = NO_SOUND;
  const item = menuItemAtCursor(menu);
  if (item !== null && (item.common.flags & unavailable) === 0) {
    switch (item.kind) {
      case "spin":
        sound = await spinKey(state, item, key);
        break;
      case "slider":
        sound = await sliderKey(state, item, key);
        break;
      case "scroll":
        sound = await scrollKey(state, item, key);
        break;
      case "field": {
        const result = fieldKey(state, item, key);
        key = result.key;
        sound = result.sound;
        break;
      }
      case "radio": {
        if ((key === KeyCode.Mouse1 && (item.common.flags & MenuFlag.HasMouseFocus) !== 0) || key === KeyCode.Enter || key === KeyCode.KeypadEnter
          || (key >= KeyCode.Joy1 && key <= KeyCode.Joy4) || key === KeyCode.Left || key === KeyCode.KeypadLeft || key === KeyCode.Right || key === KeyCode.KeypadRight) {
          item.curvalue = item.curvalue === 0 ? 1 : 0;
          await callback(state, item, MenuEvent.Activated);
          state.assertActive();
          sound = menuSound(state.media.move);
        }
        break;
      }
      case "action":
      case "bitmap":
      case "text":
      case "proportional":
      case "banner": break;
      default: {
        const exhaustive: never = item;
        throw new Error(String(exhaustive));
      }
    }
    state.assertActive();
    if (sound.kind !== "none")
      return sound;
  }
  if (key === KeyCode.F11)
    state.debug = !state.debug;
  else if (key === KeyCode.F12)
    state.services.consoleCommands.append("screenshot\n");
  else if (key === KeyCode.Up || key === KeyCode.KeypadUp || key === KeyCode.Down || key === KeyCode.KeypadDown || key === KeyCode.Tab) {
    const previous = menu.cursor;
    menu.cursorPrev = menu.cursor;
    const direction = key === KeyCode.Up || key === KeyCode.KeypadUp ? -1 : 1;
    menu.cursor += direction;
    adjustCursor(state, menu, direction);
    if (previous !== menu.cursor) {
      await cursorMoved(state, menu);
      state.assertActive();
      sound = menuSound(state.media.move);
    }
  }
  else if (key === KeyCode.Mouse1 || key === KeyCode.Mouse3) {
    if (item !== null && (item.common.flags & MenuFlag.HasMouseFocus) !== 0 && (item.common.flags & unavailable) === 0)
      return await activateItem(state, item);
  }
  else if (key === KeyCode.Enter || key === KeyCode.KeypadEnter || (key >= KeyCode.Joy1 && key <= KeyCode.Joy4) || (key >= KeyCode.Aux1 && key <= KeyCode.Aux16)) {
    if (item !== null && (item.common.flags & skipFocus) === 0)
      return await activateItem(state, item);
  }
  return sound;
}
export async function keyEvent(state: BaseUiState, key: number, down: boolean): Promise<void> {
  state.assertActive();
  if (state.activeMenu === null || !down)
    return;
  const menu = state.activeMenu, sound = menu.key === null ? await defaultKey(state, menu, key) : await menu.key(key);
  state.assertActive();
  if (sound.kind === "sound")
    state.play(sound.sound);
}
export async function drawBitmap(state: BaseUiState, item: MenuBitmap): Promise<void> {
  const c = item.common;
  let x = f(c.x);
  const y = f(c.y), width = f(item.width), height = f(item.height);
  if ((c.flags & MenuFlag.RightJustify) !== 0)
    x = f(x - width);
  else if ((c.flags & MenuFlag.CenterJustify) !== 0)
    x = f(x - f(width / 2));
  if (c.name !== null && item.shader === null) {
    const shader = await state.services.resources.registerShaderNoMip(c.name);
    state.assertActive();
    item.shader = shader;
    if (item.shader === null && item.errorpic !== null) {
      const fallback = await state.services.resources.registerShaderNoMip(item.errorpic);
      state.assertActive();
      item.shader = fallback;
    }
  }
  if (item.focuspic !== null && item.focusshader === null) {
    const focus = await state.services.resources.registerShaderNoMip(item.focuspic);
    state.assertActive();
    item.focusshader = focus;
  }
  if ((c.flags & MenuFlag.Grayed) !== 0) {
    if (item.shader !== null) {
      state.draw.setColor(COLORS.disabled);
      drawHandle(state, x, y, width, height, item.shader);
      state.draw.setColor(null);
    }
    return;
  }
  if (item.shader !== null)
    drawHandle(state, x, y, width, height, item.shader);
  if ((c.flags & (MenuFlag.Pulse | MenuFlag.PulseIfFocus)) !== 0 && menuItemAtCursor(menuParent(item)) === item) {
    const alpha = f(.5 + f(.5 * f(Math.sin(f(nativeInt(state.realtime / 75))))));
    const color = item.focuscolor === null ? { ...state.pulseColor, w: alpha } : { ...item.focuscolor, w: alpha };
    if (item.focuscolor === null)
      state.pulseColor = color;
    state.draw.setColor(color);
    drawHandle(state, x, y, width, height, item.focusshader);
    state.draw.setColor(null);
  }
  else if ((c.flags & MenuFlag.Highlight) !== 0 || ((c.flags & MenuFlag.HighlightIfFocus) !== 0 && menuItemAtCursor(menuParent(item)) === item)) {
    if (item.focuscolor !== null)
      state.draw.setColor(item.focuscolor);
    drawHandle(state, x, y, width, height, item.focusshader);
    if (item.focuscolor !== null)
      state.draw.setColor(null);
  }
}
async function drawItem(state: BaseUiState, item: BaseMenuItem): Promise<void> {
  const c = item.common, focused = menuParent(item).cursor === c.menuPosition;
  switch (item.kind) {
    case "field":
      drawField(state, item);
      break;
    case "bitmap":
      await drawBitmap(state, item);
      state.assertActive();
      break;
    case "text": {
      const text = (c.name === null ? "" : sourceCommandText(c.name)) + (item.text === null ? "" : sourceCommandText(item.text));
      if (text.length >= 512)
        throw new RangeError("Undefined native menu text buffer overflow");
      drawString(state, c.x, c.y, text, item.style, (c.flags & MenuFlag.Grayed) !== 0 ? COLORS.disabled : item.color);
      break;
    }
    case "banner":
      drawBanner(state, c.x, c.y, item.text, item.style, (c.flags & MenuFlag.Grayed) !== 0 ? COLORS.disabled : item.color);
      break;
    case "proportional": {
      let style = item.style;
      if ((c.flags & MenuFlag.PulseIfFocus) !== 0)
        style |= menuItemAtCursor(menuParent(item)) === item ? UI_PULSE : UI_INVERSE;
      drawProportional(state, c.x, c.y, item.text, style, (c.flags & MenuFlag.Grayed) !== 0 ? COLORS.disabled : item.color);
      break;
    }
    case "action": {
      let style = 0, color = COLORS.menuText;
      if ((c.flags & MenuFlag.Grayed) !== 0)
        color = COLORS.disabled;
      else if ((c.flags & MenuFlag.PulseIfFocus) !== 0 && focused) {
        color = COLORS.highlight;
        style = UI_PULSE;
      }
      else if ((c.flags & MenuFlag.HighlightIfFocus) !== 0 && focused)
        color = COLORS.highlight;
      else if ((c.flags & MenuFlag.Blink) !== 0) {
        style = UI_BLINK;
        color = COLORS.highlight;
      }
      drawString(state, c.x, c.y, c.name, style, color);
      if (focused)
        drawChar(state, c.x - 16, c.y, 13, UI_BLINK, color);
      break;
    }
    case "radio": {
      const color = (c.flags & MenuFlag.Grayed) !== 0 ? COLORS.disabled : focused ? COLORS.highlight : COLORS.normal;
      const style = UI_SMALLFONT | ((c.flags & MenuFlag.Grayed) === 0 && focused ? UI_PULSE : 0);
      if (focused) {
        fillRect(state, c.left, c.top, c.right - c.left + 1, c.bottom - c.top + 1, COLORS.listbar);
        drawChar(state, c.x, c.y, 13, UI_CENTER | UI_BLINK | UI_SMALLFONT, color);
      }
      if (c.name !== null)
        drawString(state, c.x - 8, c.y, c.name, UI_RIGHT | UI_SMALLFONT, color);
      drawHandle(state, c.x + 8, c.y + 2, 16, 16, item.curvalue === 0 ? state.media.radioOff : state.media.radioOn);
      drawString(state, c.x + 24, c.y, item.curvalue === 0 ? "off" : "on", style, color);
      break;
    }
    case "slider": {
      const color = (c.flags & MenuFlag.Grayed) !== 0 ? COLORS.disabled : focused ? COLORS.highlight : COLORS.normal;
      const style = UI_SMALLFONT | ((c.flags & MenuFlag.Grayed) === 0 && focused ? UI_PULSE : 0);
      drawString(state, c.x - 8, c.y, c.name, UI_RIGHT | style, color);
      state.draw.setColor(color);
      drawHandle(state, c.x + 8, c.y, 96, 16, state.media.slider);
      state.draw.setColor(null);
      if (item.maxvalue > item.minvalue) {
        item.range = f(f(item.curvalue - item.minvalue) / f(item.maxvalue - item.minvalue));
        if (item.range < 0)
          item.range = 0;
        else if (item.range > 1)
          item.range = 1;
      }
      else
        item.range = 0;
      drawHandle(state, nativeInt(f(f(c.x + 16) + f(72 * item.range))) - 2, c.y - 2, 12, 20, (style & UI_PULSE) !== 0 ? state.media.sliderFocus : state.media.sliderButton);
      break;
    }
    case "spin": {
      let style = UI_SMALLFONT, color = COLORS.normal;
      if ((c.flags & MenuFlag.Grayed) !== 0)
        color = COLORS.disabled;
      else if (focused) {
        color = COLORS.highlight;
        style |= UI_PULSE;
      }
      else if ((c.flags & MenuFlag.Blink) !== 0) {
        color = COLORS.highlight;
        style |= UI_BLINK;
      }
      if (focused) {
        fillRect(state, c.left, c.top, c.right - c.left + 1, c.bottom - c.top + 1, COLORS.listbar);
        drawChar(state, c.x, c.y, 13, UI_CENTER | UI_BLINK | UI_SMALLFONT, color);
      }
      drawString(state, c.x - 8, c.y, c.name, style | UI_RIGHT, color);
      drawString(state, c.x + 8, c.y, itemAt(item.itemnames, item.curvalue), style, color);
      break;
    }
    case "scroll": {
      let x = c.x;
      for (let column = 0; column < item.columns; column++) {
        let y = c.y;
        const base = item.top + column * item.height;
        for (let i = base; i < base + item.height; i++) {
          if (i >= item.numitems)
            break;
          let color = COLORS.normal, style = UI_SMALLFONT;
          if (i === item.curvalue) {
            let u = x - 2;
            if ((c.flags & MenuFlag.CenterJustify) !== 0)
              u -= nativeInt(item.width * 8 / 2) + 1;
            fillRect(state, u, y, item.width * 8, 18, COLORS.listbar);
            color = COLORS.highlight;
            if (focused)
              style |= UI_PULSE;
          }
          if ((c.flags & MenuFlag.CenterJustify) !== 0)
            style |= UI_CENTER;
          drawString(state, x, y, itemAt(item.itemnames, i), style, color);
          y += 16;
        }
        x += (item.width + item.separation) * 8;
      }
      break;
    }
    default: {
      const exhaustive: never = item;
      throw new Error(String(exhaustive));
    }
  }
}
export async function drawMenu(state: BaseUiState, menu: BaseMenu): Promise<void> {
  state.assertActive();
  for (let i = 0; i < menu.itemCount; i++) {
    const item = itemAt(menu.items, i);
    if ((item.common.flags & MenuFlag.Hidden) !== 0)
      continue;
    if (item.common.ownerdraw !== null)
      await item.common.ownerdraw(item);
    else
      await drawItem(state, item);
    state.assertActive();
    if (state.debug && (item.common.flags & MenuFlag.Inactive) === 0) {
      const c = item.common;
      drawRect(state, c.left, c.top, c.right - c.left + 1, c.bottom - c.top + 1, (c.flags & MenuFlag.HasMouseFocus) !== 0 ? COLORS.highlight : COLORS.white);
    }
  }
  const item = menuItemAtCursor(menu);
  if (item !== null && item.common.statusbar !== null) {
    await item.common.statusbar(item);
    state.assertActive();
  }
}
export async function refresh(state: BaseUiState, realtime: number): Promise<void> {
  state.assertActive();
  const nextTime = nativeInt(realtime);
  state.frameTime = (nextTime - state.realtime) | 0;
  state.realtime = nextTime;
  if ((state.services.keys.getCatcher() & KeyCatcher.Ui) === 0)
    return;
  state.services.cvars.update();
  if (state.activeMenu !== null) {
    if (state.activeMenu.fullscreen)
      drawHandle(state, 0, 0, 640, 480, state.activeMenu.showlogo ? state.media.background : state.media.backgroundNoLogo);
    const draw = active(state).draw;
    if (draw !== null)
      await draw();
    else
      await drawMenu(state, active(state));
    state.assertActive();
    if (state.firstDraw) {
      await mouseEvent(state, 0, 0);
      state.assertActive();
      state.firstDraw = false;
    }
  }
  state.draw.setColor(null);
  drawHandle(state, state.cursorX - 16, state.cursorY - 16, 32, 32, state.media.cursor);
  if (state.debug)
    drawString(state, 0, 0, `(${state.cursorX},${state.cursorY})`, UI_SMALLFONT, COLORS.red);
  if (state.enterSound) {
    state.play(state.media.enter);
    state.enterSound = false;
  }
}
