// Craig's rabbit lives on an integer pixel grid. '#' is ink; spaces are empty.
// Keep the margins: a favicon is not a tightly cropped illustration.
export const brandGreen = "#9ece6a";
export const brandBackground = "#0a0a0a";
export const rabbitSize = 32;
const drawing = [
  "",
  "",
  "",
  "                 ###",
  "                 ###",
  "          ###   ###",
  "          ###   ###",
  "          ###  ###",
  "          ###  ###",
  "           ######",
  "          ########",
  "         #########",
  "        ### ######",
  "      ############",
  "      ############",
  "        #########",
  "          ######",
  "           ##########",
  "           ############",
  "          ##############  ##",
  "          ############## ###",
  "          #################",
  "          ###############",
  "          ###############",
  "          ##############",
  "          ###  ########",
  "        #####  ##########",
  "        #####  ##########",
  "",
  "",
  "",
  "",
];
if (drawing.length !== rabbitSize || drawing.some((row) => row.length > rabbitSize || /[^ #]/.test(row))) {
  throw new Error("Craig rabbit must fit the 32 × 32 pixel grid.");
}
export const rabbitRows = drawing.map((row) => row.padEnd(rabbitSize, " "));
// Horizontal runs produce a compact, rectilinear path with a transparent eye.
export const rabbitPath = rabbitRows.flatMap((row, y) => [...row.matchAll(/#+/g)]
  .map((match) => `M${match.index} ${y}h${match[0].length}v1H${match.index}z`)).join("");

export function rabbitSvg({ size = 32, color = brandGreen, background = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" shape-rendering="crispEdges">${background ? `<path fill="${brandBackground}" d="M0 0h32v32H0z"/>` : ""}<path fill="${color}" d="${rabbitPath}"/></svg>\n`;
}
