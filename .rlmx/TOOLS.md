<!-- TOOLS.md — Custom Python Tools for the RLM REPL
     Define custom Python functions that get injected into the REPL
     namespace and described in the system prompt. The LLM can call
     these functions during its iterative reasoning.

     Format: each tool is a level-2 heading (## name) followed by
     a python code block with the function definition.

     Example — a summarization helper:

     ## summarize_chunk

     ```python
     def summarize_chunk(text, max_words=100):
         """Summarize a chunk of text to max_words."""
         return llm_query(f"Summarize in {max_words} words:\n{text}")
     ```

     Tools have access to all REPL built-ins:
     - llm_query(prompt, model=None)
     - llm_query_batched(prompts, model=None)
     - rlm_query(prompt, model=None)
     - rlm_query_batched(prompts, model=None)
     - context (the loaded context data)
     - Any standard Python library

     Add your tools below this comment block. -->
