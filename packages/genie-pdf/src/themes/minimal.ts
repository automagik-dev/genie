import { createTw } from "react-pdf-tailwind";

export const tw = createTw({
  theme: {
    extend: {
      colors: {
        primary: "#000000",
        secondary: "#333333",
        accent: "#666666",
        muted: "#999999",
      },
    },
  },
});

export const themeConfig = {
  name: "minimal",
  colors: {
    text: "#333333",
    heading: "#000000",
    link: "#000000",
    code: "#333333",
    codeBg: "#f5f5f5",
    border: "#e0e0e0",
  },
  fonts: {
    body: "Helvetica",
    heading: "Helvetica-Bold",
    mono: "Courier",
  },
  spacing: {
    page: 50,
    paragraph: 10,
    heading: 16,
  },
};

export default themeConfig;
