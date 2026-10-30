// Pixel-sample the original rabbit silhouette. No new facial or body details.
export const brandGreen = "#9ece6a";
export const brandBackground = "#0a0a0a";
export const rabbitSize = 32;
// Original favicon geometry (including its translate(2 0)), in its 30×30 frame.
// Retain the original crop with a one-pixel border, keeping the mark prominent.
const ellipses = [
  [10, 5, 2, 6], [14, 4, 1.8, 5.5], [12, 14, 5, 5],
  [17, 22, 7.5, 7.5], [24, 18, 2.5, 2.5],
  [10, 29, 3.5, 1.5], [21, 29, 4, 1.5],
];
export const rabbitRows = Array.from({ length: rabbitSize }, (_, y) =>
  Array.from({ length: rabbitSize }, (_, x) => {
    if (x < 1 || y < 1 || x >= 31 || y >= 31) return " ";
    const originalX = x + 0.5 - 1;
    const originalY = y + 0.5 - 1;
    return ellipses.some(([cx, cy, rx, ry]) =>
      ((originalX - cx) / rx) ** 2 + ((originalY - cy) / ry) ** 2 <= 1) ? "#" : " ";
  }).join(""));
// Horizontal runs produce a compact, rectilinear silhouette.
export const rabbitPath = rabbitRows.flatMap((row, y) => [...row.matchAll(/#+/g)]
  .map((match) => `M${match.index} ${y}h${match[0].length}v1H${match.index}z`)).join("");

export function rabbitSvg({ size = 32, color = brandGreen, background = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" shape-rendering="crispEdges">${background ? `<path fill="${brandBackground}" d="M0 0h32v32H0z"/>` : ""}<path fill="${color}" d="${rabbitPath}"/></svg>\n`;
}
