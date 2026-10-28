import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Role } from "../shared.js";

export interface SourceDocument {
  id: string;
  title: string;
  access: Role;
  body: string;
}

const FrontMatter = z.object({ title: z.string().min(1), access: z.enum(["employee", "hr"]) });

export function parseDocument(id: string, raw: string): SourceDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`Document ${id} is missing front matter.`);
  }
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  const meta = FrontMatter.parse(fields);
  return { id, title: meta.title, access: meta.access, body: match[2]!.replace(/\r\n/g, "\n") };
}

export async function loadCorpus(directory: string): Promise<SourceDocument[]> {
  const files = (await readdir(directory)).filter(name => name.endsWith(".md")).sort();
  return Promise.all(files.map(async name => parseDocument(name.slice(0, -3), await readFile(path.join(directory, name), "utf8"))));
}

// HR can read everything; employees can read only employee documents.
export function canAccess(role: Role, access: Role): boolean {
  return access === "employee" || role === "hr";
}
