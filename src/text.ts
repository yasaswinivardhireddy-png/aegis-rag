const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between
both but by can could did do does doing down during each few for from further had has have having he her here hers herself him
himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours
ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those
through to too under until up very was we were what when where which while who whom why will with would you your yours yourself
yourselves also may must per please tell much many get got give need`.split(/\s+/).filter(Boolean));

export function stem(word: string): string {
  let result = word;
  if (result.length > 4 && result.endsWith("ies")) {
    result = `${result.slice(0, -3)}y`;
  } else if (result.length > 3 && result.endsWith("s") && !result.endsWith("ss") && !result.endsWith("us")) {
    result = result.slice(0, -1);
  }
  return result;
}

export function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function contentTerms(text: string): string[] {
  return tokenize(text).filter(token => !STOPWORDS.has(token) && (token.length > 1 || /\d/.test(token))).map(stem);
}

export function normalizeNumber(value: string): string {
  return value.includes(":") ? value : value.replace(/,/g, "").replace(/\.0+$/, "");
}

export function extractNumbers(text: string): string[] {
  return (text.normalize("NFKC").match(/\d+(?:[.,:]\d+)*/g) ?? []).map(normalizeNumber);
}
