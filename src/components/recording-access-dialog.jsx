import { useEffect, useState } from 'react';
import { CloudUpload, HardDrive } from 'lucide-react';
import { openAccountAuth } from '../app/accountAuthEvents.js';
import { setMobileBottomSheetOpen } from '../app/mobileBottomSheet.js';
import {
  getPendingRecordingAccessRequest,
  RECORDING_ACCESS_EVENT,
  resolveRecordingAccess,
  setLocalOnlyMode
} from '../app/recordingAccess.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const SHEET_SOURCE = 'recording-access';

export function RecordingAccessDialog() {
  const [request, setRequest] = useState(() => getPendingRecordingAccessRequest());

  useEffect(() => {
    function handle() { setRequest(getPendingRecordingAccessRequest()); }
    window.addEventListener(RECORDING_ACCESS_EVENT, handle);
    return () => window.removeEventListener(RECORDING_ACCESS_EVENT, handle);
  }, []);

  const open = Boolean(request);
  useEffect(() => {
    setMobileBottomSheetOpen(SHEET_SOURCE, open);
    return () => setMobileBottomSheetOpen(SHEET_SOURCE, false);
  }, [open]);

  function close(allowed) {
    setRequest(null);
    resolveRecordingAccess(allowed);
  }

  function chooseLogin() {
    close(false);
    openAccountAuth({ mode: 'login', source: 'recording-access', trigger: request?.source || '' });
  }

  function chooseLocal() {
    setLocalOnlyMode(true);
    close(true);
  }

  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(false); }}>
      <DialogContent className="z-[140] max-w-md gap-0 rounded-3xl p-0" overlayClassName="z-[130] bg-slate-950/60">
        <div className="px-5 pb-2 pt-5 sm:px-6">
          <DialogTitle className="text-lg font-bold text-slate-900">数据存在哪里？</DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-6 text-slate-500">
            登录后数据保存在云端，手机、电脑都能看到同一份。不登录也能用，但数据只保存在这台设备的浏览器里。
          </DialogDescription>
        </div>
        <div className="space-y-2 px-5 pb-5 pt-2 sm:px-6">
          <button type="button" className="flex w-full items-start gap-3 rounded-2xl bg-indigo-600 px-4 py-3 text-left text-white" onClick={chooseLogin}>
            <CloudUpload className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" />
            <span>
              <span className="block text-sm font-bold">登录，多端同步（推荐）</span>
              <span className="block text-xs text-indigo-100">换设备、清缓存都不丢</span>
            </span>
          </button>
          <button type="button" className="flex w-full items-start gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-left text-slate-700" onClick={chooseLocal}>
            <HardDrive className="mt-0.5 h-5 w-5 flex-none text-slate-500" aria-hidden="true" />
            <span>
              <span className="block text-sm font-bold">只在本机使用，不同步</span>
              <span className="block text-xs text-slate-500">以后注册登录时，会用本机数据覆盖云端</span>
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
