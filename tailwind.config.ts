import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        // Bento palette — extends, doesn't replace, the default ramp so utilities like `bg-cream` work everywhere.
        bg: 'hsl(var(--color-bg) / <alpha-value>)',
        ink: 'hsl(var(--color-ink) / <alpha-value>)',
        ink2: 'hsl(var(--color-ink2) / <alpha-value>)',
        dim: 'hsl(var(--color-dim) / <alpha-value>)',
        paper: 'hsl(var(--color-paper) / <alpha-value>)',
        cream: 'hsl(var(--color-cream) / <alpha-value>)',
        sage: 'hsl(var(--color-sage) / <alpha-value>)',
        'sage-ink': 'hsl(var(--color-sage-ink) / <alpha-value>)',
        coral: 'hsl(var(--color-coral) / <alpha-value>)',
        'coral-ink': 'hsl(var(--color-coral-ink) / <alpha-value>)',
        sky: 'hsl(var(--color-sky) / <alpha-value>)',
        'sky-ink': 'hsl(var(--color-sky-ink) / <alpha-value>)',
        lemon: 'hsl(var(--color-lemon) / <alpha-value>)',
        'lemon-ink': 'hsl(var(--color-lemon-ink) / <alpha-value>)',
        pink: 'hsl(var(--color-pink) / <alpha-value>)',
        'pink-ink': 'hsl(var(--color-pink-ink) / <alpha-value>)',
        plum: 'hsl(var(--color-plum) / <alpha-value>)',
        purple: 'hsl(var(--color-purple) / <alpha-value>)',
        'purple-ink': 'hsl(var(--color-purple-ink) / <alpha-value>)',
        // Semantic surfaces
        surface: {
          base: 'hsl(var(--color-bg) / <alpha-value>)',
          raised: 'hsl(var(--color-paper) / <alpha-value>)',
          sunken: 'hsl(var(--color-sunken) / <alpha-value>)',
          ink: 'hsl(var(--color-ink) / <alpha-value>)',
        },
        // shadcn-style aliases so generated components compile cleanly.
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        xs: ['11px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '20px' }],
        lg: ['16px', { lineHeight: '22px' }],
        xl: ['20px', { lineHeight: '26px' }],
        '2xl': ['24px', { lineHeight: '30px' }],
        '3xl': ['32px', { lineHeight: '38px' }],
        '4xl': ['48px', { lineHeight: '52px' }],
        '5xl': ['64px', { lineHeight: '68px' }],
        display: ['80px', { lineHeight: '80px', letterSpacing: '-0.03em' }],
      },
      spacing: {
        // 4px baseline scale on top of Tailwind's default
        '0.5': '2px',
        '1': '4px',
        '1.5': '6px',
        '2': '8px',
        '2.5': '10px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '7': '28px',
        '8': '32px',
        '10': '40px',
        '12': '48px',
        '16': '64px',
        '20': '80px',
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
        full: '9999px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(21, 20, 15, 0.06)',
        sm: '0 2px 6px rgba(21, 20, 15, 0.06), 0 1px 2px rgba(21, 20, 15, 0.04)',
        md: '0 6px 16px rgba(21, 20, 15, 0.08), 0 2px 4px rgba(21, 20, 15, 0.04)',
        lg: '0 18px 40px rgba(21, 20, 15, 0.12), 0 6px 12px rgba(21, 20, 15, 0.06)',
        xl: '0 30px 80px rgba(21, 20, 15, 0.18), 0 12px 24px rgba(21, 20, 15, 0.08)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 200ms ease-out',
        'accordion-up': 'accordion-up 200ms ease-out',
        'fade-in': 'fade-in 150ms ease-out',
      },
    },
  },
  plugins: [animate],
};

export default config;
