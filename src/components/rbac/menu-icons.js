import {
  BarChart3,
  Bell,
  BookOpen,
  FlaskConical,
  Gavel,
  House,
  LayoutGrid,
  LineChart,
  ListChecks,
  Radar,
  ShieldCheck,
  Shuffle,
  Wallet,
  Wrench,
} from 'lucide-react';

// 服务端菜单的 icon 字段 → lucide 组件。未知名称按 key 兜底，再兜底为 LayoutGrid。
const ICONS_BY_NAME = {
  House, LineChart, BarChart3, Wallet, ListChecks, Shuffle, Bell, BookOpen, Wrench, FlaskConical, Radar, Gavel, ShieldCheck, LayoutGrid,
};

const ICONS_BY_KEY = {
  home: House,
  markets: LineChart,
  shares: BarChart3,
  holdings: Wallet,
  tradePlans: ListChecks,
  fundSwitch: Shuffle,
  notify: Bell,
  articles: BookOpen,
  strategy: BookOpen,
  dataRepair: Wrench,
  adminRadar: Radar,
  adminAuction: Gavel,
  adminRbac: ShieldCheck,
};

export function resolveMenuIcon(iconName = '', key = '') {
  return ICONS_BY_NAME[iconName] || ICONS_BY_KEY[key] || LayoutGrid;
}
