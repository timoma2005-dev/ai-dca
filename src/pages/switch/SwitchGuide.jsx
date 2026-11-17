import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.jsx';
import { buildDefaultSwitchRuleName } from './switchRuleName.js';
import {
  GROUP_LABEL,
  GUIDE_WINDOWS,
  buildGuideRulePayload,
  buildLadder,
  buildPlan,
  fmtPct,
  judgePlan,
  pairStat
} from './switchGuideModel.js';
import './switch-guide.css';

const GLOSSARY = {
  premium: ['溢价', '在市场上买基金，比它篮子里东西真值多付的那部分。贵 17% 就是 100 元的东西要花 117 元。'],
  spread: ['价差', '两只基金溢价相减。国泰贵 17%、大成贵 12%，价差就是 5%。']
};

function findScrollParent(node) {
  let el = node?.parentElement;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return window;
}

function scrollTopOf(target) {
  return target === window ? window.scrollY : target.scrollTop;
}

function Word({ id, onTip }) {
  return <span className="sg-w" role="button" tabIndex={0} onClick={() => onTip(id)} onKeyDown={(e) => { if (e.key === 'Enter') onTip(id); }}>{GLOSSARY[id][0]}</span>;
}

function buildStorySteps(guide) {
  const A = guide.today?.['513100'] != null ? '513100' : guide.codes?.[0];
  const B = guide.today?.['159513'] != null ? '159513' : guide.codes?.[1];
  const nA = guide.names?.[A] || A;
  const nB = guide.names?.[B] || B;
  const pa = Number(guide.today?.[A]);
  const pb = Number(guide.today?.[B]);
  const stat = pairStat(guide, A, B, 60) || { m: 0 };
  const gap = pa - pb;
  return {
    A, B, nA, nB,
    steps: [
      { a: 100, b: 100, ca: '', cb: '', ea: '篮子里真值 100 元', eb: '篮子里真值 100 元', t: <>这两只基金装的是<b>同一篮子</b>纳斯达克股票，篮子里的东西真值 100 元。</> },
      { a: 100 + pa, b: 100 + pb, ca: pa >= pb ? 'hi' : 'lo', cb: pa >= pb ? 'lo' : 'hi', ea: `多付 ${pa.toFixed(2)} 元`, eb: `多付 ${pb.toFixed(2)} 元`, t: (onTip) => <>可在市场上买，今天{nA}要 <b>{(100 + pa).toFixed(2)} 元</b>，{nB}要 <b>{(100 + pb).toFixed(2)} 元</b>。多付的那部分叫 <Word id="premium" onTip={onTip} />。</> },
      { a: 100 + pa, b: 100 + pb, ca: pa >= pb ? 'hi' : 'lo', cb: pa >= pb ? 'lo' : 'hi', ea: stat.m >= 0 ? '平时就贵' : '平时就便宜', eb: stat.m >= 0 ? '平时就便宜' : '平时就贵', t: <>但{nA}和{nB}之间<b>一直</b>有差距：近 60 天，两家中间值差 <b>{fmtPct(stat.m)}</b>。今天差 {fmtPct(gap)}，{Math.abs(gap - stat.m) < 0.5 ? '跟平时差不多' : gap > stat.m ? '比平时多' : '比平时少'}。</> },
      { a: 100 + pa, b: 100 + pb, ca: pa >= pb ? 'hi' : 'lo', cb: pa >= pb ? 'lo' : 'hi', ea: '差得比平时多 → 卖', eb: '→ 买', t: <>所以不是看谁贵就换，而是等两家<b>差得比平时多很多</b>时，卖贵的买便宜的；等差回到比平时少，再换回来。赚的是这一来一回。</> }
    ]
  };
}

function Story({ guide, folded, onFold, onTip }) {
  const [si, setSi] = useState(0);
  const { nA, nB, A, B, steps } = useMemo(() => buildStorySteps(guide), [guide]);
  const s = steps[si];
  const text = typeof s.t === 'function' ? s.t(onTip) : s.t;
  return (
    <section className={`sg-card sg-story${folded ? ' folded' : ''}`}>
      <div className="sg-row sg-between sg-storyhead" onClick={() => { if (folded) onFold(false); }}>
        <h2>30 秒看懂换基</h2>
        {folded ? <span className="sg-muted">展开 ▾</span> : <span className="sg-muted">{si + 1}/4</span>}
      </div>
      <div className={`sg-col${folded ? ' shut' : ''}`}>
        <div className="sg-colin">
          <div className="sg-dots">{steps.map((_, k) => <i key={k} className={k <= si ? 'on' : ''} />)}</div>
          <div className="sg-shops">
            <div className={`sg-shop ${s.ca}`}><div className="name">{nA} {A}</div><div className="basket">🧺</div><div className="price sg-num">{s.a.toFixed(2)} 元</div><div className="extra">{s.ea}</div></div>
            <div className={`sg-shop ${s.cb}`}><div className="name">{nB} {B}</div><div className="basket">🧺</div><div className="price sg-num">{s.b.toFixed(2)} 元</div><div className="extra">{s.eb}</div></div>
          </div>
          <p className="sg-storytext">{text}</p>
          <div className="sg-row">
            <button type="button" className="sg-btn ghost sm" style={{ visibility: si ? 'visible' : 'hidden' }} onClick={() => setSi((v) => Math.max(0, v - 1))}>上一步</button>
            <button type="button" className="sg-btn dark sm" onClick={() => (si < 3 ? setSi(si + 1) : onFold(true))}>{si === 3 ? '我懂了，收起' : '下一步'}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Ladder({ guide, days, setDays, sel, onPick, collapsed, onRepick }) {
  const rows = useMemo(() => buildLadder(guide, days), [guide, days]);
  const mx = Math.max(0.5, ...rows.map((r) => Math.max(Math.abs(r.rel), Math.abs(r.relToday) || 0))) * 1.05;
  const x = (v) => 50 + (v / mx) * 50;
  let lastGroup = '';
  return (
    <section className="sg-card sg-lad">
      <div className="sg-row sg-between">
        <h2>平时谁贵、谁便宜</h2>
        <div className="sg-mini">
          {GUIDE_WINDOWS.map((w) => <button type="button" key={w} className={days === w ? 'on' : ''} onClick={() => setDays(w)}>近 {w} 天</button>)}
        </div>
      </div>
      <div className={`sg-col${collapsed ? ' shut' : ''}`}>
        <div className="sg-colin">
          <p className="sg-muted" style={{ margin: '4px 0' }}>{rows.length} 只都装同一篮子，但有的<b>一直</b>比别人贵。条形是平时（中间值）比同类贵多少，圆点是今天。</p>
          <div className="sg-keyrow">
            <span><i className="k-up" />平时偏贵</span><span><i className="k-down" />平时偏便宜</span><span><i className="k-dot" />今天</span>
          </div>
          <div className="sg-pick"><span className="n">{sel.hold ? 2 : 1}</span>{sel.hold ? <span>再点你<b>想换成</b>的那只</span> : <span>点你手里<b>持有</b>的那只</span>}</div>
          <div>
            {rows.map((r) => {
              const head = r.group !== lastGroup ? <div className={`sg-grp ${r.group}`}>{GROUP_LABEL[r.group]}</div> : null;
              lastGroup = r.group;
              const color = r.rel >= 0 ? 'var(--sg-up)' : 'var(--sg-down)';
              const left = r.rel >= 0 ? 50 : x(r.rel);
              const width = Math.abs(x(r.rel) - 50);
              return (
                <div key={r.code}>
                  {head}
                  <button type="button" className={`sg-lr${r.code === sel.hold ? ' sel' : ''}`} onClick={() => onPick(r.code)}>
                    <span className="nm">{r.name}{r.code === sel.hold ? <span className="sg-tg h">我持有</span> : null}{r.code === sel.target ? <span className="sg-tg t">想换</span> : null}</span>
                    <span className="axis">
                      <span className="bar" style={{ left: `${left}%`, width: `${width}%`, background: color }} />
                      {Number.isFinite(r.relToday) ? <span className="td" style={{ left: `${Math.max(0, Math.min(100, x(r.relToday)))}%` }} /> : null}
                    </span>
                    <span className="pv sg-num" style={{ color }}>{r.rel > 0 ? '+' : ''}{r.rel.toFixed(2)}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className={`sg-col${collapsed ? '' : ' shut'}`}>
        <div className="sg-colin">
          <div className="sg-picked">
            <span>我持有 <b>{guide.names?.[sel.hold] || sel.hold}</b> → 想换 <b>{guide.names?.[sel.target] || sel.target}</b></span>
            <button type="button" className="sg-btn ghost sm" onClick={onRepick}>重新选</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function FundBox({ guide, code, isHold, isX }) {
  return (
    <div className={`sg-fund${isHold ? ' mine' : ' want'}`}>
      <span className="tag">{isHold ? '我持有' : '想换成'}</span>
      <div className="n">{guide.names?.[code] || code} {code}</div>
      <span className={`sg-badge ${isX ? 'h' : 'l'}`}>{isX ? '两只里平时更贵' : '两只里平时更便宜'}</span>
      <div className={`p sg-num ${isX ? 'hi' : 'lo'}`}>今天贵 {Number(guide.today?.[code]).toFixed(2)}%</div>
    </div>
  );
}

function Meter({ plan, gap, go, back, onChange }) {
  const ref = useRef(null);
  const goLabel = useRef(null);
  const backLabel = useRef(null);
  const drag = useRef(null);
  const [layout, setLayout] = useState({ goRight: false, backLeft: false, two: false });
  const { min, max, stat } = plan;
  const pos = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));

  useLayoutEffect(() => {
    const M = ref.current?.getBoundingClientRect();
    const g = goLabel.current;
    const b = backLabel.current;
    if (!M || !g || !b) return;
    const next = { goRight: false, backLeft: false, two: false };
    const markerGo = M.left + (pos(go) / 100) * M.width;
    const markerBack = M.left + (pos(back) / 100) * M.width;
    if (markerBack - b.offsetWidth < M.left - 4) next.backLeft = true;
    if (markerGo + g.offsetWidth > M.right + 4) next.goRight = true;
    const B = next.backLeft ? [markerBack - 4, markerBack - 4 + b.offsetWidth] : [markerBack + 4 - b.offsetWidth, markerBack + 4];
    const G = next.goRight ? [markerGo + 4 - g.offsetWidth, markerGo + 4] : [markerGo - 4, markerGo - 4 + g.offsetWidth];
    next.two = G[0] < B[1] + 6 && B[0] < G[1] + 6;
    if (next.goRight !== layout.goRight || next.backLeft !== layout.backLeft || next.two !== layout.two) setLayout(next);
  });

  const valueAt = (clientX) => {
    const r = ref.current.getBoundingClientRect();
    return min + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (max - min);
  };
  const onDown = (e) => {
    const r = ref.current.getBoundingClientRect();
    const v = valueAt(e.clientX);
    const perPx = (max - min) / r.width;
    const y = e.clientY - r.top;
    const cands = [['gap', gap, y < 24 ? -99 : 0], ['go', go, 0], ['back', back, 0]]
      .map(([k, val, bias]) => [k, Math.abs(val - v) / perPx + bias])
      .sort((a, b) => a[1] - b[1]);
    if (cands[0][1] > 30) return;
    drag.current = cands[0][0];
    ref.current.setPointerCapture?.(e.pointerId);
    onMove(e);
  };
  const onMove = (e) => {
    const k = drag.current;
    if (!k) return;
    const raw = valueAt(e.clientX);
    if (k === 'gap') onChange({ gap: Math.round(raw * 100) / 100 });
    else if (k === 'go') onChange({ go: Math.max(back + 0.3, Math.round(raw * 20) / 20) });
    else onChange({ back: Math.min(go - 0.3, Math.round(raw * 20) / 20) });
  };
  const onUp = () => { drag.current = null; };

  return (
    <div
      ref={ref}
      className={`sg-meter${layout.two ? ' two' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role="group"
      aria-label="拖动调整换的线"
    >
      <div className="track" />
      <div className="zoneB" style={{ width: `${pos(back)}%` }} />
      <div className="zoneG" style={{ width: `${100 - pos(go)}%` }} />
      <div className="band" style={{ left: `${pos(stat.lo)}%`, width: `${pos(stat.hi) - pos(stat.lo)}%` }} />
      <div className="med" style={{ left: `${pos(stat.m)}%` }}><span>平时</span></div>
      <div className="mk" style={{ left: `${pos(back)}%` }}>
        <span ref={backLabel} className={layout.backLeft ? 'l' : 'r'}>{fmtPct(back)} 换回{plan.nameX}</span>
      </div>
      <div className="mk" style={{ left: `${pos(go)}%` }}>
        <span ref={goLabel} className={`${layout.goRight ? 'r' : 'l'}${layout.two ? ' low' : ''}`}>{fmtPct(go)} 换去{plan.nameY}</span>
      </div>
      <div className="now" style={{ left: `${pos(gap)}%` }}><b className="sg-num">今天 {fmtPct(gap)}</b><i /></div>
    </div>
  );
}

function PlanCard({ guide, sel, days, existingRules, onSave, saving, cardRef }) {
  const base = useMemo(() => buildPlan(guide, sel.hold, sel.target, days), [guide, sel.hold, sel.target, days]);
  const [state, setState] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [savedKey, setSavedKey] = useState('');
  useEffect(() => { if (base) setState({ gap: base.gap, go: base.go, back: base.back }); }, [base]);
  if (!base || !state) return null;
  const nameX = guide.names?.[base.X] || base.X;
  const nameY = guide.names?.[base.Y] || base.Y;
  const plan = { ...base, nameX, nameY };
  const { gap, go, back } = state;
  const d = gap - base.stat.m;
  const verdict = judgePlan({ holdX: base.holdX, gap, go, back, stat: base.stat, nameX, nameY, codeX: base.X, codeY: base.Y });
  const key = `${sel.hold}>${sel.target}|${go}|${back}`;
  const isSaved = savedKey === key;
  const ruleName = buildDefaultSwitchRuleName(sel.hold, sel.target).replace(/^\S+ 切换方案/, `${guide.names?.[sel.hold] || sel.hold}→${guide.names?.[sel.target] || sel.target} 换基方案`);
  const uniqueName = (() => {
    const names = new Set((existingRules || []).map((r) => String(r?.name || '').trim()));
    if (!names.has(ruleName)) return ruleName;
    for (let i = 2; i < 100; i += 1) if (!names.has(`${ruleName} (${i})`)) return `${ruleName} (${i})`;
    return `${ruleName} ${Date.now()}`;
  })();

  const doSave = async () => {
    setConfirmOpen(false);
    const ok = await onSave(buildGuideRulePayload({ plan: { ...base, go, back }, hold: sel.hold, target: sel.target, name: uniqueName }));
    if (ok !== false) setSavedKey(key);
  };

  return (
    <div className="sg-planwrap" ref={cardRef}>
      <section className="sg-card">
        <div className="sg-planhead">
          <div><h2>{guide.names?.[sel.hold]} → {guide.names?.[sel.target]}</h2><div className="sg-muted">真实数据 · {guide.date} 收盘</div></div>
          <span className={`sg-tagpill${isSaved ? '' : ' off'}`}>{isSaved ? '盯着中' : '还没保存'}</span>
        </div>
        <div className="sg-pair">
          <FundBox guide={guide} code={sel.hold} isHold isX={sel.hold === base.X} />
          <div className="vs">换成</div>
          <FundBox guide={guide} code={sel.target} isHold={false} isX={sel.target === base.X} />
        </div>
        <div className="sg-muted" style={{ textAlign: 'center' }}>「贵 X%」= 比篮子真实价值多付的钱，叫 <Word id="premium" onTip={guide.onTip} /></div>
        <div className="sg-gap">
          <div className="l">两只差了</div>
          <div className="v sg-num">{fmtPct(gap)}</div>
          <div className="l">{nameX}比{nameY}贵这么多（这个叫 <Word id="spread" onTip={guide.onTip} />）</div>
          <div className="sg-normal">
            平时（近 {days} 天中间值）差 <b>{fmtPct(base.stat.m)}</b>，大多数日子在 {fmtPct(base.stat.lo)} 到 {fmtPct(base.stat.hi)}（斜纹区）。现在
            {Math.abs(d) < 0.15 ? '跟平时差不多' : d > 0 ? <>比平时<b>大 {fmtPct(d)}</b></> : <>比平时<b>小 {fmtPct(-d)}</b></>}。
          </div>
        </div>
        <Meter plan={plan} gap={gap} go={go} back={back} onChange={(patch) => setState((s) => ({ ...s, ...patch }))} />
        <div className="sg-legend"><span className="a">比平时小很多：拿{nameX}</span><span className="c">比平时大很多：拿{nameY}</span></div>
        <div className={`sg-verdict ${verdict.kind}`}>
          <div className="big">{verdict.title}</div>
          <div className="why">{verdict.why}</div>
          {verdict.trade ? <div className="sg-trade"><span className="chip s">卖出 {verdict.trade.sell}</span>→<span className="chip b">买入 {verdict.trade.buy}</span></div> : null}
        </div>
        <div className="sg-row sg-between">
          <span className="sg-muted">👆 拖黑色竖线改「换的线」，拖「今天」试试别的价差</span>
          <button type="button" className="sg-btn ghost sm" style={{ visibility: Math.abs(gap - base.gap) > 0.005 ? 'visible' : 'hidden' }} onClick={() => setState((s) => ({ ...s, gap: base.gap }))}>回到今天</button>
        </div>
        <div className="sg-warn">{nameX}平时就比{nameY}贵约 {fmtPct(base.stat.m)}，这部分换来换去赚不到，能赚的只是比平时多出来的那截。两条线默认放在最常见范围的两头。</div>
        <button type="button" className={`sg-btn ${isSaved ? 'ghost' : 'dark'} block`} disabled={saving} onClick={() => setConfirmOpen(true)}>
          {saving ? '保存中…' : isSaved ? '已保存 ✓' : savedKey ? '保存修改' : '保存这个方案，帮我盯着'}
        </button>
        <div className="sg-muted" style={{ textAlign: 'center', marginTop: 6 }}>{isSaved ? '已加到下面「我的方案」，到了你定的线会提醒你' : '保存后会出现在下面的方案列表，到了你定的线就提醒你'}</div>
      </section>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <div className="sg">
          <DialogHeader>
            <DialogTitle>保存「{guide.names?.[sel.hold]} → {guide.names?.[sel.target]}」</DialogTitle>
            <DialogDescription>到了你定的线，按你的通知设置提醒你。</DialogDescription>
          </DialogHeader>
          <div className="sg-sum">
            现在拿着 <b>{guide.names?.[sel.hold]}</b><br />
            价差到 <b>{fmtPct(go)}</b>：卖{nameX}、换成{nameY}<br />
            价差回到 <b>{fmtPct(back)}</b>：卖{nameY}、换回{nameX}
          </div>
          <div className="sg-row" style={{ marginTop: 14 }}>
            <button type="button" className="sg-btn ghost" style={{ flex: 1 }} onClick={() => setConfirmOpen(false)}>先不存</button>
            <button type="button" className="sg-btn dark" style={{ flex: 1 }} onClick={doSave}>保存</button>
          </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 换基引导：给第一次来的人看懂「溢价 / 价差 / 平时」，并一步建好一个 H/L 切换方案。
 * guide：/api/notify/switch/guide 的 data；onSave：同规则弹窗的保存回调（返回 false 表示失败）。
 */
export function SwitchGuide({ guide, existingRules = [], onSave, saving = false }) {
  const rootRef = useRef(null);
  const planRef = useRef(null);
  const [days, setDays] = useState(60);
  const [sel, setSel] = useState({ hold: '', target: '' });
  const [storyFolded, setStoryFolded] = useState(false);
  const [tip, setTip] = useState('');
  const quietUntil = useRef(0);
  const armY = useRef(0);

  const onTip = useCallback((id) => setTip(id), []);
  useEffect(() => {
    if (!tip) return undefined;
    const t = setTimeout(() => setTip(''), 4500);
    return () => clearTimeout(t);
  }, [tip]);

  const fold = useCallback((on) => {
    if (!on) {
      quietUntil.current = Date.now() + 900;
      setTimeout(() => { armY.current = scrollTopOf(findScrollParent(rootRef.current)); }, 900);
    }
    setStoryFolded(on);
  }, []);

  // 往下滑一点，「30 秒看懂换基」自动缓缓收起；展开后的滚动锚定不算
  useEffect(() => {
    const target = findScrollParent(rootRef.current);
    let last = scrollTopOf(target);
    armY.current = last;
    const onScroll = () => {
      const y = scrollTopOf(target);
      const down = y > last;
      last = y;
      if (Date.now() < quietUntil.current) { armY.current = y; return; }
      if (down && y - armY.current > 60) setStoryFolded(true);
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, []);

  const onPick = (code) => {
    if (!sel.hold) { setSel({ hold: code, target: '' }); return; }
    if (code === sel.hold) { setSel({ hold: '', target: '' }); return; }
    setSel({ hold: sel.hold, target: code });
    quietUntil.current = Date.now() + 1500;
    setStoryFolded(true);
    // 等排行和故事卡收起动画结束（0.55s）再滚到方案卡顶部
    setTimeout(() => planRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 650);
  };
  const onRepick = () => {
    setSel({ hold: '', target: '' });
    setTimeout(() => rootRef.current?.querySelector('.sg-lad')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const guideWithTip = useMemo(() => ({ ...guide, onTip }), [guide, onTip]);
  const picked = Boolean(sel.hold && sel.target);
  return (
    <div className="sg" ref={rootRef}>
      <Story guide={guide} folded={storyFolded} onFold={fold} onTip={onTip} />
      <Ladder guide={guide} days={days} setDays={setDays} sel={sel} onPick={onPick} collapsed={picked} onRepick={onRepick} />
      {picked ? (
        <PlanCard guide={guideWithTip} sel={sel} days={days} existingRules={existingRules} onSave={onSave} saving={saving} cardRef={planRef} />
      ) : null}
      <div className={`sg-tip${tip ? ' on' : ''}`} role="status" onClick={() => setTip('')}>
        {tip ? <><b>{GLOSSARY[tip][0]}</b>{GLOSSARY[tip][1]}</> : null}
      </div>
    </div>
  );
}

export default SwitchGuide;
