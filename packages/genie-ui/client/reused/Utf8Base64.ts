// ===========================================================================
// REUSED VERBATIM from dash (syv-ai/dash, MIT) — origin: src/renderer/terminal/Utf8Base64.ts
// (salvaged via ~/prod/genie-ui-ab/dash-fork/fleet/web/reused/Utf8Base64.ts).
// Unmodified except this provenance header.
// ===========================================================================
import type { IBase64 } from '@xterm/addon-clipboard';

/**
 * UTF-8-aware base64 codec for xterm's ClipboardAddon (OSC 52 copy/paste).
 *
 * The addon's default codec relies on btoa/atob which treat the payload as
 * Latin-1 (one char per byte). That double-encodes multi-byte characters
 * (CJK, accented Latin, box-drawing, emoji) on copy and throws on paste of
 * non-Latin selections. Routing through TextEncoder/TextDecoder treats the
 * payload as a real UTF-8 byte stream — matching the OSC 52 spec and native
 * terminals.
 */
export class Utf8Base64 implements IBase64 {
  encodeText(data: string): string {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  decodeText(data: string): string {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
