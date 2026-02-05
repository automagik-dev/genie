import { createTw } from "react-pdf-tailwind";

export const tw = createTw({
  theme: {
    extend: {
      colors: {
        primary: "#f8fafc",
        secondary: "#e2e8f0",
        accent: "#60a5fa",
        muted: "#94a3b8",
      },
    },
  },
});

export const themeConfig = {
  name: "dark",
  colors: {
    text: "#e2e8f0",
    heading: "#f8fafc",
    link: "#60a5fa",
    code: "#cbd5e1",
    codeBg: "#1e293b",
    border: "#334155",
    background: "#0f172a",
  },
  fonts: {
    body: "Helvetica",
    heading: "Helvetica-Bold",
    mono: "Courier",
  },
  spacing: {
    page: 40,
    paragraph: 12,
    heading: 20,
  },
};

export default themeConfig;
