import defaultTheme from "./default.js";
import minimalTheme from "./minimal.js";
import corporateTheme from "./corporate.js";
import darkTheme from "./dark.js";

export type ThemeConfig = {
  name: string;
  colors: {
    text: string;
    heading: string;
    link: string;
    code: string;
    codeBg: string;
    border: string;
    background?: string;
  };
  fonts: {
    body: string;
    heading: string;
    mono: string;
  };
  spacing: {
    page: number;
    paragraph: number;
    heading: number;
  };
};

export const themes: Record<string, ThemeConfig> = {
  default: defaultTheme,
  minimal: minimalTheme,
  corporate: corporateTheme,
  dark: darkTheme,
};

export function getTheme(name: string): ThemeConfig {
  const theme = themes[name];
  if (!theme) {
    console.warn(`Theme "${name}" not found, using default`);
    return themes["default"]!;
  }
  return theme;
}

export function listThemes(): string[] {
  return Object.keys(themes);
}

export default themes;
