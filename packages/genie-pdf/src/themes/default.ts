import { createTw } from "react-pdf-tailwind";

export const tw = createTw({
  theme: {
    extend: {
      colors: {
        primary: "#1a365d",
        secondary: "#2d3748",
        accent: "#3182ce",
        muted: "#718096",
      },
      fontFamily: {
        sans: ["Helvetica"],
        mono: ["Courier"],
      },
    },
  },
});

export const themeConfig = {
  name: "default",
  colors: {
    text: "#1a202c",
    heading: "#1a365d",
    link: "#3182ce",
    code: "#2d3748",
    codeBg: "#f7fafc",
    border: "#e2e8f0",
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
