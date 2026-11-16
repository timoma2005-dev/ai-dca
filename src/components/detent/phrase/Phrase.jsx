// Adapted from Detent "Phrase" (detentui.com, MIT): settings written as one sentence.
// Changes: plain JSX, slate/indigo Tailwind colors instead of Detent tokens, the number
// popover holds a typeable input, and an optional suffix (e.g. "%") per number.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

const EASE = [0.3, 0, 0.2, 1];
const PX = 6;
const MENU = 'absolute top-[calc(100%+8px)] z-30 rounded-xl bg-white p-1 text-[13.5px] font-normal leading-normal tracking-normal shadow-[0_0_0_0.5px_rgb(0_0_0/.14),0_2px_4px_rgb(0_0_0/.04),0_16px_36px_-12px_rgb(0_0_0/.25)]';
const MARK = 'relative -mx-0.5 rounded-md px-1 font-semibold text-slate-900 underline decoration-dotted decoration-[1.5px] underline-offset-[5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400';
const OPEN = 'bg-indigo-50 decoration-transparent';
const SHUT = 'decoration-slate-400 hover:decoration-slate-700';

const isChoice = (p) => typeof p !== 'string' && Array.isArray(p.options);
const optionValue = (o) => (typeof o === 'object' ? o.value : o);
const optionLabel = (o) => (typeof o === 'object' ? o.label : o);

function useOutside(open, box, close) {
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => {
      if (!box.current?.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open, box, close]);
}

const fit = (base) => (el) => {
  if (!el) return;
  el.style.translate = `${base} 0`;
  const r = el.getBoundingClientRect();
  const over = r.right - (window.innerWidth - 8);
  const under = 8 - r.left;
  const dx = over > 0 ? -Math.min(over, r.left - 8) : under > 0 ? under : 0;
  if (dx) el.style.translate = `calc(${base} + ${dx}px) 0`;
};
const fitLeft = fit('0px');
const fitMiddle = fit('-50%');

function Word({ part, value, onPick, reduce }) {
  const values = part.options.map(optionValue);
  const at = Math.max(0, values.indexOf(value));
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(at);
  const [w, setW] = useState(null);
  const box = useRef(null);
  const btn = useRef(null);
  const sizer = useRef(null);
  const [close] = useState(() => () => setOpen(false));
  useOutside(open, box, close);

  useLayoutEffect(() => {
    const el = sizer.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setW(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = (n) => {
    onPick(values[n]);
    setOpen(false);
    btn.current?.focus();
  };

  const onKey = (e) => {
    const last = values.length;
    if (!open) {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      setHi(at);
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') setHi((h) => (h + 1) % last);
    else if (e.key === 'ArrowUp') setHi((h) => (h - 1 + last) % last);
    else if (e.key === 'Enter' || e.key === ' ') pick(hi);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      if (e.key === 'Tab') return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const label = optionLabel(part.options[at]);
  return (
    <span ref={box} className="relative inline-block">
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={part.label ? `${part.label}：${label}` : undefined}
        onClick={() => {
          setHi(at);
          setOpen((o) => !o);
        }}
        onKeyDown={onKey}
        className={`${MARK} ${open ? OPEN : SHUT}`}
      >
        <span ref={sizer} aria-hidden className="invisible absolute whitespace-nowrap">{label}</span>
        <motion.span
          className="relative inline-block whitespace-nowrap align-bottom [overflow-x:clip]"
          initial={false}
          animate={{ width: w ?? 'auto' }}
          transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={at}
              className="inline-block"
              initial={reduce ? false : { opacity: 0, y: 8, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={reduce ? undefined : { opacity: 0, y: -8, filter: 'blur(3px)' }}
              transition={{ duration: 0.28, ease: EASE }}
            >
              {label}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            ref={fitLeft}
            role="listbox"
            aria-label={part.label || part.id}
            className={`${MENU} left-[-10px] min-w-[180px]`}
            style={{ transformOrigin: '24px 0' }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -2, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {part.options.map((o, n) => (
              <li
                key={optionValue(o)}
                role="option"
                aria-selected={n === at}
                onPointerEnter={() => setHi(n)}
                onClick={() => pick(n)}
                className={`flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg px-2.5 sm:h-8 ${n === hi ? 'bg-slate-100 text-slate-900' : 'text-slate-600'}`}
              >
                <span className="flex-1">{optionLabel(o)}</span>
                {n === at && (
                  <svg viewBox="0 0 14 14" className="size-3.5 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m3.2 7.4 2.5 2.4 5.1-5.6" />
                  </svg>
                )}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </span>
  );
}

function Roll({ text, dir, reduce }) {
  const chars = String(text).split('');
  return (
    <span className="relative inline-flex overflow-hidden tabular-nums">
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        {chars.map((c, i) => (
          <motion.span
            key={`${chars.length - i}-${c}`}
            custom={dir}
            className="inline-block"
            variants={{
              in: (d) => ({ y: reduce ? 0 : d > 0 ? '70%' : '-70%', opacity: 0 }),
              at: { y: 0, opacity: 1 },
              out: (d) => ({ y: reduce ? 0 : d > 0 ? '-70%' : '70%', opacity: 0 })
            }}
            initial="in"
            animate="at"
            exit="out"
            transition={{ duration: 0.22, ease: EASE }}
          >
            {c}
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

const decimalsOf = (step) => {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
};

function Dial({ part, value, onChange, reduce }) {
  const { min, max, step = 1, label, suffix = '' } = part;
  const decimals = decimalsOf(step);
  const [dir, setDir] = useState(1);
  const [held, setHeld] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const from = useRef({ x: 0, v: 0, moved: false });
  const box = useRef(null);
  const [close] = useState(() => () => setOpen(false));
  useOutside(open, box, close);

  const clamp = (n) => Number(Math.min(max, Math.max(min, Math.round(n / step) * step)).toFixed(decimals));
  const set = (n) => {
    const c = clamp(n);
    if (c === value) return;
    setDir(c > value ? 1 : -1);
    onChange(c);
  };

  useEffect(() => {
    if (open) setDraft(value.toFixed(decimals));
  }, [open, value, decimals]);

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    from.current = { x: e.clientX, v: value, moved: false };
    setHeld(true);
  };
  const move = (e) => {
    if (!held) return;
    if (Math.abs(e.clientX - from.current.x) > 3) from.current.moved = true;
    if (from.current.moved) set(from.current.v + Math.round((e.clientX - from.current.x) / PX) * step);
  };
  const up = () => {
    setHeld(false);
    if (!from.current.moved) setOpen((o) => !o);
  };

  const onKey = (e) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') set(value + step * big);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') set(value - step * big);
    else if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const shown = part.format ? part.format(value) : `${value.toFixed(decimals)}${suffix}`;
  const commitDraft = () => {
    const n = Number(String(draft).replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n) && String(draft).trim() !== '') set(n);
  };

  const nudge = (d) => (
    <motion.button
      type="button"
      whileTap={reduce ? undefined : { scale: 0.92 }}
      aria-label={d < 0 ? `减小${label}` : `增大${label}`}
      disabled={d < 0 ? value <= min : value >= max}
      onClick={() => set(value + d * step)}
      className="grid size-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
    >
      <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <path d={d < 0 ? 'M3 6h6' : 'M3 6h6M6 3v6'} />
      </svg>
    </motion.button>
  );

  return (
    <span ref={box} className="relative inline-block">
      <span
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={value}
        aria-valuetext={shown}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => setHeld(false)}
        onKeyDown={onKey}
        className={`${MARK} inline-block cursor-ew-resize touch-none select-none ${held || open ? OPEN : SHUT}`}
      >
        <Roll text={shown} dir={dir} reduce={reduce} />
      </span>
      <AnimatePresence>
        {open && (
          <motion.span
            ref={fitMiddle}
            className={`${MENU} left-1/2 flex items-center gap-1`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -2, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {nudge(-1)}
            <span className="flex items-center rounded-lg bg-slate-50 px-2 ring-1 ring-slate-200 focus-within:ring-indigo-400">
              <input
                value={draft}
                inputMode="decimal"
                aria-label={label}
                onChange={(e) => setDraft(e.target.value.replace(/[^\d.-]/g, '').slice(0, 8))}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitDraft();
                    setOpen(false);
                  }
                }}
                className="h-8 w-14 bg-transparent text-center text-[14px] tabular-nums text-slate-900 outline-none"
              />
              {suffix ? <span className="text-[12px] text-slate-400">{suffix}</span> : null}
            </span>
            {nudge(1)}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export function Phrase({ parts, value, onChange, title, aside, says, className = '', ...rest }) {
  const reduce = !!useReducedMotion();
  const set = (id) => (v) => onChange?.({ ...value, [id]: v });
  const line = says?.(value);
  const lineKey = parts.filter((p) => typeof p !== 'string').map((p) => value[p.id]).join('|');

  const sentence = useRef(null);
  const [h, setH] = useState('auto');
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    const el = sentence.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section {...rest} className={`w-full rounded-2xl bg-white p-1 shadow-[0_0_0_0.5px_rgb(0_0_0/.12),0_1px_2px_rgb(0_0_0/.04),0_12px_32px_-20px_rgb(0_0_0/.22)] ${className}`}>
      {(title || aside) && (
        <header className="flex h-9 items-center gap-2 px-3">
          {title && <h3 className="text-[13px] font-semibold text-slate-700">{title}</h3>}
          <span className="flex-1" />
          {aside && <span className="text-[12px] text-slate-400">{aside}</span>}
        </header>
      )}
      <div className="rounded-xl bg-slate-50 px-3.5">
        <motion.div
          className={moving ? 'overflow-hidden' : ''}
          onAnimationStart={() => setMoving(true)}
          onAnimationComplete={() => setMoving(false)}
          initial={false}
          animate={{ height: h }}
          transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }}
        >
          <div ref={sentence} className="py-4 text-[17px] leading-[1.9] text-slate-400 sm:text-[18px]">
            {parts.map((p, n) => (typeof p === 'string'
              ? <Fragment key={n}>{p}</Fragment>
              : isChoice(p)
                ? <Word key={p.id} part={p} value={value[p.id]} onPick={set(p.id)} reduce={reduce} />
                : <Dial key={p.id} part={p} value={Number(value[p.id])} onChange={set(p.id)} reduce={reduce} />))}
          </div>
        </motion.div>
        {says && (
          <div aria-live="polite" className="flex min-h-10 items-center overflow-hidden border-t border-slate-200/70 text-[12px]">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={lineKey}
                className="py-2.5 leading-5 text-slate-500 tabular-nums"
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }}
                transition={{ duration: 0.22, ease: EASE }}
              >
                {line}
              </motion.span>
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}

export default Phrase;
