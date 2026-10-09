import { useEffect, useState } from 'react';

export type Route = { name: 'board' } | { name: 'play'; id: string } | { name: 'debrief'; id: string; attempt?: number };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'play' && parts[1]) return { name: 'play', id: parts[1] };
  if (parts[0] === 'debrief' && parts[1]) return { name: 'debrief', id: parts[1], attempt: parts[2] ? Number(parts[2]) : undefined };
  return { name: 'board' };
}

export function navigate(to: string) {
  if (location.hash !== to) location.hash = to;
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
