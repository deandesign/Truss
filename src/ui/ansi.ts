/* Minimal ANSI helpers. Truss has one dependency and this does not warrant a second. */

const ESCAPE = /\x1b\[[0-9;]*m/g;
const HAS_ESCAPE = /\x1b\[[0-9;]*m/;

export interface Style {
  (text: string): string;
}

function code(open: number, close = 39): Style {
  return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

export interface Palette {
  dim: Style;
  bold: Style;
  green: Style;
  red: Style;
  yellow: Style;
  cyan: Style;
  magenta: Style;
  plain: Style;
}

const identity: Style = (text) => text;

export const PLAIN: Palette = {
  dim: identity,
  bold: identity,
  green: identity,
  red: identity,
  yellow: identity,
  cyan: identity,
  magenta: identity,
  plain: identity,
};

export const COLOR: Palette = {
  dim: code(2, 22),
  bold: code(1, 22),
  green: code(32),
  red: code(31),
  yellow: code(33),
  cyan: code(36),
  magenta: code(35),
  plain: identity,
};

/** Colour is opt-out via NO_COLOR and off entirely when not writing to a terminal. */
export function paletteFor(stream: { isTTY?: boolean }): Palette {
  if (process.env.NO_COLOR) return PLAIN;
  if (process.env.FORCE_COLOR) return COLOR;
  return stream.isTTY ? COLOR : PLAIN;
}

export function visibleLength(text: string): number {
  return text.replace(ESCAPE, "").length;
}

/**
 * Truncate to `width` visible columns, keeping escape sequences intact so a
 * clipped line cannot leak an unterminated colour into the rest of the frame.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < width - 1) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += text[i];
    seen += 1;
    i += 1;
  }
  // Only reset when the text actually carried styling, so a plain-text clip
  // does not print a stray escape.
  return `${out}…${HAS_ESCAPE.test(text) ? "\x1b[0m" : ""}`;
}

export function pad(text: string, width: number): string {
  const length = visibleLength(text);
  return length >= width ? text : text + " ".repeat(width - length);
}
