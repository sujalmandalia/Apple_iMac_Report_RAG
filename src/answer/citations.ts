import type { Source } from "./sources.js";

const MARKER = /\[(S\d+(?:\s*,\s*S\d+)*)\]/g;

// The model cites short ids like [S2]; we turn them into page citations ourselves so a citation can never point at a page we didn't send.
export class CitationRewriter {
  private buffer = "";
  readonly cited = new Set<string>();
  readonly invalid = new Set<string>();

  constructor(private sources: Source[]) {}

  private rewrite(text: string): string {
    return text.replace(MARKER, (_, ids: string) => {
      const labels: string[] = [];
      for (const id of ids.split(",").map((s) => s.trim())) {
        const source = this.sources.find((s) => s.id === id);
        if (!source) {
          this.invalid.add(id);
          continue;
        }
        this.cited.add(id);
        if (!labels.includes(source.citation)) labels.push(source.citation);
      }
      return labels.join("");
    });
  }

  push(delta: string): string {
    this.buffer += delta;
    const open = this.buffer.lastIndexOf("[");
    const holdFrom = open >= 0 && !this.buffer.includes("]", open) && this.buffer.length - open < 40 ? open : this.buffer.length;
    const ready = this.buffer.slice(0, holdFrom);
    this.buffer = this.buffer.slice(holdFrom);
    return this.rewrite(ready);
  }

  flush(): string {
    const rest = this.rewrite(this.buffer);
    this.buffer = "";
    return rest;
  }
}
