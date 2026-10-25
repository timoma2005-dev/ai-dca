import { useEffect, useState } from 'react';
import { ExternalLink, Images } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.jsx';
import { NOTIFY_KEY_GUIDE_EVENT, NOTIFY_KEY_GUIDES, setNotifyKeyGuideOpen } from '../../app/notify/keyGuide.js';

/** 渠道设置里的「怎么拿 Key？看图教程」入口 + 分步图片弹窗；教程气泡也能通过事件打开。 */
export function NotifyKeyGuide({ channel }) {
  const guide = NOTIFY_KEY_GUIDES[channel];
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function handleOpen(event) { if (event?.detail?.channel === channel) setOpen(true); }
    window.addEventListener(NOTIFY_KEY_GUIDE_EVENT, handleOpen);
    return () => window.removeEventListener(NOTIFY_KEY_GUIDE_EVENT, handleOpen);
  }, [channel]);
  // 告诉新手入门气泡：看图教程打开时先收起，关掉后再出来。
  useEffect(() => {
    if (!open) return undefined;
    setNotifyKeyGuideOpen(true);
    return () => setNotifyKeyGuideOpen(false);
  }, [open]);
  if (!guide) return null;
  return (
    <>
      <button type="button" data-testid="notify-key-guide" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700" onClick={() => setOpen(true)}>
        <Images className="h-3.5 w-3.5" aria-hidden="true" />{guide.trigger}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* 头尾固定、中间滚动：关闭按钮和「看完了」随时点得到。 */}
        <DialogContent className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg" data-testid="notify-key-guide-dialog">
          <DialogHeader className="shrink-0 border-b border-slate-100 px-5 pb-3 pt-5 pr-12 text-left">
            <DialogTitle>{guide.title}</DialogTitle>
            <DialogDescription>{guide.description}</DialogDescription>
          </DialogHeader>
          <ol className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-4">
            {guide.steps.map((step, index) => (
              <li key={step.title}>
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs text-white">{index + 1}</span>
                  {step.title}
                </div>
                {step.body ? <p className="mt-1.5 text-xs leading-5 text-slate-500">{step.body}</p> : null}
                {step.link ? (
                  <a href={step.link.href} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-bold text-white hover:bg-indigo-700">
                    {step.link.label}<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                ) : null}
                {step.image ? <img src={step.image} alt={step.title} loading="lazy" className="mt-2 max-h-[60vh] w-full rounded-xl border border-slate-200 bg-slate-50 object-contain" /> : null}
              </li>
            ))}
          </ol>
          <div className="shrink-0 border-t border-slate-100 px-5 py-3">
            <button type="button" data-testid="notify-key-guide-done" className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-slate-900 text-sm font-extrabold text-white hover:bg-slate-800" onClick={() => setOpen(false)}>
              看完了，回去填写
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
