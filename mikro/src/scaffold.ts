import { writeFile, readFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Available template names */
const AVAILABLE_TEMPLATES = ["default", "code"] as const;

/** Files that each template provides */
const TEMPLATE_FILES: Record<string, string[]> = {
  default: ["mikro.yaml", "SYSTEM.md", "CRITERIA.md", "TOOLS.md"],
  code: ["mikro.yaml", "SYSTEM.md", "CRITERIA.md"],
};

/**
 * Scaffold a .mikro/ directory with template files.
 * Returns list of files that were created.
 */
export async function scaffold(dir: string, template = "default"): Promise<string[]> {
  // Validate template
  if (!AVAILABLE_TEMPLATES.includes(template as typeof AVAILABLE_TEMPLATES[number])) {
    throw new Error(
      `Error: template "${template}" not found. Available: ${AVAILABLE_TEMPLATES.join(", ")}`
    );
  }

  const mikroDir = join(dir, ".mikro");
  await mkdir(mikroDir, { recursive: true });

  const created: string[] = [];
  const templateDir = join(__dirname, "templates", template);
  const files = TEMPLATE_FILES[template];

  for (const file of files) {
    const destPath = join(mikroDir, file);
    if (await fileExists(destPath)) continue;

    const srcPath = join(templateDir, file);
    const content = await readFile(srcPath, "utf-8");
    await writeFile(destPath, content, "utf-8");
    created.push(file);
  }

  // Code template doesn't have its own TOOLS.md — copy from default
  if (template === "code") {
    const toolsDest = join(mikroDir, "TOOLS.md");
    if (!(await fileExists(toolsDest))) {
      const defaultToolsSrc = join(__dirname, "templates", "default", "TOOLS.md");
      const content = await readFile(defaultToolsSrc, "utf-8");
      await writeFile(toolsDest, content, "utf-8");
      created.push("TOOLS.md");
    }
  }

  return created;
}

/**
 * Check if config needs scaffolding (no .mikro/mikro.yaml).
 */
export async function needsScaffold(dir: string): Promise<boolean> {
  return !(await fileExists(join(dir, ".mikro", "mikro.yaml")));
}
