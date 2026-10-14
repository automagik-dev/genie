"""
gemini_batteries.py — Gemini 3 native batteries for mikro.

Provides Gemini-powered functions available in the REPL when provider is Google:
  - web_search(query) — Google Search grounding via IPC
  - fetch_url(url) — URL Context via IPC
  - generate_image(prompt, **kwargs) — Image generation via IPC

These functions communicate with the parent Node.js process via the same
IPC mechanism used by llm_query(). The parent routes the request to the
appropriate Gemini API endpoint via onPayload hooks.

Available when --tools standard or --tools full with provider: google.
Non-Google providers get clear error messages.
"""

import llm_bridge


def web_search(query: str) -> str:
    """Search the web using Google Search grounding.

    Returns search results as text. Only available with provider: google.
    """
    results = llm_bridge.send_request("web_search", [query])
    return results[0] if results else "Error: no response from web_search"


def fetch_url(url: str) -> str:
    """Fetch content from a URL using Gemini URL Context.

    Returns page content as text. Only available with provider: google.
    """
    results = llm_bridge.send_request("fetch_url", [url])
    return results[0] if results else "Error: no response from fetch_url"


def generate_image(prompt: str, aspect_ratio: str = "16:9", size: str = "2K") -> str:
    """Generate an image from a text prompt.

    Returns the path to the saved image file, or an error message.
    Only available with provider: google.
    """
    full_prompt = f"{prompt} [aspect_ratio={aspect_ratio}, size={size}]"
    results = llm_bridge.send_request("generate_image", [full_prompt])
    return results[0] if results else "Error: no response from generate_image"
