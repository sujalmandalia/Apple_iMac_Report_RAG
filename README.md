# iMac Environmental Report RAG

A chatbot that answers questions about Apple's *iMac Product Environmental Report (October 2024)*
using only the report, with page citations. The report is short (12 pages) but dense: one chart, three
tables, highlight figures and 19 endnotes that qualify most numbers. Built phase by phase on the same
stack as the World Bank report RAG.

Stack: Node 22 + TypeScript, Express 5, Postgres 14 + pgvector and built-in full-text search,
Gemini (embeddings, answers, and vision for the chart), a local cross-encoder for reranking (later phase)
and a plain HTML/JS frontend (later phase).

## Quick start

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and GEMINI_API_KEY
npm run db:setup            # creates the database, enables pgvector, applies src/db/schema.sql
npm run check:gemini        # embeddings, chat and a vision read of the page 2 chart
npm run extract             # PDF -> data/pages.json (positioned blocks, endnote markers)
npm run structure           # pages -> data/structure.json (sections, elements, endnote links, glossary)
npm run tables              # table elements -> data/tables.json (headers, typed values, checks)
npm run charts              # chart elements -> data/charts.json (1 Gemini vision call, then cached)
npm run chunk               # -> data/chunks.json (chunks + parents)
npm run ingest              # -> Postgres; embeds new or changed chunks only (2 Gemini calls for all 73)
# or every step: npm run pipeline
npm run search -- "idle power at 230V"
npm run eval -- --retriever hybrid --reranker minilm
npm run ask -- "How much power does the iMac use when idle at 230V?" --sources
npm run eval:answers        # one Gemini call per question
npm run chat                # multi-turn chat in the terminal
npm run dev                 # web UI on http://localhost:3000 (set PORT if 3000 is taken)
```

If the vision check returns 503 (model overloaded), run it with `VISION_MODEL=gemini-3.5-flash-lite`
or skip it with `npm run check:gemini -- --no-vision`.

## Ingestion pipeline

| Step | Command | Output |
|---|---|---|
| Extraction: running footer removed, endnote markers rewritten to `[^n]` (raised, glued and definition forms), rows split at wide gaps, aligned-value tables, blocks grown column by column, XY-cut reading order with cards kept together | `npm run extract` | `data/pages.json` |
| Structure: sections (page titles) and subsections (card and sub-headings, by column), typed elements (paragraph, highlight, definition, table, chart, endnote), glossary from Definitions, content after an endnote attached to it (endnote 18 owns the power-mode bullets and power table), every marker linked to the sentence it qualifies | `npm run structure` | `data/structure.json` |
| Tables: cells assigned to columns by x position, staggered header lines merged per column, bullet rows linked to their parent row, values parsed (`↓>20%` = down, more than 20 %), checks (complete rows, breakdown within rounding of 100 %, total = sum of scopes), one self-contained text per row | `npm run tables` | `data/tables.json` |
| Charts: the chart's page is cut out with pdf-lib and read by Gemini vision into JSON (bars, totals, segments, endnotes, notes) with a response schema, validated with zod and cached by source-file hash + prompt (`--force` re-reads; falls back to `CHAT_FALLBACK_MODEL` when the vision model is overloaded). Segment values are then **measured from the PDF's vector shapes** (filled rectangles per bar, dashed outline = reduction, labels assigned by position, scale from the printed totals). Checks: printed totals are in the text layer, bridge adds up, labels exist, endnotes match, one scale fits all bars, measured segments add up to totals | `npm run charts` | `data/charts.json`, `data/charts/<id>.json` (cached reading) |
| Chunking (below) | `npm run chunk` | `data/chunks.json` |
| Storage + embeddings: one transaction syncs `documents`, `parents`, `chunks` (keyed by content hash, so unchanged chunks keep their vectors), `endnotes` (full text + the sentences each qualifies) and `exhibits` (parsed tables and the measured chart as JSON, with `verified`); then pending chunks are embedded with `gemini-embedding-001` (768 dims, `RETRIEVAL_DOCUMENT`, renormalized) in rate-limited, resumable batches | `npm run ingest` | Postgres |

## Retrieval

```
question ─► keyword query expanded with report aliases (GHG, LCA, "switched off" -> Off mode, "sea/rail" -> non-air shipping)
         ─► vector (pgvector HNSW) + keyword (BM25 over tsvector) + exhibit lookup ("table 3", "chart", "endnote 14")
         ─► reciprocal rank fusion -> 24 candidates
         ─► local MiniLM cross-encoder rerank; explicit exhibit/endnote references pinned to the top
         ─► lenient relevance gate (0.002): nothing passes -> "not in the report"
```

`npm run search -- "idle power at 230V" [--type table_row] [--section carbon] [--variant "four ports"]`,
`GET /search?q=...&k=&type=&section=&variant=&mode=&rerank=&parent=`.

### Evaluation (`npm run eval -- --retriever hybrid --reranker minilm`)

`eval/questions.json`: 52 answerable questions in 7 categories (table 12, chart 6, highlight 14, endnote 12,
definition 5, lookup 2, variant 1) and 12 out-of-scope questions. Relevance is judged by page, exhibit, chunk type,
endnote number or contained text, so the set survives re-chunking. Results are saved in `eval/results/`.

| Retriever | hit@1 | recall@3 | recall@5 | MRR | Time / question |
|---|---|---|---|---|---|
| vector | 73.1% | 92.3% | 98.1% | 0.831 | ~0.5 s |
| hybrid (vector + BM25 + lookup) | 80.8% | 92.3% | 96.2% | 0.874 | ~10 ms (cached query vectors) |
| hybrid + bge cross-encoder | 82.7% | 94.2% | 98.1% | 0.891 | ~6.7 s |
| **hybrid + MiniLM** (default, with pinning and aliases) | **80.8%** | **96.2%** | **100%** | **0.890** | ~1.6 s |

Tables, lookups, definitions and the variant question are at 100% hit@1 with MiniLM; charts 66.7%. Most remaining
rank-2 cases are by design: an endnote chunk quotes the claim it qualifies ("More than 15% recycled content" + how it
is calculated), so it can outrank the claim itself; both are in the top 5 and both reach the answer step.

**Relevance gate.** Cross-encoder scores do not separate in-scope from out-of-scope questions cleanly here: terse
table rows can score 0.003 when they are the right answer, while "How long does the iMac battery last?" scores 0.83
because it shares the report's vocabulary. A strict gate would refuse real questions before the model sees the sources,
so the gate is lenient (keeps all 51 answerable non-lookup questions) and the answer step refuses when the sources do
not contain the answer (measured in Phase 8). The eval prints the threshold sweep for any reranker; `RERANKER=llm`
(Gemini, `RERANK_MODEL`, one call per question) is available for comparison.

## Answers

```
question ─► route: broad ("summarize the report") -> the whole report (13 parents) + every endnote they reference
                   specific -> retrieval (above) -> parents within a 6,000-token budget
         ─► every endnote referenced by a source is added as its own source with its full text ([Endnote 14, p. 11])
         ─► nothing passed the gate? -> "not in the report" (no LLM call)
         ─► Gemini writes the answer citing [S1]…, rewritten to [Table, p. 12] / [Chart, p. 2] / [Endnote 18, p. 12] as it streams
         ─► number check: every number in the answer must appear in a source (citations, markers and the report title excluded)
```

Prompt rules specific to this report: copy numbers with units and qualifiers ("more than", "<1%", "↓>20%"); state the
endnote condition behind a figure (configuration, baseline, use period, test setup) and cite the endnote; name the
configuration a figure belongs to and never carry it over to another; present chart segments ("≈") as approximate;
only calculate when asked, showing the inputs.

`npm run ask -- "idle power at 230V?" --sources`, `POST /ask {question, stream?}` (server-sent events: `sources`,
`delta`…, `done` with `cited`, `invalidCitations`, `unverifiedNumbers`, `usage`). `/ask` is rate limited per IP
(`RATE_LIMIT_PER_MINUTE`, default 10).

### Answer evaluation (`npm run eval:answers`)

3 questions per category (18) + all 12 out-of-scope questions, one Gemini call each (4 s apart). Final run on
`gemini-3.5-flash-lite` (`CHAT_MODEL=gemini-3.5-flash-lite npm run eval:answers`, to keep the main model's free quota):

| Metric | Result |
|---|---|
| answered when answerable | 100% (18/18) |
| refused when out of scope | 100% (12/12; 2 by the gate, 10 by the model) |
| answers with citations / invalid citation ids | 100% / 0 |
| cites an expected source | 100% (18/18) |
| reference figures present | 100% (12/12) |
| answers with a number found in no source | 1/30 (the report's own date, since excluded) |

Fixed along the way: tables are not numbered in the report, so sources now carry their exhibit label ("table 3");
refusals are not number-checked; broad answers get the endnotes (a summary had dropped "thermal module copper: four-port
only"). flash-lite at first answered the two-port vs four-port comparison as "not given" and ignored the chart's 22 kg;
`gemini-3.6-flash` answered both correctly from the same sources.

## Chat and web UI

```
message ─► greeting/thanks? -> short reply, no retrieval
        ─► follow-up rewritten into a standalone question from the last 3 exchanges (REWRITE_MODEL, default the
           fallback model): "What assumptions is that number based on?" -> "What assumptions is the 346 kg CO2e
           total carbon footprint of the two-port iMac based on?"
        ─► answer pipeline (above) ─► both turns stored in conversations/messages
```

- Web UI (`npm run dev`, then `/`): streaming answers, clickable citations, conversation history, stop button.
  A citation opens the source panel with an "open page N" link to the PDF (`/report.pdf#page=N`) and, for tables
  and the chart, a preview rendered from the stored exhibit (the chart redrawn to scale, reductions dashed, measured
  values marked ≈, plus whether its checks passed). Answers with numbers found in no source show a warning chip.
- Terminal: `npm run chat`. Rewrite checks: `npm run eval:rewrite` (10/10 on `eval/conversations.json`).
- Endpoints: `POST /chat {message, conversationId?, stream?}`, `GET/DELETE /conversations[/:id]`,
  `GET /exhibits/:key`, `GET /endnotes/:num`, `GET /report.pdf`. `/chat` and `/ask` are rate limited per IP.

### Database

| Table | Holds |
|---|---|
| `documents` | the report: title, product, launch date, glossary, chunk options, embedding model |
| `chunks` | 73 chunks: type, section path, exhibit, `endnotes int[]`, `variants text[]`, pages, context, text, `vector(768)` (HNSW, cosine), generated `tsvector` (GIN) |
| `parents` | 13 parents (9 sections, 3 tables, 1 chart) sent with a matching chunk |
| `endnotes` | 19 endnotes, full text, `used_by` (the sentences each one qualifies) |
| `exhibits` | table-1..3 and chart-1 as JSON with `verified` |

### Chunking strategy

| Chunk type | Unit | Parent (sent to the model with the chunk) |
|---|---|---|
| `text` | paragraphs of one section packed to ~250 tokens (max 400), card/sub-heading written inline ("Longevity: ...") | the whole section |
| `highlight` | one key figure or lead statement ("76% recycled content in fiber packaging") | the whole section |
| `definition` | one glossary term; long ones split at their bullets ("Carbon footprint — Use: ... four-year period ...") | - |
| `table` | the whole table as Markdown | the table |
| `table_row` | one row with title and column headers repeated, plus the endnote bullet defining it ("Mode definition: Idle—Display on: ...") | the table |
| `chart` | the chart's retrieval text (bars, measured segments, notes); never split | page text + chart |
| `endnote` | one endnote; its context lists the sentences it qualifies | - |

Every chunk carries its `[^n]` markers, an `endnotes` list and one summary line per endnote (its first sentence), so a
claim is retrieved together with what qualifies it without the endnote's full text swamping the embedding; the full
endnote is added when answering. Each chunk also records the product `variants` it names (two-port 256GB, four-port 512GB, ...).

Inspection flags: `extract -- --page 10` (blocks with kind, font, bbox and markers), `extract -- --markers`
(every marker with the word it follows; also reports endnotes used but not defined and vice versa),
`structure -- --outline` (every element under its section), `structure -- --endnote 14` (an endnote and the
sentences it qualifies), `structure -- --element e58`, `tables -- --table table-1` (Markdown + checks),
`tables -- --rows` (the per-row texts that will be embedded), `charts` (bars, segments, checks and the chart's retrieval text),
`chunk -- --type table_row`, `chunk -- --section use`, `chunk -- --show c27` (chunks exactly as they will be embedded).

Why the chart is measured rather than read: Gemini read the printed totals, labels and endnotes correctly, but its
segment estimates were far off (Materials 114 kg vs 190 kg measured, Non-air shipping missed entirely, reductions summing
to 80 instead of 99). The vision model is good at structure and printed text, not at reading heights; the vector drawing
has the exact rectangles, and the printed totals give the scale (1.110 kg/pt, the same for both full bars).

## Phases

| # | Phase | What is new compared with the World Bank RAG | Status |
|---|---|---|---|
| 0 | Setup and report reconnaissance ([notes](docs/report-notes.md)) | Vision check, exhibit and endnote inventory | Done |
| 1 | PDF extraction: positioned blocks, running footer removal, **endnote markers kept** as `[^n]` | Markers glued into chart labels | Done |
| 2 | Structure: sections, highlight figures, definitions, **endnote map and marker linking** | Endnotes linked to the claims they qualify | Done |
| 3 | Tables: the 3 tables parsed from positions into JSON rows | One chunk per row | Done |
| 4 | Chart: Gemini vision → JSON for structure, segment values measured from the vector drawing, checked against printed totals and 445 − 99 = 346, cached | Whole phase is new | Done |
| 5 | Chunking: `text`, `highlight`, `definition`, `table`, `table_row`, `chart`, `endnote`; endnote summaries in every chunk that carries a marker | New chunk types | Done |
| 6 | Embeddings and storage (`chunks`, `parents`, `exhibits`, `endnotes`) | New tables | Done |
| 7 | Retrieval: vector + BM25 + exhibit lookup, RRF, rerank, relevance gate; evaluation set | Reused; exhibit/endnote lookups pinned, report aliases | Done |
| 8 | Answers: citations, endnote conditions stated, every number checked against sources, streaming | Full endnotes as sources, number check | Done |
| 9 | Chat memory, web UI with page/exhibit preview, rate limiting | Table/chart previews, PDF page links, number warnings | Done |

## Project layout (grows with each phase)

```
src/config.ts        environment (zod)
src/db               pool, schema.sql
src/services         Gemini client with retry / quota handling
src/extraction       PDF -> positioned spans -> endnote markers -> lines -> blocks -> reading order (pdfjs)
src/structure        sections, typed elements, exhibits, glossary, endnote map and marker -> sentence links
src/tables           table cells -> columns, headers, typed values, consistency checks, row texts, Markdown
src/charts           page cut-out + Gemini vision reading, vector-shape measurement, checks, retrieval text
src/chunking         chunks + parents from structure, tables and charts; endnote summaries; variants
src/ingestion        sync to Postgres in one transaction, resumable embedding
src/search           vector, keyword (BM25), exhibit/endnote lookup, hybrid RRF, rerank, retrieve + gate
src/eval             retrieval metrics (hit@k, recall@k, MRR)
src/answer           routing, sources + full endnotes, citation rewriting, streaming answers, number check
src/chat             conversation store, follow-up rewriting, chat orchestration
src/routes           /health, /search, /ask, /chat, /conversations, /exhibits, /endnotes, /report.pdf
public/              web UI (no build step)
eval/                question set and saved results
scripts/             db-setup, check-gemini, one CLI per phase
docs/                report reconnaissance notes
```

## Known limitations

- Gemini free tier: about 20 answers/day on `gemini-3.6-flash`; after that answers come from `CHAT_FALLBACK_MODEL`,
  which is noticeably weaker at reading tables and the chart from the same sources (see Answer evaluation).
- The relevance gate is lenient by design; out-of-scope questions are refused by the model (12/12 in the eval).
- Chart segment values are measured from the drawing (approximate); only bar totals are printed in the report.
- The report itself is inconsistent about the carbon-footprint configuration (text and table: two ports 256GB;
  endnote 10: two ports 512GB). The answer prompt asks the model to point out such disagreements, not resolve them.
- Extraction rules (chart detection, table alignment, endnote markers) are tuned on this report's layout; another
  Apple environmental report should work with small adjustments, other publishers' PDFs need re-tuning.
- Rate limiting and the quota fallback state are in memory (per process, reset on restart).
