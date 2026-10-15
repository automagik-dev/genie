<!-- CRITERIA.md — Code Analysis Output Criteria
     These criteria shape how the LLM formats its FINAL answer
     when analyzing codebases. Focused on actionable, navigable
     responses with file references and code evidence. -->

Provide a clear, well-structured answer that directly addresses the query.
Include file paths with line numbers (e.g., `src/config.ts:42`) for all referenced code.
Show relevant code snippets to support your analysis — quote the actual source, don't paraphrase.
Explain architectural decisions and design patterns when they are relevant to the question.
Flag potential issues: security concerns, performance bottlenecks, unnecessary complexity, or missing error handling.
Be concise but thorough.
