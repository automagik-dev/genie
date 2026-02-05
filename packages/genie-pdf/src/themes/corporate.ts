import { createTw } from "react-pdf-tailwind";

export const tw = createTw({
  theme: {
    extend: {
      colors: {
        primary: "#0f172a",
        secondary: "#334155",
        accent: "#0284c7",
        muted: "#64748b",
      },
    },
  },
});

export const themeConfig = {
  name: "corporate",
  colors: {
    text: "#1e293b",
    heading: "#0f172a",
    link: "#0284c7",
    code: "#334155",
    codeBg: "#f1f5f9",
    border: "#cbd5e1",
  },
  fonts: {
    body: "Helvetica",
    heading: "Helvetica-Bold",
    mono: "Courier",
  },
  spacing: {
    page: 45,
    paragraph: 14,
    heading: 22,
  },
};

export default themeConfig;
