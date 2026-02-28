/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
	],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        background: "#000000",
        foreground: "#FFFFFF",
        card: "#0A0A0A",
        popover: "#0A0A0A",
        primary: {
          DEFAULT: "#0055FF",
          foreground: "#FFFFFF",
        },
        secondary: {
          DEFAULT: "#111111",
          foreground: "#FFFFFF",
        },
        muted: {
          DEFAULT: "#1A1A1A",
          foreground: "#737373",
        },
        accent: {
          DEFAULT: "#0055FF",
          foreground: "#FFFFFF",
        },
        destructive: {
          DEFAULT: "#FF0000",
          foreground: "#FFFFFF",
        },
        border: "#1A1A1A",
        input: "#0A0A0A",
        ring: "#0055FF",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "28px",
        "2xl": "36px",
        "pill": "9999px",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
      boxShadow: {
        'brutalist': '4px 4px 0px 0px rgba(0, 85, 255, 1)',
      }
    },
  },
  plugins: [],
}
