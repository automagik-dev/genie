import type { ThemeConfig } from "./index.js";

export const glassTheme: ThemeConfig = {
  name: "glass",
  colors: {
    primary: "#6366f1",       // Indigo
    secondary: "#8b5cf6",     // Purple
    text: "#1e293b",          // Slate 800
    heading: "#0f172a",       // Slate 900
    link: "#6366f1",          // Indigo
    border: "rgba(148, 163, 184, 0.4)",  // Slate with transparency
    background: "#f8fafc",    // Slate 50
    codeBg: "rgba(241, 245, 249, 0.8)",  // Frosted code bg
    code: "#475569",          // Slate 600
    accent: "#ec4899",        // Pink accent
    muted: "#64748b",         // Slate 500
    cardBg: "rgba(255, 255, 255, 0.7)", // Glass card
    gradientStart: "#6366f1", // Indigo
    gradientEnd: "#8b5cf6",   // Purple
  },
  fonts: {
    body: "Helvetica",
    heading: "Helvetica-Bold",
    mono: "Courier",
  },
  spacing: {
    page: 36,
    paragraph: 10,
    heading: 16,
  },
};

export default glassTheme;
