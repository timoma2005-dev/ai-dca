import { useEffect, useState } from 'react';
import { ExternalLink, Images } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.jsx';
import { NOTIFY_KEY_GUIDE_EVENT, NOTIFY_KEY_GUIDES } from '../../app/notify/keyGuide.js';

/** 渠道设置里的「怎么拿 Key？看图教程」入口 + 分步图片弹窗；教程气泡也能通过事件打开。 */
export function NotifyKeyGuide({ channel }) {
  const guide = NOTIFY_KEY_GUIDES[channel];
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function handleOpen(event) { if (event?.detail?.channel === channel) setOpen(true); }
    window.addEventListener(NOTIFY_KEY_GUIDE_EVENT, handleOpen);
    return () => window.removeEventListener(NOTIFY_KEY_GUIDE_EVENT, handleOpen);
  }, [channel]);
  if (!guide) return null;
  return (
    <>
      <button type="button" data-testid="notify-key-guide" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700" onClick={() => setOpen(true)}>
        <Images className="h-3.5 w-3.5" aria-hidden="true" />{guide.trigger}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle>{guide.title}</DialogTitle>
            <DialogDescription>{guide.description}</DialogDescription>
          </DialogHeader>
          <ol className="space-y-6">
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
        </DialogContent>
      </Dialog>
    </>
  );
}
