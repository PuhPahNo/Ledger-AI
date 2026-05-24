// Design tokens — single source of truth shared with tailwind.config.ts.
// Most styling now flows through Tailwind utilities backed by these tokens.
// Raw exports remain for SVG draw code (Donut, Sparkline) and the few places
// that still need a JS color string.

export const colors = {
  bg:        '#eceae3',
  ink:       '#15140f',
  ink2:      '#3a382e',
  dim:       '#7b7868',
  paper:     '#ffffff',
  cream:     '#f7f3e6',
  sunken:    '#f3efe7',
  sage:      '#abc89a',
  sageInk:   '#274020',
  coral:     '#ff8b6b',
  coralInk:  '#54170a',
  sky:       '#9fc6e8',
  skyInk:    '#0a3454',
  lemon:     '#ecd95a',
  lemonInk:  '#3a2f00',
  pink:      '#f1b6c5',
  pinkInk:   '#4a0e22',
  plum:      '#3e2a3e',
  purple:    '#caa6f0',
  purpleInk: '#2b0d4a',
} as const;

export type ColorToken = keyof typeof colors;

export const fonts = {
  sans:    '"Inter", -apple-system, system-ui, sans-serif',
  display: '"Space Grotesk", Inter, sans-serif',
  mono:    '"IBM Plex Mono", ui-monospace, monospace',
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  tile: 20,
  pill: 9999,
} as const;

export const shadows = {
  xs: '0 1px 2px rgba(21, 20, 15, 0.06)',
  sm: '0 2px 6px rgba(21, 20, 15, 0.06), 0 1px 2px rgba(21, 20, 15, 0.04)',
  md: '0 6px 16px rgba(21, 20, 15, 0.08), 0 2px 4px rgba(21, 20, 15, 0.04)',
  lg: '0 18px 40px rgba(21, 20, 15, 0.12), 0 6px 12px rgba(21, 20, 15, 0.06)',
  xl: '0 30px 80px rgba(21, 20, 15, 0.18), 0 12px 24px rgba(21, 20, 15, 0.08)',
} as const;

/** Same accent ramp the categories donut and tiles draw from. */
export const accentRamp = [
  colors.coral,
  colors.sky,
  colors.plum,
  colors.sage,
  colors.pink,
  colors.purple,
  colors.cream,
] as const;
