/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cloud: {
          DEFAULT: 'var(--color-cloud)',
          light: 'var(--color-cloud-light)',
          dark: 'var(--color-cloud-dark)',
          hover: 'var(--color-cloud-hover)',
          5: 'var(--color-cloud-5)',
          10: 'var(--color-cloud-10)',
          20: 'var(--color-cloud-20)',
          30: 'var(--color-cloud-30)',
          50: 'var(--color-cloud-50)',
          80: 'var(--color-cloud-80)',
        },
        local: {
          DEFAULT: 'var(--color-local)',
          light: 'var(--color-local-light)',
          dark: 'var(--color-local-dark)',
          hover: 'var(--color-local-hover)',
          5: 'var(--color-local-5)',
          10: 'var(--color-local-10)',
          20: 'var(--color-local-20)',
          30: 'var(--color-local-30)',
          50: 'var(--color-local-50)',
          80: 'var(--color-local-80)',
        },
        surface: {
          primary: 'var(--color-bg-primary)',
          secondary: 'var(--color-bg-secondary)',
          tertiary: 'var(--color-bg-tertiary)',
          elevated: 'var(--color-bg-elevated)',
          hover: 'var(--color-bg-hover)',
        },
        border: {
          primary: 'var(--color-border-primary)',
          secondary: 'var(--color-border-secondary)',
          hover: 'var(--color-border-hover)',
        },
        content: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
          disabled: 'var(--color-text-disabled)',
        },
      },
    },
  },
  plugins: [],
};

