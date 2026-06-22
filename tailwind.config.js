/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#071a2e",
        sidebar: "#0a2340",
        accent: "#0e3a6e",
        highlight: "#38bdf8",
        surface: "#0d2a45",
        border: "#1a4060",
        text: {
          primary: "#e0f2fe",
          secondary: "#7dd3fc",
          muted: "#38607a",
        },
      },
    },
  },
  plugins: [],
};
