/**
 * Code block extraction + FINAL detection for RLM responses.
 *
 * Extracts ```repl``` code blocks, detects FINAL/FINAL_VAR signals,
 * and formats iteration results for message history.
 */
const MAX_FORMATTED_OUTPUT = 20_000;
// Pre-compiled regexes for FINAL signal detection (used every RLM iteration)
const FINAL_VAR_REGEX = /^\s*FINAL_VAR\((.*?)\)/m;
const FINAL_REGEX = /^\s*FINAL\((.*)\)\s*$/m;
/**
 * Extract ```repl``` code blocks from an LLM response.
 * Matches triple-backtick blocks with the "repl" language identifier.
 */
export function extractCodeBlocks(text) {
    const blocks = [];
    const regex = /```repl\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        blocks.push({
            code: match[1],
            start: match.index,
            end: match.index + match[0].length,
        });
    }
    return blocks;
}
/**
 * Detect FINAL(answer) or FINAL_VAR(variable_name) in response text.
 * Only matches outside of code blocks (text portions of the response).
 * FINAL_VAR takes priority over FINAL (checked first).
 *
 * Must appear at the start of a line (matching RLM paper behavior).
 */
export function detectFinal(text, codeBlocks) {
    // Get text outside code blocks
    const outsideText = getTextOutsideBlocks(text, codeBlocks);
    // Check FINAL_VAR first (higher priority)
    const finalVarMatch = FINAL_VAR_REGEX.exec(outsideText);
    if (finalVarMatch) {
        const varName = finalVarMatch[1].trim().replace(/^["']|["']$/g, "");
        return { type: "final_var", value: varName };
    }
    // Check FINAL
    const finalMatch = FINAL_REGEX.exec(outsideText);
    if (finalMatch) {
        return { type: "final", value: finalMatch[1] };
    }
    return null;
}
/**
 * Get text content outside of code blocks.
 */
function getTextOutsideBlocks(text, blocks) {
    if (blocks.length === 0)
        return text;
    const parts = [];
    let pos = 0;
    for (const block of blocks) {
        if (block.start > pos) {
            parts.push(text.slice(pos, block.start));
        }
        pos = block.end;
    }
    if (pos < text.length) {
        parts.push(text.slice(pos));
    }
    return parts.join("");
}
/**
 * Format a single execution result for inclusion in message history.
 */
function formatSingleExecution(exec) {
    let result = `Code executed:\n\`\`\`python\n${exec.code}\n\`\`\`\n\nREPL output:\n`;
    if (exec.stdout) {
        result += exec.stdout;
    }
    if (exec.stderr) {
        result += `\nStderr: ${exec.stderr}`;
    }
    if (exec.error) {
        result += `\nError: ${exec.error}`;
    }
    if (exec.variables.length > 0) {
        result += `\nVariables: ${exec.variables.join(", ")}`;
    }
    return result;
}
/**
 * Format all iteration execution results for appending to message history.
 * Truncates to MAX_FORMATTED_OUTPUT characters.
 */
export function formatIterationResult(executions) {
    const parts = executions.map(formatSingleExecution);
    let result = parts.join("\n\n---\n\n");
    if (result.length > MAX_FORMATTED_OUTPUT) {
        result =
            result.slice(0, MAX_FORMATTED_OUTPUT) +
                `\n... [truncated to ${MAX_FORMATTED_OUTPUT} chars]`;
    }
    return result;
}
/**
 * Extract the text content (non-thinking, non-tool) from an assistant response.
 */
export function extractTextContent(content) {
    return content
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("");
}
//# sourceMappingURL=parser.js.map