// 持仓总览右侧操作区：主按钮「新增单笔」外，其余收进「导入」「更多」两个下拉菜单。
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Download, MoreHorizontal, PlugZap, Plus, ReceiptText, ScanLine, Trash2, Wrench } from 'lucide-react';
import { cx } from '../../components/experience-ui.jsx';

const ITEM_CLASS = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50';

function ActionMenu({ label, icon: Icon, items, tone = 'slate' }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef(null);
	useEffect(() => {
		if (!open) return undefined;
		const onDown = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
		const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);
	const visible = items.filter(Boolean);
	if (!visible.length) return null;
	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className={cx(
					'inline-flex items-center gap-1.5 h-8 rounded-full border px-3 text-xs font-semibold transition-colors',
					tone === 'indigo'
						? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100'
						: 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-800'
				)}
			>
				<Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
				<span>{label}</span>
				<ChevronDown className={cx('h-3 w-3 transition-transform', open && 'rotate-180')} strokeWidth={2} aria-hidden="true" />
			</button>
			{open ? (
				<div role="menu" className="absolute right-0 top-full z-50 mt-1.5 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
					{visible.map((item) => (
						<div key={item.key} onClick={() => setOpen(false)}>{item.node}</div>
					))}
				</div>
			) : null}
		</div>
	);
}

export function HoldingsQuickActions({ quickActions }) {
	if (!quickActions) return null;
	const importItems = [
		quickActions.onLocalMcp ? {
			key: 'mcp',
			node: (
				<button type="button" role="menuitem" onClick={quickActions.onLocalMcp} title="从本机 MCP（同花顺投资账本）导入持仓" className={ITEM_CLASS}>
					<PlugZap className="h-3.5 w-3.5 text-indigo-500" strokeWidth={1.75} aria-hidden="true" />
					<span>本地 MCP</span>
				</button>
			)
		} : null,
		quickActions.onPasteExcel ? {
			key: 'paste',
			node: (
				<button type="button" role="menuitem" onClick={quickActions.onPasteExcel} title="从 Excel 粘贴交易流水" className={ITEM_CLASS}>
					<ReceiptText className="h-3.5 w-3.5 text-indigo-500" strokeWidth={1.75} aria-hidden="true" />
					<span>Excel 粘贴</span>
				</button>
			)
		} : null,
		quickActions.onOcr ? {
			key: 'ocr',
			node: (
				<button type="button" role="menuitem" onClick={quickActions.onOcr} title="从截图识别交易流水" className={ITEM_CLASS}>
					<ScanLine className="h-3.5 w-3.5 text-indigo-500" strokeWidth={1.75} aria-hidden="true" />
					<span>截图 OCR</span>
				</button>
			)
		} : null
	];
	const moreItems = [
		quickActions.onDataRepair ? {
			key: 'repair',
			node: (
				<button type="button" role="menuitem" onClick={quickActions.onDataRepair} title="检查并修复异常流水" className={ITEM_CLASS}>
					<Wrench className="h-3.5 w-3.5 text-amber-600" strokeWidth={1.75} aria-hidden="true" />
					<span>数据修复</span>
				</button>
			)
		} : null,
		quickActions.onCopyTable ? {
			key: 'copy',
			node: (
				<button type="button" role="menuitem" onClick={quickActions.onCopyTable} title={quickActions.copyTitle || '复制表格'} className={ITEM_CLASS}>
					<Copy className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
					<span>复制表格</span>
				</button>
			)
		} : null,
		quickActions.onClearAllData ? {
			key: 'clear',
			node: (
				<button type="button" role="menuitem" onClick={quickActions.onClearAllData} title="清除所有数据（不可恢复）" className={cx(ITEM_CLASS, 'text-red-600 hover:bg-red-50')}>
					<Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
					<span>清除数据</span>
				</button>
			)
		} : null
	];
	const hasAny = importItems.some(Boolean) || moreItems.some(Boolean) || quickActions.onNewTransaction;
	if (!hasAny) return null;
	return (
		<div className="flex flex-wrap items-center justify-end gap-2">
			<ActionMenu label="导入" icon={Download} items={importItems} tone="indigo" />
			{quickActions.onNewTransaction ? (
				<button
					type="button"
					onClick={quickActions.onNewTransaction}
					title="新增单条交易"
					className="inline-flex items-center gap-1.5 h-8 rounded-full bg-rose-500 px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-rose-600"
				>
					<Plus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
					<span>新增单笔</span>
				</button>
			) : null}
			<ActionMenu label="更多" icon={MoreHorizontal} items={moreItems} />
		</div>
	);
}

export default HoldingsQuickActions;
