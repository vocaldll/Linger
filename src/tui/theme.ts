import { styleText } from "node:util";
import { PALETTE } from "../theme.js";

export const ui = {
  accent: (text: string): string => styleText(PALETTE.violet, text),
  accentStrong: (text: string): string => styleText("bold", styleText(PALETTE.lilac, text)),
  deepAccent: (text: string): string => styleText(PALETTE.plum, text),
  muted: (text: string): string => styleText("dim", styleText(PALETTE.mist, text)),
  success: (text: string): string => styleText(PALETTE.mint, text),
  danger: (text: string): string => styleText(PALETTE.rose, text),
  strong: (text: string): string => styleText("bold", text),
  key: (text: string): string => styleText("bold", styleText(PALETTE.lilac, text))
};

export const LINGER_THEME = {
  prefix: {
    idle: ui.accent("◆"),
    done: ui.success("✓")
  },
  spinner: {
    interval: 80,
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map(ui.accent)
  },
  icon: {
    cursor: ui.accentStrong("›")
  },
  style: {
    answer: ui.accentStrong,
    message: (text: string): string => ui.strong(text),
    error: (text: string): string => ui.danger(`! ${text}`),
    defaultAnswer: (text: string): string => ui.muted(`(${text})`),
    help: ui.muted,
    highlight: ui.accentStrong,
    key: ui.key,
    disabled: ui.muted,
    description: ui.muted,
    searchTerm: ui.accentStrong,
    keysHelpTip: (keys: [key: string, action: string][]): string =>
      keys
        .map(([key, action]) => `${ui.key(key)} ${ui.muted(action)}`)
        .join(ui.muted("  ·  "))
  }
} as const;

export function printLingerHeader(): void {
  process.stdout.write(
    [
      "",
      `  ${ui.accentStrong("◷  LINGER")}  ${ui.deepAccent("━━━━━━━━━━━━━━━━━━")}`,
      `     ${ui.muted("Steam hour booster and card farmer")}`,
      ""
    ].join("\n")
  );
}
