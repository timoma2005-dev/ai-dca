// 审计日志 → 人话描述。只用 entry 自带字段与角色 / 菜单名映射，不发请求。

export const AUDIT_ACTION_LABELS = {
  'role.grant': '授予角色',
  'role.revoke': '撤销角色',
  'role.bootstrap': '种子授予',
  'role.create': '新建角色',
  'role.update': '修改角色',
  'role.delete': '删除角色',
  'role.permissions': '修改角色权限',
  'permission.create': '新建权限',
  'menu.create': '新建菜单',
  'menu.update': '修改菜单',
  'menu.delete': '删除菜单',
  'rbac.migrate': '迁移',
};

export const AUDIT_ACTION_TONES = {
  'role.grant': 'emerald',
  'role.bootstrap': 'emerald',
  'role.revoke': 'rose',
  'role.delete': 'rose',
  'menu.delete': 'rose',
  'role.permissions': 'indigo',
};

const day = (value) => (value ? String(value).slice(0, 10) : '');

export function describeAuditEntry(entry = {}, { roleNames = {}, menuNames = {} } = {}) {
  const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail : {};
  const actor = entry.actorUsername || 'system';
  const roleName = (code) => roleNames[code] || code || '';
  const target = detail.username || entry.targetId || '';
  switch (entry.action) {
    case 'role.grant':
    case 'role.bootstrap':
      return `${actor} 给 ${target} 授予 ${roleName(detail.role)}${detail.expiresAt ? `，到期 ${day(detail.expiresAt)}` : '，长期有效'}`;
    case 'role.revoke':
      return `${actor} 撤销了 ${target} 的 ${roleName(detail.role)}`;
    case 'role.create':
      return `${actor} 新建角色 ${detail.name || entry.targetId}${detail.parent ? `（继承 ${roleName(detail.parent)}）` : ''}`;
    case 'role.update':
      return `${actor} 修改角色 ${roleName(entry.targetId)}${detail.name && detail.name !== roleName(entry.targetId) ? ` → ${detail.name}` : ''}`;
    case 'role.delete':
      return `${actor} 删除角色 ${detail.name || entry.targetId}`;
    case 'role.permissions': {
      const added = Array.isArray(detail.added) ? detail.added.length : 0;
      const removed = Array.isArray(detail.removed) ? detail.removed.length : 0;
      const parts = [added ? `新增 ${added} 项` : '', removed ? `移除 ${removed} 项` : ''].filter(Boolean).join('，');
      return `${actor} 调整 ${roleName(entry.targetId)} 的权限${parts ? `：${parts}` : ''}`;
    }
    case 'permission.create':
      return `${actor} 新建权限 ${entry.targetId}`;
    case 'menu.create':
      return `${actor} 新建菜单 ${detail.label || entry.targetId}`;
    case 'menu.update':
      return `${actor} 修改菜单 ${menuNames[entry.targetId] || detail.label || entry.targetId}${detail.enabled !== undefined && !detail.enabled ? '（已停用）' : ''}`;
    case 'menu.delete':
      return `${actor} 删除菜单 ${detail.label || entry.targetId}`;
    case 'rbac.migrate':
      return `系统完成权限数据迁移 ${entry.targetId || ''}`.trim();
    default:
      return `${actor} ${AUDIT_ACTION_LABELS[entry.action] || entry.action || '操作'} ${entry.targetType || ''}:${entry.targetId || ''}`.trim();
  }
}
