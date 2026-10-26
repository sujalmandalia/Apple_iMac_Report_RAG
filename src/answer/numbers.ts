// Citations like "[Table, p. 12]" and markers like "[^18]" contain digits that are not claims.
const NOT_CLAIMS = /\[[^\]]*\bpp?\.\s*\d[^\]]*\]|\[\^\d+\]|\bEndnote \d+/gi;
const NUMBER = /(?<![\w.])\d[\d,]*(?:\.\d+)?/g;

const normalize = (n: string) => String(Number(n.replace(/,/g, "")));

export function numbersIn(text: string): string[] {
  return [...new Set((text.replace(NOT_CLAIMS, " ").match(NUMBER) ?? []).map(normalize))];
}

/**
 * Every number in the answer should appear in the sources. A number that does not is either a calculation
 * (445 − 346 = 99 is fine, but it is not quoted) or a hallucination; either way the reader should know.
 */
export function unverifiedNumbers(answer: string, sourcesText: string): string[] {
  const known = new Set(numbersIn(sourcesText));
  return numbersIn(answer).filter((n) => !known.has(n));
}
