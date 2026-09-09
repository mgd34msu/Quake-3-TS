// Source ui/keycodes.h values; shared by engine input, cgame and menus.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
export const KEY_CHAR_FLAG = 1024;
export enum KeyCatcher { Console = 1, Ui = 2, Message = 4, Cgame = 8 }
export enum KeyCode {
  Tab = 9, Enter = 13, Escape = 27, Space = 32, Backspace = 127,
  Command = 128, CapsLock = 129, Power = 130, Pause = 131,
  Up = 132, Down = 133, Left = 134, Right = 135,
  Alt = 136, Control = 137, Shift = 138, Insert = 139, Delete = 140,
  PageDown = 141, PageUp = 142, Home = 143, End = 144,
  F1 = 145, F2 = 146, F3 = 147, F4 = 148, F5 = 149, F6 = 150, F7 = 151, F8 = 152,
  F9 = 153, F10 = 154, F11 = 155, F12 = 156, F13 = 157, F14 = 158, F15 = 159,
  KeypadHome = 160, KeypadUp = 161, KeypadPageUp = 162, KeypadLeft = 163, Keypad5 = 164,
  KeypadRight = 165, KeypadEnd = 166, KeypadDown = 167, KeypadPageDown = 168,
  KeypadEnter = 169, KeypadInsert = 170, KeypadDelete = 171, KeypadSlash = 172,
  KeypadMinus = 173, KeypadPlus = 174, KeypadNumLock = 175, KeypadStar = 176, KeypadEquals = 177,
  Mouse1 = 178, Mouse2 = 179, Mouse3 = 180, Mouse4 = 181, Mouse5 = 182,
  MouseWheelDown = 183, MouseWheelUp = 184,
  Joy1 = 185, Joy2 = 186, Joy3 = 187, Joy4 = 188, Joy5 = 189, Joy6 = 190, Joy7 = 191, Joy8 = 192,
  Joy9 = 193, Joy10 = 194, Joy11 = 195, Joy12 = 196, Joy13 = 197, Joy14 = 198, Joy15 = 199,
  Joy16 = 200, Joy17 = 201, Joy18 = 202, Joy19 = 203, Joy20 = 204, Joy21 = 205, Joy22 = 206,
  Joy23 = 207, Joy24 = 208, Joy25 = 209, Joy26 = 210, Joy27 = 211, Joy28 = 212, Joy29 = 213,
  Joy30 = 214, Joy31 = 215, Joy32 = 216,
  Aux1 = 217, Aux2 = 218, Aux3 = 219, Aux4 = 220, Aux5 = 221, Aux6 = 222, Aux7 = 223,
  Aux8 = 224, Aux9 = 225, Aux10 = 226, Aux11 = 227, Aux12 = 228, Aux13 = 229, Aux14 = 230,
  Aux15 = 231, Aux16 = 232,
}
