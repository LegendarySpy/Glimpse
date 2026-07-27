const FEED_URL = "https://tryglimpse.cc/blog.json";
const CACHE_KEY = "glimpse_news_cache";
const LAST_SEEN_KEY = "glimpse_news_last_seen";

export interface NewsItem {
  id: string;
  title: string;
  tag: string;
  description: string;
  date: string;
  publishedAt: string;
  url: string;
  image?: string;
  /// Optional per-locale overrides from the feed, keyed by language tag.
  /// Absent fields fall back to the English ones above.
  i18n?: Record<string, NewsItemTranslation>;
}

export type NewsItemTranslation = Partial<
  Pick<NewsItem, "title" | "tag" | "description" | "date" | "url" | "image">
>;

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

function parseTranslation(raw: unknown): NewsItemTranslation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const translation: NewsItemTranslation = {};

  for (const field of ["title", "tag", "description", "date"] as const) {
    if (typeof entry[field] === "string" && entry[field]) {
      translation[field] = entry[field];
    }
  }
  if (isHttpsUrl(entry.url)) translation.url = entry.url;
  if (isHttpsUrl(entry.image)) translation.image = entry.image;

  return Object.keys(translation).length > 0 ? translation : null;
}

function parseTranslations(
  raw: unknown,
): Record<string, NewsItemTranslation> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  const table: Record<string, NewsItemTranslation> = {};
  for (const [tag, value] of Object.entries(raw as Record<string, unknown>)) {
    const translation = parseTranslation(value);
    if (translation) table[tag.trim().toLowerCase()] = translation;
  }

  return Object.keys(table).length > 0 ? table : undefined;
}

function parseItem(raw: unknown): NewsItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return null;
  if (typeof item.title !== "string" || !item.title) return null;
  if (!isHttpsUrl(item.url)) return null;

  return {
    id: item.id,
    title: item.title,
    tag: str(item.tag),
    description: str(item.description),
    date: str(item.date),
    publishedAt: str(item.publishedAt),
    url: item.url,
    image: isHttpsUrl(item.image) ? item.image : undefined,
    i18n: parseTranslations(item.i18n),
  };
}

/// Applies feed translations for the active locale, exact tag first ("pt-br"),
/// then its base language ("pt"). Untranslated fields stay English.
export function localizeNews(items: NewsItem[], locale: string): NewsItem[] {
  const tag = locale.trim().toLowerCase();
  const base = tag.split(/[-_]/)[0];
  if (!tag) return items;

  return items.map((item) => {
    const translation = item.i18n?.[tag] ?? item.i18n?.[base];
    return translation ? { ...item, ...translation } : item;
  });
}

function parseFeed(raw: unknown): NewsItem[] {
  if (typeof raw !== "object" || raw === null) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items
    .map(parseItem)
    .filter((item): item is NewsItem => item !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function readCache(): NewsItem[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? parseFeed(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeCache(items: NewsItem[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items }));
  } catch {
    // storage unavailable; the fetched items are still good to render
  }
}

export async function fetchNews(): Promise<NewsItem[]> {
  try {
    const response = await fetch(FEED_URL, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return readCache();
    const items = parseFeed(await response.json());
    writeCache(items);
    return items;
  } catch {
    return readCache();
  }
}

export function getLastSeenId(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function setLastSeenId(id: string) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, id);
  } catch {
    // storage unavailable; unread state just won't persist
  }
}
