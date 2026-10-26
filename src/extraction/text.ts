export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[  ]+/g, " ");
}

export interface Vocabulary {
  words: Set<string>;
  hyphenPairs: Set<string>;
}

export function buildVocabulary(lines: string[]): Vocabulary {
  const words = new Set<string>();
  const hyphenPairs = new Set<string>();
  for (const line of lines) {
    // Skip each line's last token: a trailing "antici-" is a line-break artifact, not a word.
    const tokens = line.toLowerCase().match(/[a-z]+(?:-[a-z]+)*-?/g) ?? [];
    for (const token of tokens.slice(0, -1)) {
      const parts = token.split("-").filter(Boolean);
      if (parts.length === 1) words.add(parts[0]!);
      for (let i = 1; i < parts.length; i++) hyphenPairs.add(`${parts[i - 1]}-${parts[i]}`);
    }
  }
  return { words, hyphenPairs };
}

export function joinLines(previous: string, next: string, vocab: Vocabulary): string {
  const broken = /([A-Za-z]+)-$/.exec(previous);
  const continuation = /^[a-z]+/.exec(next);

  if (broken && continuation) {
    const head = broken[1]!.toLowerCase();
    const tail = continuation[0];
    const keepHyphen =
      vocab.hyphenPairs.has(`${head}-${tail}`) ||
      (!vocab.words.has(head + tail) &&
        head.length >= 3 &&
        tail.length >= 3 &&
        vocab.words.has(head) &&
        vocab.words.has(tail));
    return keepHyphen ? previous + next : previous.slice(0, -1) + next;
  }

  if (/[–—/]$/.test(previous)) return previous + next;
  return `${previous} ${next}`;
}

