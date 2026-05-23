// Bento color direction — all colors, fonts, and radii in one place.
// Components import from here so palette tweaks ripple everywhere.

export const colors = {
  bg:        '#eceae3',
  ink:       '#15140f',
  ink2:      '#3a382e',
  dim:       '#7b7868',
  paper:     '#ffffff',
  cream:     '#f7f3e6',
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
  tile: 18,
  pill: 99,
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
