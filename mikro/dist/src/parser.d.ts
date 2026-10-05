/**
 * Code block extraction + FINAL detection for RLM responses.
 *
 * Extracts ```repl``` code blocks, detects FINAL/FINAL_VAR signals,
 * and formats iteration results for message history.
 */
/** A code block extracted from an LLM response. */
export interface CodeBlock {
    code: string;
    /** Start index in the original response text. */
    start: number;
    /** End index in the original response text. */
    end: number;
}
/** Detected final answer signal. */
export interface FinalSignal {
    type: "final" | "final_var";
    /** The answer text or variable name. */
    value: string;
}
/**
 * Extract ```repl``` code blocks from an LLM response.
 * Matches triple-backtick blocks with the "repl" language identifier.
 */
export declare function extractCodeBlocks(text: string): CodeBlock[];
/**
 * Detect FINAL(answer) or FINAL_VAR(variable_name) in response text.
 * Only matches outside of code blocks (text portions of the response).
 * FINAL_VAR takes priority over FINAL (checked first).
 *
 * Must appear at the start of a line (matching RLM paper behavior).
 */
export declare function detectFinal(text: string, codeBlocks: CodeBlock[]): FinalSignal | null;
/** Result from executing a single code block in the REPL. */
export interface ExecutionResult {
    code: string;
    stdout: string;
    stderr: string;
    variables: string[];
    error?: string;
}
/**
 * Format all iteration execution results for appending to message history.
 * Truncates to MAX_FORMATTED_OUTPUT characters.
 */
export declare function formatIterationResult(executions: ExecutionResult[]): string;
/**
 * Extract the text content (non-thinking, non-tool) from an assistant response.
 */
export declare function extractTextContent(content: Array<{
    type: string;
    text?: string;
}>): string;
//# sourceMappingURL=parser.d.ts.map