// 换基方案名称：必填（trim 后为空不允许保存），新建时自动填一个可区分的默认名，且不允许与已有方案重名。
function pad(value) {
  return String(value).padStart(2, '0');
}

/** 默认名形如「159632→159501 切换方案 10-26 15:30」（北京时间）。 */
export function buildDefaultSwitchRuleName(highCode = '', lowCode = '', now = Date.now()) {
  const shanghai = new Date(Number(now) + 8 * 60 * 60 * 1000);
  const stamp = `${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`;
  const pair = [String(highCode || '').trim(), String(lowCode || '').trim()].filter(Boolean).join('→');
  return `${pair ? `${pair} ` : ''}切换方案 ${stamp}`;
}

/** 返回错误文案；通过时返回空字符串。existingRules 为 [{ id, name }]，编辑时排除自身。 */
export function validateSwitchRuleName(name, existingRules = [], currentId = '') {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '请填写方案名称。';
  const duplicate = (Array.isArray(existingRules) ? existingRules : []).find((rule) => (
    rule && rule.id !== currentId && String(rule.name || '').trim() === trimmed
  ));
  return duplicate ? `已有同名方案「${trimmed}」，请换一个名称。` : '';
}
