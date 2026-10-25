// Clouds drawn as a grid of dots, ported from the Sage website. The density of
// the cloud at each dot sets how big and how opaque it is, so the clouds read
// as halftone. Here they hold still: one draw, no animation loop.

const GAP = 12;
const SCALE = 1 / 230;
const FULL_CIRCLE = Math.PI * 2;

// Cloud density below this fades out entirely; it reaches full over FEATHER.
const CLOUD_FLOOR = 0.42;
const CLOUD_FEATHER = 0.3;

// Dots in a cloud-free patch can turn into stars, but only in the night sky
// (`stars` in the palette). This is the share of such dots that do.
const STAR_CHANCE = 0.018;
const STAR_RADIUS = 1.3;
const STAR_PEAK_ALPHA = 0.9;

// How far past `clearUntil` the cloud-free strip takes to give way to clouds.
const CLEAR_FEATHER = 160;

export const MAX_PIXEL_RATIO = 2;

export interface CloudPalette {
  dotAlphaHigh: number;
  dotAlphaLow: number;
  dotColor: string;
  stars: boolean;
}

export interface CloudOptions {
  /** The edge the noise is measured from. The right edge keeps its clouds as the width changes. */
  anchor?: "left" | "right";
  /** Pixels from the left edge that stay free of clouds, such as under text. */
  clearUntil?: number;
  height: number;
  /** Slides the clouds along their noise, so two places can look different. */
  offset?: number;
  palette: CloudPalette;
  width: number;
}

// Integer hash of a grid point into [0, 1). The bit mixing is the point, so
// the bitwise-operator rule doesn't apply here.
// biome-ignore-start lint/suspicious/noBitwiseOperators: integer hash
function hash(x: number, y: number) {
  let n = (Math.imul(x | 0, 374_761_393) + Math.imul(y | 0, 668_265_263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1_274_126_177);
  n ^= n >>> 16;
  return (n >>> 0) / 4_294_967_296;
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: integer hash

// Smooth value noise: random values on a grid, blended between grid points.
function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Three layers of noise at growing detail.
function cloud(x: number, y: number) {
  return (
    0.5 * noise(x, y) +
    0.3 * noise(x * 2.1 + 17, y * 2.1 + 5) +
    0.2 * noise(x * 4.3 + 41, y * 4.3 + 11)
  );
}

function smoothstep(value: number) {
  const linear = Math.min(1, Math.max(0, value));
  return linear * linear * (3 - 2 * linear);
}

/** Reads the dot colors from the CSS variables, so they follow the theme. */
export function readCloudPalette(element: Element): CloudPalette {
  const style = getComputedStyle(element);
  const number = (name: string, fallback: number) => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isNaN(value) ? fallback : value;
  };
  return {
    dotAlphaHigh: number("--cloud-dot-hi", 0.9),
    dotAlphaLow: number("--cloud-dot-lo", 0.18),
    dotColor: `rgb(${style.getPropertyValue("--cloud-dot-rgb").trim() || "255, 255, 255"})`,
    stars: style.getPropertyValue("--cloud-stars").trim() === "1",
  };
}

/** Draws one still frame. The caller sets the canvas size and transform. */
export function drawClouds(
  context: CanvasRenderingContext2D,
  {
    anchor = "left",
    clearUntil = 0,
    height,
    offset = 0,
    palette,
    width,
  }: CloudOptions
) {
  const stars: number[] = [];
  context.clearRect(0, 0, width, height);
  context.fillStyle = palette.dotColor;

  let row = 0;
  for (let y = GAP / 2; y < height; y += GAP) {
    let column = 0;
    // `from` counts from the anchored edge, so the grid and the clouds both
    // stay put relative to it.
    for (let from = GAP / 2; from < width; from += GAP) {
      const x = anchor === "right" ? width - from : from;
      const density = cloud(from * SCALE + offset, y * SCALE * 1.7);
      const open =
        clearUntil > 0 ? smoothstep((x - clearUntil) / CLEAR_FEATHER) : 1;
      const k = smoothstep((density - CLOUD_FLOOR) / CLOUD_FEATHER) * open;

      const starSeed = hash(column + 991, row + 337);
      if (palette.stars && k < 0.25 && starSeed > 1 - STAR_CHANCE) {
        stars.push(x, y, starSeed, 1 - k * 4);
      } else {
        context.globalAlpha =
          palette.dotAlphaLow +
          k * (palette.dotAlphaHigh - palette.dotAlphaLow);
        context.beginPath();
        context.arc(x, y, 0.7 + k * 4.3, 0, FULL_CIRCLE);
        context.fill();
      }
      column += 1;
    }
    row += 1;
  }

  context.fillStyle = "#FFFFFF";
  for (let i = 0; i < stars.length; i += 4) {
    const seed = stars[i + 2] ?? 0;
    // The website's twinkle, held at its first moment.
    const twinkle = 0.55 + 0.45 * Math.sin(seed * 40);
    context.globalAlpha = twinkle * (stars[i + 3] ?? 0) * STAR_PEAK_ALPHA;
    context.beginPath();
    context.arc(stars[i] ?? 0, stars[i + 1] ?? 0, STAR_RADIUS, 0, FULL_CIRCLE);
    context.fill();
  }
  context.globalAlpha = 1;
}
