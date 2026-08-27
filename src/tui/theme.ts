/**
 * Theme system for Rocky's TUI.
 *
 * Inspired by OpenCode's theme system, supports multiple built-in themes,
 * custom theme loading, and terminal capability detection.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Theme interface
// ---------------------------------------------------------------------------

export interface Theme {
  /** Theme name */
  name: string;
  /** Whether this is a dark theme */
  dark: boolean;
  /** Base colors for UI elements */
  ui: UiColors;
  /** Syntax highlighting colors */
  syntax: SyntaxColors;
  /** Markdown rendering colors */
  markdown: MarkdownColors;
  /** Diff view colors */
  diff: DiffColors;
}

export interface UiColors {
  /** Primary text color */
  text: string;
  /** Muted/secondary text */
  muted: string;
  /** Background color (empty string for default) */
  background: string;
  /** Border/frame color */
  border: string;
  /** Success/information color */
  success: string;
  /** Warning color */
  warning: string;
  /** Error color */
  error: string;
  /** Highlight/selection color */
  highlight: string;
  /** Spinner/activity indicator */
  accent: string;
}

export interface SyntaxColors {
  /** Keywords (if, else, for, while, etc.) */
  keyword: string;
  /** Type names (string, number, boolean, custom types) */
  type: string;
  /** String literals */
  string: string;
  /** Numeric literals */
  number: string;
  /** Comments */
  comment: string;
  /** Function/method names */
  function: string;
  /** Variable/identifier names */
  variable: string;
  /** Operators and punctuation */
  punctuation: string;
  /** Constants (true, false, null, undefined) */
  constant: string;
  /** Decorators/annotations */
  decorator: string;
  /** Tags in HTML/XML */
  tag: string;
  /** Attributes in HTML/XML */
  attribute: string;
}

export interface MarkdownColors {
  /** Heading text */
  heading: string;
  /** Links */
  link: string;
  /** Inline code */
  code: string;
  /** Code block background (empty for none) */
  codeBlockBg: string;
  /** Blockquote */
  blockquote: string;
  /** List markers */
  listMarker: string;
  /** Table borders */
  tableBorder: string;
  /** Bold text */
  bold: string;
  /** Italic text */
  italic: string;
}

export interface DiffColors {
  /** Added lines background */
  addedBg: string;
  /** Removed lines background */
  removedBg: string;
  /** Added lines text */
  addedText: string;
  /** Removed lines text */
  removedText: string;
  /** Hunk headers */
  hunk: string;
  /** Added lines indicator (+) */
  addedSign: string;
  /** Removed lines indicator (-) */
  removedSign: string;
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

const opencodeTheme: Theme = {
  name: "opencode",
  dark: true,
  ui: {
    text: "fg:#d4d4d4",
    muted: "fg:#858585",
    background: "",
    border: "fg:#404040",
    success: "fg:#4ec9b0",
    warning: "fg:#ce9178",
    error: "fg:#f48771",
    highlight: "bg:#264f78",
    accent: "fg:#569cd6",
  },
  syntax: {
    keyword: "fg:#569cd6",
    type: "fg:#4ec9b0",
    string: "fg:#ce9178",
    number: "fg:#b5cea8",
    comment: "fg:#6a9955",
    function: "fg:#dcdcaa",
    variable: "fg:#9cdcfe",
    punctuation: "fg:#d4d4d4",
    constant: "fg:#4fc1ff",
    decorator: "fg:#dcdcaa",
    tag: "fg:#569cd6",
    attribute: "fg:#9cdcfe",
  },
  markdown: {
    heading: "fg:#569cd6",
    link: "fg:#4fc1ff",
    code: "fg:#ce9178",
    codeBlockBg: "bg:#1e1e1e",
    blockquote: "fg:#6a9955",
    listMarker: "fg:#569cd6",
    tableBorder: "fg:#404040",
    bold: "bold",
    italic: "italic",
  },
  diff: {
    addedBg: "bg:#1e3a2e",
    removedBg: "bg:#3a1e1e",
    addedText: "fg:#4ec9b0",
    removedText: "fg:#f48771",
    hunk: "fg:#858585",
    addedSign: "fg:#4ec9b0",
    removedSign: "fg:#f48771",
  },
};

const draculaTheme: Theme = {
  name: "dracula",
  dark: true,
  ui: {
    text: "fg:#f8f8f2",
    muted: "fg:#6272a4",
    background: "",
    border: "fg:#44475a",
    success: "fg:#50fa7b",
    warning: "fg:#ffb86c",
    error: "fg:#ff5555",
    highlight: "bg:#44475a",
    accent: "fg:#bd93f9",
  },
  syntax: {
    keyword: "fg:#ff79c6",
    type: "fg:#8be9fd",
    string: "fg:#f1fa8c",
    number: "fg:#bd93f9",
    comment: "fg:#6272a4",
    function: "fg:#50fa7b",
    variable: "fg:#f8f8f2",
    punctuation: "fg:#f8f8f2",
    constant: "fg:#bd93f9",
    decorator: "fg:#50fa7b",
    tag: "fg:#ff79c6",
    attribute: "fg:#50fa7b",
  },
  markdown: {
    heading: "fg:#bd93f9",
    link: "fg:#8be9fd",
    code: "fg:#f1fa8c",
    codeBlockBg: "bg:#282a36",
    blockquote: "fg:#6272a4",
    listMarker: "fg:#bd93f9",
    tableBorder: "fg:#44475a",
    bold: "bold",
    italic: "italic",
  },
  diff: {
    addedBg: "bg:#254636",
    removedBg: "bg:#4a2020",
    addedText: "fg:#50fa7b",
    removedText: "fg:#ff5555",
    hunk: "fg:#6272a4",
    addedSign: "fg:#50fa7b",
    removedSign: "fg:#ff5555",
  },
};

const zenburnTheme: Theme = {
  name: "zenburn",
  dark: true,
  ui: {
    text: "fg:#dcdccc",
    muted: "fg:#9fafaf",
    background: "",
    border: "fg:#4f4f4f",
    success: "fg:#7f9f7f",
    warning: "fg:#dfaf8f",
    error: "fg:#cc9393",
    highlight: "bg:#4f4f4f",
    accent: "fg:#8cd0d3",
  },
  syntax: {
    keyword: "fg:#f0dfaf",
    type: "fg:#7cb8bb",
    string: "fg:#cc9393",
    number: "fg:#d0bf8f",
    comment: "fg:#7f9f7f",
    function: "fg:#93e0e3",
    variable: "fg:#dfaf8f",
    punctuation: "fg:#dcdccc",
    constant: "fg:#d0bf8f",
    decorator: "fg:#93e0e3",
    tag: "fg:#f0dfaf",
    attribute: "fg:#dfaf8f",
  },
  markdown: {
    heading: "fg:#f0dfaf",
    link: "fg:#8cd0d3",
    code: "fg:#cc9393",
    codeBlockBg: "bg:#2b2b2b",
    blockquote: "fg:#7f9f7f",
    listMarker: "fg:#f0dfaf",
    tableBorder: "fg:#4f4f4f",
    bold: "bold",
    italic: "italic",
  },
  diff: {
    addedBg: "bg:#2b3a2b",
    removedBg: "bg:#3a2b2b",
    addedText: "fg:#7f9f7f",
    removedText: "fg:#cc9393",
    hunk: "fg:#9fafaf",
    addedSign: "fg:#7f9f7f",
    removedSign: "fg:#cc9393",
  },
};

const plainTheme: Theme = {
  name: "plain",
  dark: false,
  ui: {
    text: "",
    muted: "dim",
    background: "",
    border: "dim",
    success: "green",
    warning: "yellow",
    error: "red",
    highlight: "reverse",
    accent: "blue",
  },
  syntax: {
    keyword: "blue",
    type: "cyan",
    string: "yellow",
    number: "magenta",
    comment: "dim",
    function: "green",
    variable: "white",
    punctuation: "",
    constant: "magenta",
    decorator: "green",
    tag: "blue",
    attribute: "cyan",
  },
  markdown: {
    heading: "bold",
    link: "underline",
    code: "yellow",
    codeBlockBg: "",
    blockquote: "dim",
    listMarker: "bold",
    tableBorder: "dim",
    bold: "bold",
    italic: "italic",
  },
  diff: {
    addedBg: "",
    removedBg: "",
    addedText: "green",
    removedText: "red",
    hunk: "dim",
    addedSign: "green",
    removedSign: "red",
  },
};

// ---------------------------------------------------------------------------
// Theme registry and loading
// ---------------------------------------------------------------------------

const BUILTIN_THEMES: Record<string, Theme> = {
  opencode: opencodeTheme,
  dracula: draculaTheme,
  zenburn: zenburnTheme,
  plain: plainTheme,
};

let currentTheme: Theme = opencodeTheme;

/**
 * Get the current active theme.
 */
export function getCurrentTheme(): Theme {
  return currentTheme;
}

/**
 * Set the active theme by name or theme object.
 */
export function setTheme(theme: string | Theme): void {
  if (typeof theme === "string") {
    const builtin = BUILTIN_THEMES[theme.toLowerCase()];
    if (builtin) {
      currentTheme = builtin;
      return;
    }
    // Try to load custom theme from file
    const custom = loadCustomTheme(theme);
    if (custom) {
      currentTheme = custom;
      return;
    }
    throw new Error(
      `Unknown theme: ${theme}. Available themes: ${Object.keys(BUILTIN_THEMES).join(", ")}`
    );
  }
  currentTheme = theme;
}

/**
 * Get list of available built-in theme names.
 */
export function getAvailableThemes(): string[] {
  return Object.keys(BUILTIN_THEMES);
}

/**
 * Load a custom theme from ~/.config/rocky/themes/ or .rocky/themes/
 */
function loadCustomTheme(name: string): Theme | null {
  const locations = [
    join(homedir(), ".config", "rocky", "themes", `${name}.json`),
    join(process.cwd(), ".rocky", "themes", `${name}.json`),
  ];

  for (const path of locations) {
    try {
      const content = readFileSync(path, "utf-8");
      const theme = JSON.parse(content) as Theme;
      if (validateTheme(theme)) {
        return theme;
      }
    } catch {
      // File doesn't exist or is invalid, try next location
    }
  }

  return null;
}

/**
 * Validate that a theme object has all required fields.
 */
function validateTheme(theme: unknown): theme is Theme {
  if (typeof theme !== "object" || theme === null) return false;
  const t = theme as Record<string, unknown>;
  return (
    typeof t.name === "string" &&
    typeof t.dark === "boolean" &&
    typeof t.ui === "object" &&
    typeof t.syntax === "object" &&
    typeof t.markdown === "object" &&
    typeof t.diff === "object"
  );
}

/**
 * Create ANSI escape codes from theme color strings.
 *
 * Theme colors use CSS-like syntax:
 * - "fg:#rrggbb" for foreground color
 * - "bg:#rrggbb" for background color
 * - "bold", "dim", "italic", "underline" for text styles
 * - "" for default
 */
export function themeColorToAnsi(color: string): string {
  if (!color || !process.stdout.isTTY) return "";

  const codes: string[] = [];

  // Parse foreground color
  const fgMatch = color.match(/fg:#([0-9a-fA-F]{6})/);
  if (fgMatch) {
    const hex = fgMatch[1]!;
    codes.push(`38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}`);
  }

  // Parse background color
  const bgMatch = color.match(/bg:#([0-9a-fA-F]{6})/);
  if (bgMatch) {
    const hex = bgMatch[1]!;
    codes.push(`48;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}`);
  }

  // Parse text styles
  if (color.includes("bold")) codes.push("1");
  if (color.includes("dim")) codes.push("2");
  if (color.includes("italic")) codes.push("3");
  if (color.includes("underline")) codes.push("4");
  if (color.includes("reverse")) codes.push("7");

  if (codes.length === 0) return "";

  return `\x1b[${codes.join(";")}m`;
}

/**
 * Reset ANSI styling.
 */
export function themeColorReset(): string {
  return "\x1b[0m";
}

/**
 * Apply a theme color to a string.
 */
export function applyThemeColor(color: string, text: string): string {
  if (!color) return text;
  return `${themeColorToAnsi(color)}${text}${themeColorReset()}`;
}
