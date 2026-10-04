import { useEffect, useState } from 'react';

function applicationUrl(url: URL) {
  return url.origin === location.origin && !url.hash && (
    url.pathname === '/' || url.pathname === '/settings/connections' || /^\/boards\/[^/]+$/u.test(url.pathname)
  );
}

/** Keep the native editor module loaded while moving between application pages. */
export function navigateTo(href: string) {
  const url = new URL(href, location.href);
  if (!applicationUrl(url)) { location.assign(url.href); return; }
  if (url.href === location.href) return;
  history.pushState(null, '', `${url.pathname}${url.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useAppLocation() {
  const [href, setHref] = useState(() => location.href);
  useEffect(() => {
    const changed = () => setHref(location.href);
    const clicked = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self') || link.rel.split(' ').includes('external')) return;
      const url = new URL(link.href, location.href);
      if (!applicationUrl(url)) return;
      event.preventDefault();
      navigateTo(url.href);
    };
    window.addEventListener('popstate', changed);
    document.addEventListener('click', clicked);
    return () => {
      window.removeEventListener('popstate', changed);
      document.removeEventListener('click', clicked);
    };
  }, []);
  return new URL(href);
}
