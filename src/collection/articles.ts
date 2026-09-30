import type { HttpClient } from "./http.js";
import { CollectionError, issue } from "./types.js";
import type { CollectionIssue, NewsItem } from "./types.js";
import { RESEARCH_FIRMS } from "./extract.js";
import { collapse, decodeEntities, kstDate, mapLimit } from "./text.js";
import type { AsOf } from "./text.js";

export const ARTICLE_MAX_CHARS = 8000;
const ARTICLE_MAX_BYTES = 2 * 1024 * 1024;
const HOST = "https://n.news.naver.com";
const PATH = /^\/(?:mnews\/)?article\/\d+\/\d+$/;
const HEADERS = { accept: "text/html", "user-agent": "yyjs-evidence-collector/1" };
const RELEVANT = ["제품", "시장", "점유율", "성장", "업황", "시황", "규모", "전망", "수요", "출하", "공급", "market", "share"];

/** Fetchable article URL (query/fragment dropped), or null when the item is not a Naver news article. */
export function articleFetchUrl(item: NewsItem): string | null {
  try {
    const u = new URL(item.url);
    if (u.protocol === "https:" && u.hostname === "n.news.naver.com" && PATH.test(u.pathname)) return `${HOST}${u.pathname}`;
  } catch {
    /* fall through to id-based URL */
  }
  const m = /^(\d+):(\d+)$/.exec(item.id);
  return m ? `${HOST}/mnews/article/${m[1]}/${m[2]}` : null;
}

function toIso(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const time = (m[2] as string).length === 5 ? `${m[2]}:00` : (m[2] as string);
  const tz = m[3] ? (m[3] === "Z" || m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`) : "+09:00"; // Naver stamps are KST
  const iso = `${m[1]}T${time}${tz}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function publishedAt(html: string): string | null {
  const meta =
    /<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i.exec(html)?.[1];
  if (meta) return toIso(meta);
  const tag = /<[^>]*_ARTICLE_DATE_TIME[^>]*>/i.exec(html)?.[0];
  const stamp = tag ? /data-date-time=["']([^"']+)["']/i.exec(tag)?.[1] : undefined;
  return stamp ? toIso(stamp) : null;
}

/** Extracts the `dic_area` body. Best effort on malformed markup: an unbalanced element runs to end of document. */
export function parseArticle(html: string): { text: string; truncated: boolean; publishedAt: string | null } | null {
  const open = /<([a-z][a-z0-9]*)\b[^>]*\bid\s*=\s*["']dic_area["'][^>]*>/i.exec(html);
  if (!open) return null;
  const tag = (open[1] as string).toLowerCase();
  const start = open.index + open[0].length;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let end = html.length;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  const cleaned = html
    .slice(start, end)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe|button)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style)\b[\s\S]*$/i, "") // unclosed script/style: drop the remainder
    .replace(/<\/?(?:p|div|br|li|tr|h\d|figure|figcaption|article|section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const text = decodeEntities(cleaned)
    .split("\n")
    .map(collapse)
    .filter(Boolean)
    .join("\n");
  if (!text) return null;
  return { text: text.slice(0, ARTICLE_MAX_CHARS), truncated: text.length > ARTICLE_MAX_CHARS, publishedAt: publishedAt(html) };
}

function score(item: NewsItem, extra: string[]): number {
  const hay = `${item.title} ${item.snippet}`.toLowerCase();
  return RELEVANT.filter((k) => hay.includes(k)).length + 2 * extra.filter((k) => hay.includes(k)).length;
}

/**
 * Rank for market-report articles: a named research firm, market-size / share wording and printed figures
 * (money amounts, percentages, quarters) in the title or snippet.
 */
export function marketArticleScore(item: NewsItem): number {
  const hay = `${item.title} ${item.snippet}`;
  return (RESEARCH_FIRMS.test(hay) ? 4 : 0)
    + (/점유율|market\s*share/i.test(hay) ? 2 : 0)
    + (/시장\s*규모|시장규모|(글로벌|세계|전\s*세계)\s*\S{0,12}\s*(시장\s*)?매출/.test(hay) ? 2 : 0)
    + (/\d[\d,.]*\s*(조|억|만)?\s*(달러|원|위안|엔)/.test(hay) ? 1 : 0)
    + (/\d+(\.\d+)?\s*%/.test(hay) ? 1 : 0)
    + (/\d\s*분기|Q[1-4]/.test(hay) ? 1 : 0);
}

/**
 * Fetches up to `max` article bodies (most relevant first, then most recent) and sets articleText on the items.
 * Each failure is isolated: the item keeps its snippet and a warning issue is returned.
 */
export async function enrichArticles(
  items: NewsItem[],
  o: { http: HttpClient; asOf: AsOf; max: number; keywords: string[]; ttlMs: number; rank?: (item: NewsItem) => number; tried?: Set<string> },
): Promise<CollectionIssue[]> {
  const issues: CollectionIssue[] = [];
  if (o.max <= 0) return issues;
  const extra = o.keywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 2);
  const seen = new Set<string>(o.tried ?? []); // URLs an earlier pass already tried (success or failure)
  const picked = items
    .filter((item) => item.articleText === undefined) // already fetched by an earlier pass
    .map((item) => ({ item, url: articleFetchUrl(item), score: o.rank ? o.rank(item) : score(item, extra) }))
    .filter((x): x is { item: NewsItem; url: string; score: number } => !!x.url && !seen.has(x.url) && !!seen.add(x.url))
    .sort((a, b) => b.score - a.score || Date.parse(b.item.publishedAt) - Date.parse(a.item.publishedAt))
    .slice(0, o.max);
  for (const p of picked) o.tried?.add(p.url);
  await mapLimit(picked, 2, async ({ item, url }) => {
    const warn = (code: string, message: string) => issues.push(issue("naver", code, `Article ${item.id}: ${message}`, "warning"));
    try {
      const html = (await o.http.bytes(url, { headers: HEADERS, maxBytes: ARTICLE_MAX_BYTES, ttlMs: o.ttlMs })).toString("utf8");
      const a = parseArticle(html);
      if (!a) return warn("article_parse_failed", "no readable dic_area body; snippet kept");
      if (a.publishedAt) {
        const ms = Date.parse(a.publishedAt);
        if (ms > o.asOf.cutoffMs) return warn("article_after_asOf", "article page is timestamped after asOf; body discarded");
        if (kstDate(ms) !== kstDate(Date.parse(item.publishedAt))) return warn("article_date_mismatch", "article date differs from the listing date; body discarded");
        item.articlePublishedAt = a.publishedAt;
      }
      item.articleText = a.text;
      item.articleTruncated = a.truncated;
    } catch (e) {
      warn(e instanceof CollectionError ? e.code : "article_failed", `${(e as Error).message}; snippet kept`);
    }
  });
  return issues;
}
