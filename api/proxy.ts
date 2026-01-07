import * as cheerio from "cheerio";
import { VercelRequest, VercelResponse } from "@vercel/node";

interface Post {
  title: string;
  link: string;
  image: string;
  type: "movie" | "series";
  year?: string;
}

interface StreamLink {
  server: string;
  link: string;
  type: "m3u8" | "mp4" | "mkv";
  quality?: string;
  headers?: Record<string, string>;
}

interface DownloadLink {
  title: string;
  quality: string;
  language: string;
  size: string;
  episode?: string;
  season?: string;
  links: { name: string; url: string }[];
}

interface MetaResult {
  title: string;
  synopsis: string;
  image: string;
  year: string;
  type: "movie" | "series";
  downloadLinks: DownloadLink[];
}

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cached?: boolean;
  timestamp: number;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = {
  providerUrls: null as CacheEntry<Record<string, { name: string; url: string }>> | null,
  posts: new Map<string, CacheEntry<Post[]>>(),
  meta: new Map<string, CacheEntry<MetaResult>>(),
  streams: new Map<string, CacheEntry<StreamLink[]>>(),
};

const CACHE_TTL = {
  providerUrls: 10 * 60 * 1000,
  posts: 5 * 60 * 1000,
  meta: 30 * 60 * 1000,
  streams: 15 * 60 * 1000,
};

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number): { data: T; cached: boolean } | null {
  const entry = map.get(key);
  if (entry && Date.now() - entry.timestamp < ttl) {
    return { data: entry.data, cached: true };
  }
  return null;
}

function setCache<T>(map: Map<string, CacheEntry<T>>, key: string, data: T): void {
  if (map.size > 1000) {
    const oldest = [...map.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) map.delete(oldest[0]);
  }
  map.set(key, { data, timestamp: Date.now() });
}

const defaultHeaders: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchHtml(url: string, options: { timeout?: number; headers?: Record<string, string> } = {}): Promise<string | null> {
  const { timeout = 15000, headers = {} } = options;
  console.log(`[FETCH] ${url}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const res = await fetch(url, {
      headers: { ...defaultHeaders, ...headers },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return res.ok ? await res.text() : null;
  } catch (e) {
    console.error(`[FETCH ERROR] ${url}:`, e);
    return null;
  }
}

async function fetchJson<T>(url: string, options: { headers?: Record<string, string> } = {}): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { ...defaultHeaders, ...options.headers },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function extractYear(text: string): string | undefined {
  const match = text.match(/\((\d{4})\)|\b(20[0-2]\d|19\d{2})\b/);
  return match ? match[1] || match[0] : undefined;
}

function getContentType(title: string, link: string): "movie" | "series" {
  const keywords = ["season", "episode", "s0", "s1", "series", "web series", "ep"];
  return keywords.some(k => (title + link).toLowerCase().includes(k)) ? "series" : "movie";
}

function streamType(url: string): "m3u8" | "mp4" | "mkv" {
  const u = url.toLowerCase();
  if (u.includes(".m3u8")) return "m3u8";
  if (u.includes(".mp4")) return "mp4";
  return "mkv";
}

function decodeBase64(value: string | undefined): string {
  if (!value) return "";
  try {
    return atob(value);
  } catch {
    return "";
  }
}

function extractEpisodeInfo(text: string): { episode?: string; season?: string } {
  const patterns = [
    /S(\d+)\s*E(\d+)/i,
    /Season\s*(\d+)\s*Episode\s*(\d+)/i,
    /Episode\s*(\d+)/i,
    /E(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match.length >= 3
        ? { season: match[1], episode: match[2] }
        : { episode: match[1] };
    }
  }
  return {};
}

async function pixeldrainExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];

  try {
    console.log("[PIXELDRAIN]", url);

    const fileId = url.match(/\/u\/([a-zA-Z0-9]+)/)?.[1] ||
                   url.match(/\/api\/file\/([a-zA-Z0-9]+)/)?.[1];

    if (fileId) {
      const info = await fetchJson<{ name: string; size: number; mime_type: string }>(
        `https://pixeldrain.com/api/file/${fileId}/info`
      );

      const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;

      streams.push({
        server: "Pixeldrain",
        link: directUrl,
        type: info?.mime_type?.includes("video") ? "mp4" : "mkv",
        quality: "HD",
      });
    }

    console.log("[PIXELDRAIN] Found:", streams.length);
  } catch (e) {
    console.error("[PIXELDRAIN ERROR]", e);
  }

  return streams;
}

async function streamtapeExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];

  try {
    console.log("[STREAMTAPE]", url);

    const html = await fetchHtml(url);
    if (!html) return streams;

    const linkMatch = html.match(/getElementById\('robotlink'\)\.innerHTML\s*=\s*['"]([^'"]+)['"]/);
    const tokenMatch = html.match(/token=([^&'"]+)/);

    if (linkMatch) {
      let videoUrl = linkMatch[1];
      if (tokenMatch) {
        videoUrl = `https:${videoUrl}&token=${tokenMatch[1]}`;
      } else {
        videoUrl = `https:${videoUrl}`;
      }

      streams.push({
        server: "Streamtape",
        link: videoUrl,
        type: "mp4",
        quality: "HD",
      });
    }

    const altMatch = html.match(/document\.getElementById\('norobotlink'\)\.innerHTML\s*=\s*['"](\/\/[^'"]+)['"]\s*\+\s*\('([^']+)'\)/);
    if (altMatch && streams.length === 0) {
      const videoUrl = `https:${altMatch[1]}${altMatch[2]}`;
      streams.push({
        server: "Streamtape",
        link: videoUrl,
        type: "mp4",
        quality: "HD",
      });
    }

    console.log("[STREAMTAPE] Found:", streams.length);
  } catch (e) {
    console.error("[STREAMTAPE ERROR]", e);
  }

  return streams;
}

async function doodstreamExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];

  try {
    console.log("[DOODSTREAM]", url);

    const normalizedUrl = url.replace(/dood\.(wf|cx|la|pm|so|ws|sh|to|re|yt)/, "dood.li");

    const html = await fetchHtml(normalizedUrl);
    if (!html) return streams;

    const passMatch = html.match(/\/pass_md5\/([^'"]+)/);
    if (passMatch) {
      const passUrl = `https://dood.li/pass_md5/${passMatch[1]}`;

      const passRes = await fetchHtml(passUrl, {
        headers: { Referer: normalizedUrl },
      });

      if (passRes) {
        const token = "zUEJeL3mUN" + Math.random().toString(36).substring(2);
        const videoUrl = `${passRes}${token}?token=${passMatch[1].split("/").pop()}&expiry=${Date.now()}`;

        streams.push({
          server: "Doodstream",
          link: videoUrl,
          type: "mp4",
          quality: "HD",
          headers: { Referer: "https://dood.li/" },
        });
      }
    }

    console.log("[DOODSTREAM] Found:", streams.length);
  } catch (e) {
    console.error("[DOODSTREAM ERROR]", e);
  }

  return streams;
}

async function filemoonExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];

  try {
    console.log("[FILEMOON]", url);

    const html = await fetchHtml(url);
    if (!html) return streams;

    const fileMatch = html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)/i) ||
                     html.match(/sources\s*:\s*\[\{file\s*:\s*["']([^"']+)/i);

    if (fileMatch) {
      streams.push({
        server: "Filemoon",
        link: fileMatch[1],
        type: "m3u8",
        quality: "HD",
      });
    }

    const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi);
    if (m3u8Match && streams.length === 0) {
      streams.push({
        server: "Filemoon",
        link: m3u8Match[0],
        type: "m3u8",
        quality: "HD",
      });
    }

    console.log("[FILEMOON] Found:", streams.length);
  } catch (e) {
    console.error("[FILEMOON ERROR]", e);
  }

  return streams;
}

async function mixdropExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];

  try {
    console.log("[MIXDROP]", url);

    const html = await fetchHtml(url);
    if (!html) return streams;

    const wurlMatch = html.match(/MDCore\.wurl\s*=\s*["']([^"']+)/);

    if (wurlMatch) {
      let videoUrl = wurlMatch[1];
      if (videoUrl.startsWith("//")) videoUrl = "https:" + videoUrl;

      streams.push({
        server: "Mixdrop",
        link: videoUrl,
        type: "mp4",
        quality: "HD",
      });
    }

    console.log("[MIXDROP] Found:", streams.length);
  } catch (e) {
    console.error("[MIXDROP ERROR]", e);
  }

  return streams;
}

async function hubcloudExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];
  const processed = new Set<string>();

  try {
    console.log("[HUBCLOUD]", url);

    const baseUrl = url.split("/").slice(0, 3).join("/");
    const html = await fetchHtml(url);
    if (!html) return streams;

    const $ = cheerio.load(html);

    const redirect = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/) ||
                     html.match(/location\.replace\(['"]([^'"]+)['"]\)/) ||
                     html.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);

    let targetHtml = html;

    if (redirect?.[1]) {
      let target = redirect[1];
      if (target.includes("r=")) {
        target = decodeBase64(target.split("r=")[1]) || target;
      }
      if (target.startsWith("/")) target = baseUrl + target;
      if (!target.startsWith("http")) target = baseUrl + "/" + target;

      console.log("[HUBCLOUD REDIRECT]", target);
      const newHtml = await fetchHtml(target);
      if (newHtml) targetHtml = newHtml;
    }

    const $target = cheerio.load(targetHtml);

    const selectors = [
      ".btn-success.btn-lg",
      ".btn-success",
      ".btn-danger",
      ".btn-primary",
      ".btn-secondary",
      'a[href*="pixeldrain"]',
      'a[href*="workers.dev"]',
      'a[href*="hubcdn"]',
      'a[href*="cloudflarestorage"]',
      'a[href*="r2.dev"]',
      'a[href*=".mp4"]',
      'a[href*=".mkv"]',
      'a[href*=".m3u8"]',
    ];

    for (const sel of selectors) {
      $target(sel).each((_, el) => {
        let href = $target(el).attr("href") || "";
        if (!href || href === "#" || href === "javascript:void(0)" || processed.has(href)) return;
        processed.add(href);

        console.log("[HUBCLOUD LINK]", href.slice(0, 80));

        if (href.includes("workers.dev") || (href.includes(".dev") && !href.includes("/?id="))) {
          streams.push({ server: "CfWorker", link: href, type: "mkv", quality: "HD" });
        } else if (href.includes("pixeldrain")) {
          const token = href.split("/").pop()?.split("?")[0];
          if (token && !href.includes("/api/file/")) {
            href = `https://pixeldrain.com/api/file/${token}?download`;
          }
          streams.push({ server: "Pixeldrain", link: href, type: "mkv", quality: "HD" });
        } else if (href.includes("cloudflarestorage") || href.includes("r2.dev") || href.includes("r2.cloudflarestorage")) {
          streams.push({ server: "CfStorage", link: href, type: "mkv", quality: "HD" });
        } else if (href.includes("hubcdn") && !href.includes("/?id=")) {
          streams.push({ server: "HubCdn", link: href, type: "mkv", quality: "HD" });
        } else if (/\.(mp4|mkv|m3u8)/i.test(href)) {
          streams.push({ server: "Direct", link: href, type: streamType(href), quality: "HD" });
        }
      });
    }

    const directUrls = targetHtml.match(/https?:\/\/[^\s"'<>]+\.(mp4|mkv|m3u8)[^\s"'<>]*/gi) || [];
    for (const u of directUrls) {
      if (!processed.has(u) && !u.includes("example") && !u.includes("sample")) {
        processed.add(u);
        streams.push({ server: "Direct", link: u, type: streamType(u), quality: "HD" });
      }
    }

    console.log("[HUBCLOUD] Found:", streams.length);
  } catch (e) {
    console.error("[HUBCLOUD ERROR]", e);
  }

  return streams;
}

async function gdflixExtractor(url: string): Promise<StreamLink[]> {
  const streams: StreamLink[] = [];
  const processed = new Set<string>();

  try {
    console.log("[GDFLIX]", url);

    const baseUrl = url.split("/").slice(0, 3).join("/");
    const html = await fetchHtml(url);
    if (!html) return streams;

    let $ = cheerio.load(html);

    const redirect = html.match(/location\.replace\(['"]([^'"]+)['"]\)/) ||
                     html.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);

    if (redirect?.[1]) {
      const target = redirect[1].startsWith("http") ? redirect[1] : baseUrl + redirect[1];
      console.log("[GDFLIX REDIRECT]", target);
      const newHtml = await fetchHtml(target);
      if (newHtml) $ = cheerio.load(newHtml);
    }

    const selectors = [
      ".btn-outline-success",
      ".btn-success",
      ".btn-danger",
      ".btn-primary",
      'a[href*="cloudflarestorage"]',
      'a[href*="r2.dev"]',
      'a[href*="pixeldrain"]',
      'a[href*="workers.dev"]',
      'a[href*="streamtape"]',
      'a[href*="dood"]',
      'a[href*="filemoon"]',
      'a[href*="mixdrop"]',
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const href = $(el).attr("href") || "";
        const text = $(el).text().toLowerCase();

        if (!href || href === "#" || processed.has(href)) return;
        processed.add(href);

        console.log("[GDFLIX LINK]", href.slice(0, 80));

        if (href.includes("cloudflarestorage") || href.includes("r2.dev")) {
          streams.push({ server: "R2Storage", link: href, type: "mkv", quality: "HD" });
        } else if (href.includes("pixeldrain")) {
          const token = href.split("/").pop()?.split("?")[0];
          const directUrl = token ? `https://pixeldrain.com/api/file/${token}?download` : href;
          streams.push({ server: "Pixeldrain", link: directUrl, type: "mkv", quality: "HD" });
        } else if (href.includes("workers.dev")) {
          streams.push({ server: "CfWorker", link: href, type: "mkv", quality: "HD" });
        } else if (text.includes("fast") || text.includes("gdrive")) {
          const fullUrl = href.startsWith("http") ? href : baseUrl + href;
          streams.push({ server: "FastDL", link: fullUrl, type: "mkv", quality: "HD" });
        }
      });
    }

    const hubLink = $('a:contains("V-Cloud")').attr("href") ||
                    $('a:contains("HubCloud")').attr("href") ||
                    $('a:contains("Hub-Cloud")').attr("href") ||
                    $('a[href*="hubcloud"]').attr("href") ||
                    $('a[href*="vcloud"]').attr("href");

    if (hubLink && !processed.has(hubLink)) {
      console.log("[GDFLIX -> HUBCLOUD]", hubLink);
      const hubStreams = await hubcloudExtractor(hubLink);
      streams.push(...hubStreams);
    }

    $("a[href^='http']").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (processed.has(href)) return;

      if (href.includes("streamtape")) {
        processed.add(href);
        streams.push({ server: "Streamtape", link: href, type: "mp4", quality: "HD" });
      } else if (href.includes("dood")) {
        processed.add(href);
        streams.push({ server: "Doodstream", link: href, type: "mp4", quality: "HD" });
      } else if (href.includes("filemoon")) {
        processed.add(href);
        streams.push({ server: "Filemoon", link: href, type: "m3u8", quality: "HD" });
      } else if (href.includes("mixdrop")) {
        processed.add(href);
        streams.push({ server: "Mixdrop", link: href, type: "mp4", quality: "HD" });
      }
    });

    const directUrls = $.html()?.match(/https?:\/\/[^\s"'<>]+\.(mp4|mkv|m3u8)[^\s"'<>]*/gi) || [];
    for (const u of directUrls) {
      if (!processed.has(u) && !u.includes("example")) {
        processed.add(u);
        streams.push({ server: "Direct", link: u, type: streamType(u), quality: "HD" });
      }
    }

    console.log("[GDFLIX] Found:", streams.length);
  } catch (e) {
    console.error("[GDFLIX ERROR]", e);
  }

  return streams;
}

async function resolveLink(url: string): Promise<StreamLink[]> {
  const cached = getCached(cache.streams, url, CACHE_TTL.streams);
  if (cached) return cached.data;

  const lowerUrl = url.toLowerCase();
  let streams: StreamLink[] = [];

  if (lowerUrl.includes("pixeldrain")) {
    streams = await pixeldrainExtractor(url);
  } else if (lowerUrl.includes("streamtape")) {
    streams = await streamtapeExtractor(url);
  } else if (lowerUrl.includes("dood")) {
    streams = await doodstreamExtractor(url);
  } else if (lowerUrl.includes("filemoon")) {
    streams = await filemoonExtractor(url);
  } else if (lowerUrl.includes("mixdrop")) {
    streams = await mixdropExtractor(url);
  } else if (lowerUrl.includes("gdflix") || lowerUrl.includes("nexdrive")) {
    streams = await gdflixExtractor(url);
  } else if (lowerUrl.includes("hubcloud") || lowerUrl.includes("vcloud")) {
    streams = await hubcloudExtractor(url);
  } else {
    streams = await hubcloudExtractor(url);
    if (streams.length === 0) {
      streams = await gdflixExtractor(url);
    }
  }

  const deepResolved: StreamLink[] = [];
  for (const stream of streams) {
    if (stream.server === "Streamtape" && !stream.link.includes("get_video")) {
      const resolved = await streamtapeExtractor(stream.link);
      if (resolved.length > 0) {
        deepResolved.push(...resolved);
      } else {
        deepResolved.push(stream);
      }
    } else if (stream.server === "Doodstream" && !stream.link.includes("pass_md5")) {
      const resolved = await doodstreamExtractor(stream.link);
      if (resolved.length > 0) {
        deepResolved.push(...resolved);
      } else {
        deepResolved.push(stream);
      }
    } else if (stream.server === "Filemoon" && !stream.link.includes(".m3u8")) {
      const resolved = await filemoonExtractor(stream.link);
      if (resolved.length > 0) {
        deepResolved.push(...resolved);
      } else {
        deepResolved.push(stream);
      }
    } else if (stream.server === "Mixdrop" && !stream.link.includes("delivery")) {
      const resolved = await mixdropExtractor(stream.link);
      if (resolved.length > 0) {
        deepResolved.push(...resolved);
      } else {
        deepResolved.push(stream);
      }
    } else {
      deepResolved.push(stream);
    }
  }

  const finalStreams = deepResolved.length > 0 ? deepResolved : streams;

  if (finalStreams.length > 0) {
    setCache(cache.streams, url, finalStreams);
  }

  return finalStreams;
}

const PROVIDER_URLS_SOURCE = "https://raw.githubusercontent.com/himanshu8443/providers/main/modflix.json";

async function getProviderUrls(): Promise<Record<string, { name: string; url: string }>> {
  if (cache.providerUrls && Date.now() - cache.providerUrls.timestamp < CACHE_TTL.providerUrls) {
    return cache.providerUrls.data;
  }

  try {
    const data = await fetchJson<Record<string, { name: string; url: string }>>(PROVIDER_URLS_SOURCE);
    if (data) {
      cache.providerUrls = { data, timestamp: Date.now() };
      return data;
    }
  } catch (e) {
    console.error("[PROVIDER URLS ERROR]", e);
  }

  return {
    Vega: { name: "vegamovies", url: "https://vegamovies.gt" },
    Moviesmod: { name: "Moviesmod", url: "https://moviesmod.build" },
  };
}

function getBaseUrl(provider: string, urls: Record<string, { name: string; url: string }>): string {
  const mappings: Record<string, string> = {
    vega: "Vega", vegamovies: "Vega",
    mod: "Moviesmod", moviesmod: "Moviesmod",
    multi: "multi", uhd: "UhdMovies",
  };

  for (const [key, val] of Object.entries(urls)) {
    if (key.toLowerCase() === provider.toLowerCase() ||
        val.name.toLowerCase() === provider.toLowerCase()) {
      return val.url.replace(/\/$/, "");
    }
  }

  const mapped = mappings[provider.toLowerCase()];
  if (mapped && urls[mapped]) {
    return urls[mapped].url.replace(/\/$/, "");
  }

  return urls.Vega?.url?.replace(/\/$/, "") || "https://vegamovies.gt";
}

async function scrapePosts(baseUrl: string, path: string): Promise<{ posts: Post[]; cached: boolean }> {
  const cacheKey = `${baseUrl}${path}`;
  const cached = getCached(cache.posts, cacheKey, CACHE_TTL.posts);
  if (cached) return { posts: cached.data, cached: true };

  const html = await fetchHtml(`${baseUrl}${path}`);
  if (!html) return { posts: [], cached: false };

  const $ = cheerio.load(html);
  const posts: Post[] = [];
  const seen = new Set<string>();

  $("article, .post, .result-item").each((_, el) => {
    const $el = $(el);

    let title = $el.find("h2 a, h3 a, .entry-title a").first().text().trim() ||
                $el.find("a").first().attr("title") || "";

    let link = $el.find("h2 a, h3 a, .entry-title a").first().attr("href") || "";

    if (link.startsWith("http")) {
      try { link = new URL(link).pathname; } catch {}
    }

    const image = $el.find("img").first().attr("data-src") ||
                  $el.find("img").first().attr("src") || "";

    if (!title || !link || seen.has(link) || link === "/" || link === "#") return;
    seen.add(link);

    posts.push({
      title: title.trim(),
      link,
      image,
      type: getContentType(title, link),
      year: extractYear(title),
    });
  });

  if (posts.length > 0) {
    setCache(cache.posts, cacheKey, posts);
  }

  return { posts, cached: false };
}

async function scrapeMeta(baseUrl: string, link: string): Promise<{ meta: MetaResult; cached: boolean }> {
  const cacheKey = `${baseUrl}${link}`;
  const cached = getCached(cache.meta, cacheKey, CACHE_TTL.meta);
  if (cached) return { meta: cached.data, cached: true };

  const html = await fetchHtml(`${baseUrl}${link}`);
  if (!html) {
    return {
      meta: { title: "Error", synopsis: "", image: "", year: "", type: "movie", downloadLinks: [] },
      cached: false,
    };
  }

  const $ = cheerio.load(html);
  const downloadLinks: DownloadLink[] = [];

  $("h3").each((_, h3) => {
    const header = $(h3).text().trim();
    const qualityMatch = header.match(/(\d{3,4}p|4K|2160p)/i);
    if (!qualityMatch) return;

    const quality = qualityMatch[1].toUpperCase();
    const sizeMatch = header.match(/\[([^\]]*GB[^\]]*)\]/i) || header.match(/(\d+\.?\d*\s*GB)/i);
    const epInfo = extractEpisodeInfo(header);
    const links: { name: string; url: string }[] = [];

    $(h3).next().find("a[href^='http']").each((_, a) => {
      const url = $(a).attr("href") || "";
      const name = $(a).text().trim() || "Download";
      if (url) links.push({ name, url });
    });

    $(h3).next().find(".dwd-button").each((_, btn) => {
      const url = $(btn).parent().attr("href") || $(btn).attr("href") || "";
      const name = $(btn).text().trim() || "Download";
      if (url && url.startsWith("http")) links.push({ name, url });
    });

    if (links.length > 0) {
      downloadLinks.push({
        title: header.slice(0, 100),
        quality,
        language: "English",
        size: sizeMatch?.[1] || "",
        ...epInfo,
        links,
      });
    }
  });

  if (downloadLinks.length === 0) {
    const domains = ["hubcloud", "gdflix", "nexdrive", "vcloud", "hubdrive"];

    $("a[href^='http']").each((_, a) => {
      const url = $(a).attr("href") || "";
      if (!domains.some(d => url.toLowerCase().includes(d))) return;

      const text = $(a).closest("p, div, li").text() || "";
      const qualityMatch = text.match(/(\d{3,4}p|4K)/i);
      const quality = qualityMatch ? qualityMatch[1].toUpperCase() : "HD";

      const existing = downloadLinks.find(g => g.quality === quality);
      if (existing) {
        if (!existing.links.find(l => l.url === url)) {
          existing.links.push({ name: $(a).text().trim() || "Download", url });
        }
      } else {
        downloadLinks.push({
          title: text.slice(0, 100),
          quality,
          language: "English",
          size: "",
          links: [{ name: $(a).text().trim() || "Download", url }],
        });
      }
    });
  }

  const pageText = $(".entry-content, article").text().toLowerCase();
  let language = "English";
  if (pageText.includes("dual audio")) language = "Dual Audio";
  else if (pageText.includes("hindi")) language = "Hindi";
  downloadLinks.forEach(d => d.language = language);

  const meta: MetaResult = {
    title: $("h1, .entry-title").first().text().trim() || "Unknown",
    synopsis: $(".entry-content > p").first().text().trim().slice(0, 500),
    image: $(".entry-content img, article img").first().attr("src") || "",
    year: extractYear($("h1").first().text()) || "",
    type: getContentType($("h1").first().text() || "", link),
    downloadLinks,
  };

  if (downloadLinks.length > 0) {
    setCache(cache.meta, cacheKey, meta);
  }

  return { meta, cached: false };
}

function jsonResponse<T>(data: T, cached = false, status = 200, res: VercelResponse): void {
  const response: ApiResponse<T> = {
    success: status >= 200 && status < 300,
    data,
    cached,
    timestamp: Date.now(),
  };

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", cached ? "public, max-age=300" : "no-cache");
  res.status(status).json(response);
}

function errorResponse(message: string, status = 400, res: VercelResponse): void {
  const response: ApiResponse = {
    success: false,
    error: message,
    timestamp: Date.now(),
  };

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(status).json(response);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  try {
    const params = req.method === "POST" ? req.body : req.query;

    const { action, provider = "vega", filter, page = "1", query, link } = params as Record<string, string>;

    console.log(`[${new Date().toISOString()}] ${action} | ${provider}`);

    const urls = await getProviderUrls();
    const baseUrl = getBaseUrl(provider, urls);

    const routeAction = action || "catalog";

    switch (routeAction) {
      case "catalog":
      case "categories": {
        return jsonResponse(
          {
            catalog: [
              { title: "Latest", filter: "/" },
              { title: "Page 2", filter: "/page/2" },
              { title: "Page 3", filter: "/page/3" },
              { title: "Page 4", filter: "/page/4" },
              { title: "Page 5", filter: "/page/5" },
            ],
            baseUrl,
            provider,
          },
          false,
          200,
          res
        );
      }

      case "posts":
      case "list": {
        let pagePath = filter || "/";
        const pageNum = parseInt(page) || 1;

        if (pageNum > 1 && !pagePath.includes("page/")) {
          pagePath = pagePath === "/" ? `/page/${pageNum}` : `${pagePath}/page/${pageNum}`;
        }

        const { posts, cached } = await scrapePosts(baseUrl, pagePath);
        return jsonResponse({ posts, page: pageNum, hasMore: posts.length > 0 }, cached, 200, res);
      }

      case "search": {
        if (!query) return errorResponse("Query parameter required", 400, res);
        const { posts, cached } = await scrapePosts(baseUrl, `/?s=${encodeURIComponent(query)}`);
        return jsonResponse({ posts, query }, cached, 200, res);
      }

      case "meta":
      case "detail": {
        if (!link) return errorResponse("Link parameter required", 400, res);
        const { meta, cached } = await scrapeMeta(baseUrl, link);
        return jsonResponse(meta, cached, 200, res);
      }

      case "resolve":
      case "stream": {
        if (!link) return errorResponse("Link parameter required", 400, res);

        const cachedStreams = getCached(cache.streams, link, CACHE_TTL.streams);
        if (cachedStreams) {
          return jsonResponse(
            {
              streams: cachedStreams.data,
              resolved: cachedStreams.data[0]?.link || null,
              type: cachedStreams.data[0]?.type || "embed",
              original: link,
            },
            true,
            200,
            res
          );
        }

        const streams = await resolveLink(link);
        return jsonResponse(
          {
            streams,
            resolved: streams[0]?.link || null,
            type: streams[0]?.type || "embed",
            original: link,
          },
          false,
          200,
          res
        );
      }

      case "providers":
      case "urls": {
        return jsonResponse(urls, false, 200, res);
      }

      case "health":
      case "ping": {
        return jsonResponse(
          {
            status: "ok",
            cacheStats: {
              posts: cache.posts.size,
              meta: cache.meta.size,
              streams: cache.streams.size,
            },
          },
          false,
          200,
          res
        );
      }

      default:
        return errorResponse(`Unknown action: ${routeAction}`, 404, res);
    }
  } catch (e) {
    console.error("[HANDLER ERROR]", e);
    return errorResponse((e as Error).message, 500, res);
  }
}
