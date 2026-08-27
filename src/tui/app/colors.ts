/**
 * Bridge from Rocky's theme to OpenTUI color props. Theme colors are a small
 * DSL ("fg:#858585 bold", "bg:#282a36"); OpenTUI wants bare hex — so the fg
 * component is extracted here, and the footer derives from the same Theme
 * object as the scrollback content.
 */
import { getCurrentTheme } from "../theme.ts";

export type FooterColors = {
  text: string;
  muted: string;
  accent: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  highlight: string;
  background: string | undefined;
};

const fgHex = (color: string, fallback: string): string =>
  color.match(/fg:(#[0-9a-fA-F]{6})/)?.[1] ?? fallback;

export function footerColors(): FooterColors {
  const t = getCurrentTheme();
  const text = fgHex(t.ui.text, "#d4d4d4");
  const bg = t.ui.background.match(/bg:(#[0-9a-fA-F]{6})/)?.[1];
  return {
    text,
    muted: fgHex(t.ui.muted, "#808080"),
    accent: fgHex(t.ui.accent, "#569cd6"),
    border: fgHex(t.ui.border, "#444444"),
    success: fgHex(t.ui.success, "#4ec9b0"),
    warning: fgHex(t.ui.warning, "#dcdcaa"),
    error: fgHex(t.ui.error, "#f48771"),
    highlight: fgHex(t.ui.highlight, text),
    background: bg,
  };
}
