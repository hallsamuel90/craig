import type { IBufferCell, Terminal } from "@xterm/headless";

// @xterm/headless 6 exposes neither OSC 8 URLs nor cell link IDs in its public
// types. Keep this read-only compatibility adapter isolated; xterm owns link
// lifetime, wrapping, overwrites and scrollback through its native cell metadata.
interface LinkCell {
  extended?: { urlId?: number };
  hasExtendedAttrs?: () => number;
}

interface LinkTerminal {
  _core?: {
    _oscLinkService?: {
      // eslint-disable-next-line no-unused-vars
      getLinkData: (id: number) => { uri?: string } | undefined;
    };
  };
}

export function getTerminalCellHref(terminal: Terminal, cell: IBufferCell): string | undefined {
  const linkCell = cell as IBufferCell & LinkCell;
  // Reused cells can retain stale extended data after loading an unlinked cell.
  if (!linkCell.hasExtendedAttrs?.()) return undefined;
  const id = linkCell.extended?.urlId;
  if (!id) return undefined;
  const uri = (terminal as unknown as LinkTerminal)._core?._oscLinkService?.getLinkData(id)?.uri;
  if (!uri || !/^(https?:|file:|mailto:)/i.test(uri)) return undefined;
  if ([...uri].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))) return undefined;
  return uri;
}
