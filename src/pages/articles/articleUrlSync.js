// 文章页 iframe 与父页面 URL 同步（审计 batch2 #19）。
// 文章存档是同站静态 HTML（/wechat/），在 cn/fast 域名下用同源相对路径加载，
// 父页面才能读取 iframe 的路径与高度；其它域名退回绝对地址（跨域时不读 iframe 内部）。
export const ARTICLES_ORIGIN = 'https://fast.freebacktrack.tech';
export const ARTICLES_PATH = '/wechat/';
export const ARTICLES_URL = `${ARTICLES_ORIGIN}${ARTICLES_PATH}`;
export const ARTICLE_QUERY_KEY = 'article';

const SAME_SITE_HOSTS = new Set(['fast.freebacktrack.tech', 'cn.freebacktrack.tech']);

export function resolveArticlesBase(locationLike) {
  const host = String(locationLike?.hostname || '').toLowerCase();
  return SAME_SITE_HOSTS.has(host) ? ARTICLES_PATH : ARTICLES_URL;
}

// slug 是 /wechat/ 下的相对路径，只允许文章目录、索引页，拒绝协议、绝对路径和 ..。
export function normalizeArticleSlug(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  try { text = decodeURIComponent(text); } catch { return ''; }
  text = text.replace(/^\/+/, '').replace(/[?#].*$/, '');
  if (!text || /[\\<>"]/.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) return '';
  const parts = text.split('/');
  if (parts.some((part) => part === '..' || part === '.')) return '';
  if (text === 'index.html') return '';
  if (/^by-date\.html$/.test(text)) return text;
  const match = /^articles\/([^/]+)(?:\/(?:index\.html)?)?$/.exec(text);
  return match ? `articles/${match[1]}/` : '';
}

export function articleSlugFromFramePath(pathname) {
  const path = String(pathname || '');
  const idx = path.indexOf(ARTICLES_PATH);
  if (idx < 0) return '';
  return normalizeArticleSlug(path.slice(idx + ARTICLES_PATH.length));
}

export function buildArticleFrameUrl(base, slug) {
  const safe = normalizeArticleSlug(slug);
  if (!safe) return base;
  return `${base}${safe.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

export function readArticleSlugFromSearch(search) {
  try {
    return normalizeArticleSlug(new URLSearchParams(search || '').get(ARTICLE_QUERY_KEY) || '');
  } catch {
    return '';
  }
}

// 返回带/去掉 ?article= 的父页面 URL（保留其它 query 与 hash）；无变化时返回 ''。
export function buildParentUrlWithArticle(href, slug) {
  let url;
  try { url = new URL(href); } catch { return ''; }
  const safe = normalizeArticleSlug(slug);
  const current = url.searchParams.get(ARTICLE_QUERY_KEY) || '';
  if (normalizeArticleSlug(current) === safe && (safe || !url.searchParams.has(ARTICLE_QUERY_KEY))) return '';
  if (safe) url.searchParams.set(ARTICLE_QUERY_KEY, safe);
  else url.searchParams.delete(ARTICLE_QUERY_KEY);
  return url.toString();
}

export function clampFrameHeight(value, { min = 480, max = 200000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return min;
  return Math.min(max, Math.max(min, Math.ceil(n)));
}

// 允许文章页（若日后加入）通过 postMessage 上报高度；只接受同源/文章源的消息。
export function readFrameHeightMessage(event, allowedOrigins = []) {
  if (!event || !allowedOrigins.includes(event.origin)) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'wechat-article:height') return null;
  const height = Number(data.height);
  return Number.isFinite(height) && height > 0 ? height : null;
}
