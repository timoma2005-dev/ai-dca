// 登录/注册表单状态（审计 batch2 #15）：字段属性统一生成，缺字段提示只在输入后或提交失败时出现。
export function authFieldAttrs(mode = 'login') {
  const register = mode === 'register';
  return {
    username: { id: `account-auth-${mode}-username`, name: 'username', autoComplete: 'username', placeholder: register ? '设置用户名' : '输入用户名' },
    password: { id: `account-auth-${mode}-password`, name: 'password', autoComplete: register ? 'new-password' : 'current-password', placeholder: register ? '设置登录密码' : '输入登录密码' },
  };
}

export function missingAuthField({ username = '', password = '' } = {}) {
  if (!String(username || '').trim()) return '请填写用户名';
  if (!String(password || '')) return '请填写登录密码';
  return '';
}

// touched：用户已在任一字段输入过；submitted：用户尝试提交过。
export function resolveAuthFormHint({ busy = '', username = '', password = '', touched = false, submitted = false } = {}) {
  if (busy) return '';
  if (!touched && !submitted) return '';
  const missing = missingAuthField({ username, password });
  if (!missing) return '';
  // 仅输入过但未提交时，只有当用户已经填了其中一项才提示另一项，避免一打开就报错。
  if (!submitted && !String(username || '').trim() && !String(password || '')) return '';
  return missing;
}
