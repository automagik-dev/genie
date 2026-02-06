import type { ThemeConfig } from "./index.js";

export const executiveTheme: ThemeConfig = {
  name: "executive",
  colors: {
    primary: "#1a365d",      // Deep navy blue
    secondary: "#2d3748",    // Charcoal
    text: "#1a202c",         // Near black
    heading: "#1a365d",      // Navy for headings
    link: "#2b6cb0",         // Professional blue
    border: "#cbd5e0",       // Light gray
    background: "#ffffff",   // Clean white
    codeBg: "#f7fafc",       // Very light gray
    code: "#2d3748",         // Charcoal for code
    accent: "#c53030",       // Red accent for emphasis
    muted: "#718096",        // Gray for secondary text
  },
  fonts: {
    body: "Helvetica",
    heading: "Helvetica-Bold",
    mono: "Courier",
  },
  spacing: {
    page: 40,
    paragraph: 10,
    heading: 18,
  },
};

export default executiveTheme;
