/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f7f7fa',
        surface: '#ffffff',
        sidebar: '#1c1d28',
        sidebarHover: '#2a2b38',
        primary: '#6c5cf2',
        primaryHover: '#5a48ec',
        ink: '#111827',
        muted: '#6b7280',
        border: '#e5e7eb'
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 1px 1px rgba(16,24,40,0.03)'
      }
    }
  },
  plugins: []
};
