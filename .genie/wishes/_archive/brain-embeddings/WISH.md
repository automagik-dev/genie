# Wish: brain-embeddings — Gemini Embedding 2, Vector Search, Multimodal

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `brain-embeddings` |
| **Date** | 2026-03-27 |
| **Parent** | [brain-obsidian](../brain-obsidian/WISH.md) |
| **depends-on** | `brain-foundation` |
| **blocks** | `brain-intelligence` (semantic linking needs vectors) |

## Summary

Add Gemini Embedding 2 Preview as the embedding engine. All 8 task types. Multimodal: text, images (PNG/JPEG), video (MP4/MOV ≤120s), audio (MP3/WAV ≤80s), PDF (≤6 pages). pgvector + pg_trgm extensions. RRF fusion (BM25 + vector + trigram). Media processing pipeline (ffmpeg format conversion, frame extraction, audio extraction from video). Matryoshka dimensions (768/1536/3072). Batch API (50% cheaper). Intent detection (regex vs NL vs symbol vs question vs claim).

**After this ships:** `genie brain search` finds meaning, not just keywords. Images, videos, and PDFs are searchable. Cross-modal search works (text query → image result).

## Scope

### IN
- Migration `002-brain-embeddings.sql`: pgvector + pg_trgm extensions, add embedding/media columns to brain_chunks and brain_documents
- `src/lib/brain/embedding.ts` — Gemini Embedding 2 client: all 8 task types, Matryoshka, Batch API, normalization for <3072 dims
- `src/lib/brain/media.ts` — format conversion (ffmpeg), frame extraction, audio extraction from video, derivative files (.desc.md, .transcript.md, .frames/)
- `src/lib/brain/intent.ts` — query intent detection: regex vs NL vs symbol vs question vs claim → route to optimal backend
- Extend `update.ts` — multimodal processing: images, video, audio, PDF. Auto-describe via Gemini Vision. Transcription (Groq → Gemini fallback). Double indexing.
- Extend `search.ts` — vector search (pgvector cosine), trigram (pg_trgm), RRF fusion (4 backends), cross-modal search (--image, --audio, --video), --modality filter, --task code, --intent
- Extend `brain_chunks` — embedding vector(3072), embed_model, embed_task, embed_dims, modality, media_path columns
- Extend `brain_documents` — description column (Gemini Vision auto-descriptions)
- `genie brain search` gains: --semantic, --hybrid, --task, --intent, --image, --audio, --video, --modality, --refs, --outline
- Absorbed from qmd: RRF fusion (~80 lines), search pipeline orchestration (~200 lines)
- Absorbed from grepika: intent detection patterns (~60 lines)

### OUT
- rlmx / analyze (brain-intelligence)
- Wikilinks / link command (brain-intelligence)
- Traces / strategy (brain-observability)
- Full identity (brain-identity-impl)

## Success Criteria

- [ ] pgvector and pg_trgm extensions loaded in pgserve
- [ ] `genie brain update` embeds text chunks via Gemini Embedding 2 (3072 dims stored in pgvector)
- [ ] `genie brain update` processes images (PNG/JPEG), generates .desc.md, embeds image + description
- [ ] `genie brain update` processes video (MP4/MOV ≤120s): embeds raw video, extracts audio separately, transcribes, embeds transcript
- [ ] `genie brain update` processes audio (MP3/WAV ≤80s): embeds raw audio, transcribes, embeds transcript
- [ ] `genie brain update` processes PDF (≤6 pages): embeds raw PDF, extracts text, embeds text chunks
- [ ] Unsupported formats auto-converted (OGG→MP3, WebP→PNG, etc.)
- [ ] `genie brain search "query" --semantic` returns vector cosine results
- [ ] `genie brain search "query" --hybrid` combines BM25 + vector + trigram via RRF
- [ ] `genie brain search screenshot.png` returns cross-modal results (text docs matching image)
- [ ] `genie brain search --task code "how does dispatch work"` uses CODE_RETRIEVAL_QUERY
- [ ] Intent auto-detection: questions → Q&A, claims → FACT_VERIFICATION, docids → similar
- [ ] `genie brain update --estimate` shows cost before processing
- [ ] `genie brain update --budget 0.50` caps spending
- [ ] `genie brain update --batch` uses Batch API (50% cheaper)
- [ ] Matryoshka: --dims flag on init, L2 normalization for <3072
- [ ] `bun run check` passes

## Files to Create/Modify

```
CREATE  repos/genie-brain/src/db/migrations/002-brain-embeddings.sql
CREATE  repos/genie-brain/src/lib/brain/embedding.ts
CREATE  repos/genie-brain/src/lib/brain/media.ts
CREATE  repos/genie-brain/src/lib/brain/intent.ts
MODIFY  repos/genie-brain/src/lib/brain/update.ts          (multimodal processing)
MODIFY  repos/genie-brain/src/lib/brain/search.ts          (vector + trigram + RRF + cross-modal)
MODIFY  repos/genie-brain/package.json                     (add google-genai SDK)

CREATE  repos/genie-brain/src/lib/brain/embedding.test.ts
CREATE  repos/genie-brain/src/lib/brain/media.test.ts
```
