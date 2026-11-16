import { useEffect, useRef, useState } from 'react';

function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

// Arc-style tick feedback: when a live value changes, report 'up' or 'down' for one short flash.
// The first render and non-numeric values never flash, so loading a list stays calm.
export function useValueFlash(value) {
  const previous = useRef(toNumber(value));
  const [flash, setFlash] = useState({ dir: '', key: 0 });

  useEffect(() => {
    const next = toNumber(value);
    const before = previous.current;
    previous.current = next;
    if (next == null || before == null || next === before) return undefined;
    setFlash((current) => ({ dir: next > before ? 'up' : 'down', key: current.key + 1 }));
    const timer = window.setTimeout(() => setFlash((current) => ({ ...current, dir: '' })), 950);
    return () => window.clearTimeout(timer);
  }, [value]);

  return flash;
}
