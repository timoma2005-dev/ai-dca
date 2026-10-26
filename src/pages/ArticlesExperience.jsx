import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  ARTICLES_URL,
  ARTICLES_ORIGIN,
  articleSlugFromFramePath,
  buildArticleFrameUrl,
  buildParentUrlWithArticle,
  clampFrameHeight,
  readArticleSlugFromSearch,
  readFrameHeightMessage,
  resolveArticlesBase,
} from './articles/articleUrlSync.js';

export { ARTICLES_URL };

// 公众号文章存档：仍用 iframe 承载同站静态 HTML（不改 SSR），但
// - 当前文章 slug 同步到父页面 ?article=，支持深链与浏览器后退；
// - 同源时按内容高度撑开 iframe，避免双滚动条；跨域时退回固定高度内部滚动；
// - 提供「新窗口打开原文」。
export function ArticlesExperience() {
  const base = useMemo(() => (typeof window === 'undefined' ? ARTICLES_URL : resolveArticlesBase(window.location)), []);
  const [frameSrc] = useState(() => buildArticleFrameUrl(base, typeof window === 'undefined' ? '' : readArticleSlugFromSearch(window.location.search)));
  const [slug, setSlug] = useState(() => (typeof window === 'undefined' ? '' : readArticleSlugFromSearch(window.location.search)));
  const [frameHeight, setFrameHeight] = useState(null);
  const [frameTitle, setFrameTitle] = useState('公众号历史文章');
  const frameRef = useRef(null);
  const sectionRef = useRef(null);
  const observerRef = useRef(null);
  const loadedOnceRef = useRef(false);

  const measure = useCallback(() => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (!doc?.documentElement) return false;
      setFrameHeight(clampFrameHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0)));
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleLoad = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    let sameOrigin = false;
    try {
      const frameWindow = frameRef.current?.contentWindow;
      const nextSlug = articleSlugFromFramePath(frameWindow?.location?.pathname || '');
      const docTitle = frameWindow?.document?.title;
      sameOrigin = true;
      setSlug(nextSlug);
      if (docTitle) setFrameTitle(`公众号文章：${docTitle}`);
      // iframe 内跳转本身已产生一条浏览器历史，这里用 replaceState 只同步地址，后退由浏览器联合历史处理。
      const nextUrl = buildParentUrlWithArticle(window.location.href, nextSlug);
      if (nextUrl) window.history.replaceState(window.history.state, '', nextUrl);
      if (typeof ResizeObserver !== 'undefined' && frameWindow?.document?.body) {
        const observer = new ResizeObserver(() => measure());
        observer.observe(frameWindow.document.body);
        observerRef.current = observer;
      }
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin || !measure()) setFrameHeight(null);
    if (loadedOnceRef.current) {
      const top = sectionRef.current?.getBoundingClientRect?.().top;
      if (Number.isFinite(top) && top < 0) sectionRef.current.scrollIntoView({ block: 'start' });
    }
    loadedOnceRef.current = true;
  }, [measure]);

  useEffect(() => {
    function handleMessage(event) {
      const height = readFrameHeightMessage(event, [window.location.origin, ARTICLES_ORIGIN]);
      if (height) setFrameHeight(clampFrameHeight(height));
    }
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      observerRef.current?.disconnect();
    };
  }, []);

  const originalHref = useMemo(() => {
    const target = buildArticleFrameUrl(base, slug);
    try { return new URL(target, typeof window === 'undefined' ? ARTICLES_URL : window.location.href).toString(); } catch { return target; }
  }, [base, slug]);

  const autoHeight = Number.isFinite(frameHeight) && frameHeight > 0;

  return (
    <section ref={sectionRef} className="w-full" aria-label="公众号历史文章">
      <div className="mb-2 flex items-center justify-end">
        <a
          href={originalHref}
          target="_blank"
          rel="noopener noreferrer"
          className="touch-target inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          新窗口打开原文
        </a>
      </div>
      <div
        className={autoHeight
          ? 'w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm'
          : 'h-[calc(100vh-10rem)] min-h-[560px] w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:h-[calc(100vh-8rem)] sm:min-h-[640px]'}
      >
        <iframe
          ref={frameRef}
          title={frameTitle}
          src={frameSrc}
          onLoad={handleLoad}
          className="block w-full border-0"
          style={autoHeight ? { height: `${frameHeight}px` } : { height: '100%' }}
          scrolling={autoHeight ? 'no' : undefined}
          loading="eager"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
}
