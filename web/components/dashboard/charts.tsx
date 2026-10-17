"use client";

/** Resolves a theme CSS variable (oklch) to an rgba() string by painting it on a 1x1 canvas, so cytoscape can parse it. */
function themeColor(name: string): string {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r},${g},${b},${a / 255})`;
}

type Palette = Record<'destructive' | 'chart1' | 'chart2' | 'chart3' | 'fg' | 'muted' | 'border' | 'bg' | 'card', string>;
export const readPalette = (): Palette => ({
  destructive: themeColor('--destructive'), chart1: themeColor('--chart-1'), chart2: themeColor('--chart-2'), chart3: themeColor('--chart-3'),
  fg: themeColor('--foreground'), muted: themeColor('--muted-foreground'), border: themeColor('--border'), bg: themeColor('--background'), card: themeColor('--card'),
});
