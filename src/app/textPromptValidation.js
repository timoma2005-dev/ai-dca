// 项目内输入弹窗（替代 window.prompt）的名称校验：必填、trim、截断到上限。
export function validatePromptText(value, { maxLength = 0, label = '名称' } = {}) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return { ok: false, value: '', error: `请输入${label}` };
  const limited = maxLength > 0 ? Array.from(trimmed).slice(0, maxLength).join('') : trimmed;
  return { ok: true, value: limited, error: '' };
}
