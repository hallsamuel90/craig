export function getFileIcon(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "󰛦 ";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "󰌞 ";
    case "json":
    case "jsonc":
      return "󰡱 ";
    case "md":
    case "mdx":
      return "󰍔 ";
    case "yaml":
    case "yml":
      return "󰬐 ";
    case "sh":
    case "bash":
    case "zsh":
      return "󰆍 ";
    case "css":
    case "scss":
    case "sass":
      return "󰌜 ";
    case "html":
    case "htm":
      return "󰌝 ";
    case "py":
      return "󰌠 ";
    case "go":
      return "󰟓 ";
    case "rs":
      return "󱘗 ";
    case "lock":
      return "󰌾 ";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return "󰋩 ";
    default:
      return "󰈔 ";
  }
}

export const DIR_ICON_CLOSED = "󰉋 ";
export const DIR_ICON_OPEN = "󰷏 ";
export const PR_ICON_NONE = "○";
export const PR_ICON_OPEN = "";
export const PR_ICON_MERGED = "";
export const PR_ICON_CLOSED = "";
export const CHECK_ICON_NONE = "○";
export const CHECK_ICON_PENDING = "●";
export const CHECK_ICON_SUCCESS = "✓";
export const CHECK_ICON_FAILED = "✕";

export function getFileIconColor(filename: string): string | undefined {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "4fc1ff";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "f7df1e";
    case "json":
    case "jsonc":
      return "fbc02d";
    case "md":
    case "mdx":
      return "519aba";
    case "yaml":
    case "yml":
      return "e06c75";
    case "sh":
    case "bash":
    case "zsh":
      return "89e051";
    case "css":
    case "scss":
    case "sass":
      return "c792ea";
    case "html":
    case "htm":
      return "e06c75";
    case "py":
      return "3572a5";
    case "go":
      return "00add8";
    case "rs":
      return "dea584";
    case "lock":
      return "565f89";
    default:
      return undefined;
  }
}
