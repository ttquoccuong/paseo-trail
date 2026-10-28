import type { SessionLink } from "../shared/links";
import type { Translate } from "./i18n";
import { summary } from "./status-text";

type Section = { heading: Parameters<Translate>[0]; kinds: SessionLink["kind"][] };

const SECTIONS: Section[] = [
  { heading: "command.task", kinds: ["task"] },
  { heading: "command.requests", kinds: ["mr"] },
  { heading: "command.files", kinds: ["file"] },
  { heading: "command.docs", kinds: ["doc"] },
  { heading: "command.other", kinds: ["link"] },
];

// Plain Markdown so the list pastes into a daily report, an MR description or a chat as it is.
export function asMarkdown(links: SessionLink[], t: Translate): string {
  return SECTIONS.flatMap(({ heading, kinds }) => {
    const members = links.filter((link) => kinds.includes(link.kind));
    if (members.length === 0) return [];
    const lines = members.map((link) => {
      const name = link.kind === "file" ? link.title : link.label;
      const target = link.kind === "file" ? `\`${link.title}\`` : `[${name}](${link.url})`;
      const state = link.kind === "mr" ? summary(link.status, t) : "";
      return `- ${target}${state ? ` · ${state}` : ""}`;
    });
    return [`**${t(heading)}**`, ...lines, ""];
  })
    .join("\n")
    .trim();
}

/** A code fence longer than any run of backticks in `text`, so the text cannot close it early. */
export function fenceFor(text: string): string {
  // A loop rather than a pattern: the longest run is found in one pass over any input.
  let longest = 0;
  let run = 0;
  for (const character of text) {
    run = character === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return "`".repeat(Math.max(3, longest + 1));
}
