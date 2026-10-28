import type { Role } from "../shared.js";
import type { SourceDocument } from "./corpus.js";

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  section: string;
  access: Role;
  // What a human reader sees: hidden HTML comments removed.
  text: string;
  // Everything in the file, including hidden comments. Only the unguarded baseline indexes this.
  rawText: string;
  hidden: string;
}

const COMMENT = /<!--([\s\S]*?)-->/g;

function pack(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

export function chunkDocument(doc: SourceDocument, maxChars = 900): Chunk[] {
  const sections: { title: string; raw: string }[] = [];
  let title = doc.title;
  let lines: string[] = [];
  for (const line of doc.body.split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      sections.push({ title, raw: lines.join("\n") });
      title = heading[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  sections.push({ title, raw: lines.join("\n") });

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const hidden = [...section.raw.matchAll(COMMENT)].map(match => match[1]!.trim()).join("\n");
    const visible = section.raw.replace(COMMENT, "").trim();
    const parts = visible ? pack(visible, maxChars) : hidden ? [""] : [];
    parts.forEach((part, index) => {
      const sectionHidden = index === 0 ? hidden : "";
      chunks.push({
        id: `${doc.id}#${chunks.length}`,
        docId: doc.id,
        docTitle: doc.title,
        section: section.title,
        access: doc.access,
        text: part,
        rawText: sectionHidden ? `${part}\n${sectionHidden}`.trim() : part,
        hidden: sectionHidden
      });
    });
  }
  return chunks;
}
