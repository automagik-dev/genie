import { Command } from "commander";
import { renderMarkdownToPDF, renderTemplateToPDF } from "./render.js";
import { listThemes, getTheme } from "./themes/index.js";

const program = new Command();

program
  .name("genie-pdf")
  .description("CLI tool for generating beautiful PDFs from markdown")
  .version("0.1.0");

// Render command
program
  .command("render")
  .description("Render a markdown file to PDF")
  .argument("<input>", "Input markdown file")
  .option("-o, --output <file>", "Output PDF file", "output.pdf")
  .option("-t, --theme <name>", "Theme to use (default, minimal, corporate, dark)")
  .option("--no-page-numbers", "Disable page numbers")
  .option("-w, --watch", "Watch for changes and re-render")
  .action(async (input: string, options) => {
    try {
      console.log(`📄 Rendering ${input} to ${options.output}...`);

      if (options.watch) {
        console.log("👀 Watching for changes...");
        const file = Bun.file(input);

        // Initial render
        await renderMarkdownToPDF({
          input,
          output: options.output,
          theme: options.theme,
          showPageNumbers: options.pageNumbers,
        });
        console.log(`✅ Generated ${options.output}`);

        // Watch for changes
        const watcher = require("fs").watch(input, async () => {
          try {
            console.log(`🔄 File changed, re-rendering...`);
            await renderMarkdownToPDF({
              input,
              output: options.output,
              theme: options.theme,
              showPageNumbers: options.pageNumbers,
            });
            console.log(`✅ Updated ${options.output}`);
          } catch (err) {
            console.error(`❌ Error:`, err);
          }
        });

        // Keep process running
        process.on("SIGINT", () => {
          watcher.close();
          process.exit(0);
        });
      } else {
        await renderMarkdownToPDF({
          input,
          output: options.output,
          theme: options.theme,
          showPageNumbers: options.pageNumbers,
        });
        console.log(`✅ Generated ${options.output}`);
      }
    } catch (error) {
      console.error(`❌ Error:`, error);
      process.exit(1);
    }
  });

// Template command
program
  .command("template")
  .description("Generate PDF from a template with JSON data")
  .argument("<name>", "Template name (report, invoice, research, resume)")
  .option("-d, --data <file>", "JSON data file")
  .option("-o, --output <file>", "Output PDF file", "output.pdf")
  .option("-t, --theme <name>", "Theme to use")
  .action(async (name: string, options) => {
    try {
      console.log(`📋 Using template: ${name}`);

      let data = {};
      if (options.data) {
        const dataFile = Bun.file(options.data);
        data = await dataFile.json();
      }

      const theme = getTheme(options.theme || "default");

      await renderTemplateToPDF(name, data, options.output, theme);
      console.log(`✅ Generated ${options.output}`);
    } catch (error) {
      console.error(`❌ Error:`, error);
      process.exit(1);
    }
  });

// List themes
program
  .command("themes")
  .description("List available themes")
  .action(() => {
    console.log("Available themes:");
    for (const theme of listThemes()) {
      console.log(`  • ${theme}`);
    }
  });

// List templates
program
  .command("templates")
  .description("List available templates")
  .action(() => {
    const templates = ["report", "invoice", "research", "resume"];
    console.log("Available templates:");
    for (const template of templates) {
      console.log(`  • ${template}`);
    }
  });

export { program };
