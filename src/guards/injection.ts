import { foldForDetection, squash } from "./normalize.js";

export type InjectionCategory = "instruction_override" | "prompt_extraction" | "role_hijack" | "privilege_claim"
  | "exfiltration" | "delimiter_injection" | "obfuscation";

export interface InjectionFinding {
  rule: string;
  category: InjectionCategory;
  weight: number;
}

export interface InjectionResult {
  score: number;
  findings: InjectionFinding[];
}

export interface InjectionSignals {
  removedInvisible?: number;
  hiddenText?: string;
}

interface Rule {
  id: string;
  category: InjectionCategory;
  weight: number;
  pattern: RegExp;
}

export const BLOCK_THRESHOLD = 1;
export const WARN_THRESHOLD = 0.5;

const RULES: Rule[] = [
  { id: "override.ignore_instructions", category: "instruction_override", weight: 1, pattern: /\b(ignore|disregard|forget|override|bypass|abandon)\b[\w\s,'"’-]{0,40}?\b(previous|prior|above|earlier|preceding|all|any|your|the|system|these|those|original|initial|my)\b[\w\s,'"’-]{0,30}?\b(instructions?|rules?|guidelines?|prompts?|directives?|constraints?|guardrails?|programming|restrictions?)\b/i },
  { id: "override.forget_context", category: "instruction_override", weight: 0.6, pattern: /\b(forget|ignore|disregard)\b[\w\s,'"’-]{0,20}?\b(documents?|sources?|context|policies)\b/i },
  { id: "override.new_instructions", category: "instruction_override", weight: 0.6, pattern: /\b(new|updated|real|actual|revised)\s+(instructions?|rules|task|objective|directives?)\s*[:：]/i },
  { id: "override.from_now_on", category: "instruction_override", weight: 0.5, pattern: /\b(from now on|starting now|henceforth|for the rest of (this|the) (conversation|session))\b/i },
  { id: "override.special_mode", category: "instruction_override", weight: 1, pattern: /\b(system|admin|developer|debug|god|maintenance)\s+(override|mode)\b|\bsafety (checks?|filters?) (are |is )?(disabled|off)\b/i },
  { id: "extract.reveal_instructions", category: "prompt_extraction", weight: 1, pattern: /\b(reveal|print|show|display|output|repeat|recite|dump|leak|translate|spell out|write out|tell me)\b[\w\s,'"’-]{0,30}?\b(your|system|initial|hidden|secret|original|internal)\b[\w\s,'"’-]{0,20}?\b(prompts?|instructions?|rules|guidelines|configuration|marker|canary|directives?)\b/i },
  { id: "extract.system_prompt", category: "prompt_extraction", weight: 0.8, pattern: /\b(system|initial|original|hidden|secret|internal)\s+(prompt|instructions?|message|configuration)\b/i },
  { id: "extract.canary", category: "prompt_extraction", weight: 1, pattern: /\b(internal|secret|hidden)\s+(marker|canary|token)\b|\bcanary\b/i },
  { id: "extract.text_above", category: "prompt_extraction", weight: 1, pattern: /\b(repeat|print|output|copy|show)\b[\w\s,'"’-]{0,20}?\b(everything|all|text|words|content)\b[\w\s,'"’-]{0,20}?\b(above|preceding|before this|prior to this)\b/i },
  { id: "extract.instructions_given", category: "prompt_extraction", weight: 1, pattern: /\b(instructions|rules|prompt)\s+(were|have)\s+you\s+(been\s+)?(given|told|provided)\b|\bwhat (were|are) you\b[\w\s]{0,20}?\b(told|instructed|programmed)\b/i },
  { id: "hijack.unrestricted_persona", category: "role_hijack", weight: 1, pattern: /\byou are (now|no longer|free from|not bound)\b|\bact as (an? |the )?(unrestricted|unfiltered|jailbroken|evil|uncensored)\b|\b(do anything now|developer mode|jailbreak|jailbroken|unfiltered mode|evil (assistant|bot|ai))\b/i },
  { id: "hijack.dan", category: "role_hijack", weight: 1, pattern: /\bDAN\b/ },
  { id: "hijack.pretend", category: "role_hijack", weight: 1, pattern: /\b(pretend|imagine|roleplay|role-play|let'?s play|play a game|hypothetically)\b[\w\s,'"’-]{0,60}?\b(no (rules|restrictions|limits|filters)|unrestricted|without (any )?(rules|restrictions|filters|limits)|full access|admin access|hr manager|administrator)\b/i },
  { id: "privilege.role_claim", category: "privilege_claim", weight: 0.6, pattern: /\b(i am|i'm|im|as)\s+(an? |the )?(hr manager|hr admin|hr director|administrator|admin|system admin|ceo|cto|cfo|security officer)\b/i },
  { id: "privilege.disable_controls", category: "privilege_claim", weight: 1, pattern: /\b(override|bypass|disable|ignore|turn off|circumvent)\b[\w\s,'"’-]{0,20}?\b(access control|access restrictions?|permissions?|role checks?|security checks?|guardrails?|safety (checks?|filters?)|filters?)\b/i },
  { id: "exfil.markdown_image", category: "exfiltration", weight: 1, pattern: /!\[[^\]]*\]\(\s*[a-z][a-z0-9+.-]*:/i },
  { id: "exfil.html_resource", category: "exfiltration", weight: 1, pattern: /<\s*(img|script|iframe|object|embed|link)\b/i },
  { id: "exfil.send_to_url", category: "exfiltration", weight: 1, pattern: /\b(send|post|upload|transmit|forward|exfiltrate|leak|write|put|encode)\b[\w\s,'"’-]{0,40}?\b(to|into|via|at|in)\b\s*(this |the |a )?(https?:\/\/|url\b|webhook|endpoint)/i },
  { id: "exfil.send_to_email", category: "exfiltration", weight: 0.6, pattern: /\b(send|post|forward|email|mail)\b[\w\s,'"’-]{0,40}?\b(to|at)\b\s*[\w.+-]+@[\w-]+\.[\w.]+/i },
  { id: "exfil.add_link", category: "exfiltration", weight: 1, pattern: /\b(append|add|include|insert|embed|attach)\b[\w\s,'"’-]{0,30}?\b(link|image|url|pixel|beacon)\b[^\n]{0,40}?https?:\/\//i },
  { id: "delimiter.chat_markup", category: "delimiter_injection", weight: 1, pattern: /<\|?(im_start|im_end|system|endoftext|eot_id|start_header_id)\|?>|\[\/?(INST|SYS|SYSTEM)\]|<\/?(system|source|context|instructions?|assistant)>|\[\[\s*(SOURCE|END)\b/i },
  { id: "delimiter.role_prefix", category: "delimiter_injection", weight: 0.7, pattern: /(^|\n)\s*(ai assistant|system|assistant|developer)\s*:/i },
  { id: "delimiter.fence", category: "delimiter_injection", weight: 0.4, pattern: /<<<|>>>|-{3,}\s*(end|begin) (of )?(system|instructions|prompt)/i }
];

// Applied to text with spaces and punctuation removed, for attacks like "i g n o r e  a l l".
const SQUASHED_RULES: Rule[] = [
  { id: "override.ignore_instructions", category: "instruction_override", weight: 1, pattern: /(ignore|disregard|forget|bypass)(all|any|the|your|previous|prior|above|these|my){0,3}(instructions?|rules|guidelines|prompts?)/ },
  { id: "extract.system_prompt", category: "prompt_extraction", weight: 0.8, pattern: /(systemprompt|initialinstructions|hiddeninstructions)/ },
  { id: "hijack.unrestricted_persona", category: "role_hijack", weight: 1, pattern: /(developermode|doanythingnow|jailbreak)/ }
];

const BASE64 = /(?:[A-Za-z0-9+/]{4}){5,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
const MIXED_SCRIPT = /(?=\p{L}*\p{Script=Latin})(?=\p{L}*[\p{Script=Cyrillic}\p{Script=Greek}])\p{L}+/u;

const LABELS: Record<InjectionCategory, string> = {
  instruction_override: "instruction override",
  prompt_extraction: "prompt extraction",
  role_hijack: "role hijacking",
  privilege_claim: "privilege escalation",
  exfiltration: "data exfiltration",
  delimiter_injection: "delimiter injection",
  obfuscation: "obfuscation"
};

function decodeBase64(blob: string): string | undefined {
  const decoded = Buffer.from(blob, "base64").toString("utf8");
  return /^[\x20-\x7E\s]+$/.test(decoded) && /\s/.test(decoded) ? decoded : undefined;
}

export function detectInjection(text: string, signals: InjectionSignals = {}): InjectionResult {
  const findings = new Map<string, InjectionFinding>();
  const add = (rule: string, category: InjectionCategory, weight: number) => {
    if (!findings.has(rule)) {
      findings.set(rule, { rule, category, weight });
    }
  };
  const scan = (candidate: string, rules: Rule[] = RULES): boolean => {
    let matched = false;
    for (const rule of rules) {
      if (!findings.has(rule.id) && rule.pattern.test(candidate)) {
        add(rule.id, rule.category, rule.weight);
        matched = true;
      }
    }
    return matched;
  };

  scan(text);
  const folded = foldForDetection(text);
  if (scan(folded)) {
    add("obfuscation.character_substitution", "obfuscation", 0.3);
  }
  if (scan(squash(folded), SQUASHED_RULES)) {
    add("obfuscation.spacing", "obfuscation", 0.3);
  }
  for (const blob of text.match(BASE64) ?? []) {
    const decoded = decodeBase64(blob);
    if (decoded !== undefined && scan(decoded)) {
      add("obfuscation.base64", "obfuscation", 0.5);
    }
  }
  if (signals.hiddenText?.trim()) {
    scan(signals.hiddenText);
    add("obfuscation.hidden_text", "obfuscation", 0.5);
  }
  if (signals.removedInvisible) {
    add("obfuscation.invisible_characters", "obfuscation", 0.5);
  }
  if (MIXED_SCRIPT.test(text)) {
    add("obfuscation.mixed_script", "obfuscation", 0.5);
  }
  const list = [...findings.values()];
  return { score: Number(list.reduce((sum, finding) => sum + finding.weight, 0).toFixed(2)), findings: list };
}

export function describeFindings(result: InjectionResult): string {
  return [...new Set(result.findings.map(finding => LABELS[finding.category]))].join(", ");
}
