export interface Route {
  kind: "broad" | "specific";
  reason: string;
}

const BROAD_PATTERNS: [RegExp, string][] = [
  [/\b(summar(y|ise|ize)|overview|outline|gist|tl;?dr|in a nutshell)\b/i, "asks for a summary"],
  [
    /\b(main|key|overall|central|big[- ]picture|major|biggest)\s+(\w+\s+){0,2}(messages?|themes?|takeaways?|findings?|points?|highlights?|claims?|achievements?)\b/i,
    "asks for main points",
  ],
  [/\bwhat (is|does) (this|the) report\b.*\b(about|say|cover)\b/i, "asks what the report covers"],
  [/\b(sections|structure|contents) of (the|this) report\b/i, "asks about the report's structure"],
];

// Cheap regex routing: no LLM call. The report is short enough that a broad question gets the whole report.
export function routeQuestion(question: string): Route {
  const broad = BROAD_PATTERNS.find(([re]) => re.test(question));
  return broad ? { kind: "broad", reason: broad[1] } : { kind: "specific", reason: "specific question" };
}
