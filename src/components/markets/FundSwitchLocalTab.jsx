import { useMemo } from 'react';
import { NASDAQ_ETFS } from '../../app/nasdaqCatalog.js';
import { LOCAL_DIRECT_SCOPES } from '../../app/localDirectMode.js';
import { LocalDirectPanel } from './LocalDirectPanel.jsx';

/**
 * fundSwitch 子 tab「本地直连」：纳指 QDII ETF 标的池 + 溢价看板。
 * 行情 / K线 / 净值全部浏览器直连厂商接口，复用 LocalDirectPanel，
 * 保持 FundSwitchExperience 编排文件不膨胀（refactor guard 预算 100 行）。
 */
export function FundSwitchLocalTab() {
  const universe = useMemo(
    () => NASDAQ_ETFS.map((item) => ({ code: item.code, name: item.name })),
    []
  );
  return (
    <LocalDirectPanel
      scope={LOCAL_DIRECT_SCOPES.FUND_SWITCH}
      universe={universe}
      showPremium
    />
  );
}
