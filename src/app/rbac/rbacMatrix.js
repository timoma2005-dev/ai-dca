// 权限矩阵的纯逻辑：角色按继承链排序、草稿下的有效权限、单格三态与改动统计。
// 不依赖 React，便于 node --test 直接覆盖。

export const MENU_GROUP_LABELS = { primary: '主导航', admin: '管理' };

/** 菜单格三态：none 无 / view 可见（锁住） / access 可访问。 */
export const CELL_STATES = ['none', 'view', 'access'];
const RANK = { none: 0, view: 1, access: 2 };

const viewCode = (key) => `menu:${key}:view`;
const accessCode = (key) => `menu:${key}:access`;

/**
 * 列顺序：沿继承链深度优先（guest → user → vip → svip → admin → superadmin），
 * 同一父角色下按 level、code 排序，侧枝（如 auction_viewer）排在主链之后。
 */
export function orderRolesByChain(roles = []) {
  const byParent = new Map();
  const codes = new Set(roles.map((role) => role.code));
  for (const role of roles) {
    const parent = role.parent && codes.has(role.parent) ? role.parent : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(role);
  }
  const depthCache = new Map();
  const depth = (role) => {
    if (depthCache.has(role.code)) return depthCache.get(role.code);
    depthCache.set(role.code, 0);
    const children = byParent.get(role.code) || [];
    const value = children.length ? 1 + Math.max(...children.map(depth)) : 0;
    depthCache.set(role.code, value);
    return value;
  };
  const sortChildren = (list) => [...list].sort((a, b) => depth(b) - depth(a) || (a.level || 0) - (b.level || 0) || a.code.localeCompare(b.code));
  const ordered = [];
  const seen = new Set();
  const visit = (role) => {
    if (seen.has(role.code)) return;
    seen.add(role.code);
    ordered.push(role);
    for (const child of sortChildren(byParent.get(role.code) || [])) visit(child);
  };
  for (const rootRole of sortChildren(byParent.get(null) || [])) visit(rootRole);
  for (const role of roles) visit(role);
  return ordered;
}

/** 草稿：{ [roleCode]: Set<perm> }，初始为各角色本级权限。 */
export function createDraft(roles = []) {
  return Object.fromEntries(roles.map((role) => [role.code, new Set(role.perms || [])]));
}

/** 按草稿计算每个角色的有效权限（本级 ∪ 父链），并记录每个权限最早来自哪个祖先。 */
export function computeEffective(roles = [], draft = {}) {
  const byCode = new Map(roles.map((role) => [role.code, role]));
  const cache = new Map();
  const resolve = (code, trail = new Set()) => {
    if (cache.has(code)) return cache.get(code);
    const role = byCode.get(code);
    if (!role || trail.has(code)) return new Map();
    trail.add(code);
    const parentMap = role.parent ? resolve(role.parent, trail) : new Map();
    const result = new Map(parentMap);
    for (const perm of draft[code] || role.perms || []) {
      if (!result.has(perm)) result.set(perm, code);
    }
    cache.set(code, result);
    return result;
  };
  return Object.fromEntries(roles.map((role) => [role.code, resolve(role.code)]));
}

function parentEffective(role, effective) {
  return role?.parent ? (effective[role.parent] || new Map()) : new Map();
}

/** 菜单格：当前状态、继承下限与来源角色。 */
export function menuCellState(role, menuKey, draft, effective) {
  const own = draft[role.code] || new Set();
  const inherited = parentEffective(role, effective);
  const has = (code) => own.has(code) || inherited.has(code);
  const state = has(accessCode(menuKey)) ? 'access' : has(viewCode(menuKey)) ? 'view' : 'none';
  const floor = inherited.has(accessCode(menuKey)) ? 'access' : inherited.has(viewCode(menuKey)) ? 'view' : 'none';
  const source = floor === 'access' ? inherited.get(accessCode(menuKey)) : floor === 'view' ? inherited.get(viewCode(menuKey)) : null;
  return { state, floor, source, inherited: floor !== 'none' && RANK[state] === RANK[floor] };
}

/** 点击循环：none → view → access → none，但不会低于继承下限。 */
export function nextMenuState(state, floor = 'none') {
  const allowed = CELL_STATES.filter((item) => RANK[item] >= RANK[floor]);
  const index = allowed.indexOf(state);
  return allowed[(index + 1) % allowed.length];
}

/** 把菜单格设为目标状态：只改本级权限，继承来的不重复写入。 */
export function applyMenuState(ownPerms, menuKey, target, inherited = new Map()) {
  const next = new Set(ownPerms);
  const view = viewCode(menuKey);
  const access = accessCode(menuKey);
  next.delete(view);
  next.delete(access);
  if (target === 'view' || target === 'access') {
    if (!inherited.has(view)) next.add(view);
  }
  if (target === 'access' && !inherited.has(access)) next.add(access);
  return next;
}

/** 接口权限格：有 / 无，继承来的不可取消。 */
export function apiCellState(role, code, draft, effective) {
  const own = draft[role.code] || new Set();
  const inherited = parentEffective(role, effective);
  return { on: own.has(code) || inherited.has(code), inherited: inherited.has(code), source: inherited.get(code) || null };
}

/** 改动：逐角色比较草稿与服务端本级权限；count 为增删的权限条数。 */
export function diffDraft(roles = [], draft = {}) {
  const changes = [];
  for (const role of roles) {
    const before = new Set(role.perms || []);
    const after = draft[role.code] || before;
    const added = [...after].filter((perm) => !before.has(perm)).sort();
    const removed = [...before].filter((perm) => !after.has(perm)).sort();
    if (added.length || removed.length) changes.push({ code: role.code, perms: [...after].sort(), added, removed });
  }
  return { changes, count: changes.reduce((sum, item) => sum + item.added.length + item.removed.length, 0) };
}

/** 角色是否只读：特权角色（管理员链）只有超级管理员能改；虚拟角色可改权限但不能授予。 */
export function isRoleLocked(role, canGrantAdmin) {
  return Boolean(role?.privileged && !canGrantAdmin);
}

/** 菜单按分组排序：主导航在前、管理在后，组内按 sort。 */
export function groupMenus(menus = []) {
  const groups = new Map();
  for (const menu of [...menus].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.key.localeCompare(b.key))) {
    const group = menu.group || 'primary';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(menu);
  }
  const order = ['primary', 'admin', ...[...groups.keys()].filter((key) => key !== 'primary' && key !== 'admin')];
  return order.filter((key) => groups.has(key)).map((key) => ({ key, label: MENU_GROUP_LABELS[key] || key, menus: groups.get(key) }));
}

/** 组内调序后按 10 递增重新编号，只返回 sort 有变化的菜单。 */
export function reorderedSorts(groupMenusList = []) {
  const base = Math.min(...groupMenusList.map((menu) => Number(menu.sort) || 0));
  const start = Number.isFinite(base) ? Math.floor(base / 10) * 10 : 0;
  return groupMenusList
    .map((menu, index) => ({ key: menu.key, sort: start + index * 10, previous: menu.sort }))
    .filter((item) => item.sort !== item.previous);
}
