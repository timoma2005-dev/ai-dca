#!/usr/bin/env node
// Claude Code PreToolUse 栅栏：只允许修改 ai-dca 源项目，禁止直接改线上产出物/发布目录。
// 被拦截时 exit 2，stderr 反馈给 agent。
import path from 'node:path';
const REPO = '/root/ai-dca';
const ALLOW_OUTSIDE = [/^\/tmp\//, /^\/root\/\.claude\//];
const ARTIFACT_IN_REPO = [/^\/root\/ai-dca\/(frontend-dist|\.frontend-build|\.edgeone-pages|android\/app\/build)(\/|$)/];
const ARTIFACT_RE = /\/var\/www\/ai-dca-cn|ai-dca-cn-releases|\/react-assets\/|HOTFIX\.json|MANIFEST\.sha256|RELEASE\.json/;
const SAFE_CMD = /^\s*(bash\s+)?(\.\/)?(\/root\/ai-dca\/)?scripts\/cn-frontend\/(release|rollback|verify)\.sh\b/;
const READONLY_CMD = /^\s*(ls|cat|head|tail|less|grep|rg|find|readlink|stat|sha256sum|diff|wc|du|file|curl\s)/;
const WRITE_HINT = /(\bsed\s+-i|\bperl\s+-p?i|\bcp\b|\bmv\b|\brm\b|\btee\b|>>?|\bln\b|\bchmod\b|\bchattr\b|\btruncate\b|\brsync\b|\bpython3?\b|\bnode\b|\bvite\s+build|--outDir|VITE_OUT_DIR|\bwrite\b)/;
const block = (msg) => { process.stderr.write(`[ai-dca 栅栏] ${msg}\n规则：只改 /root/ai-dca 源码，提交并 push 后用 bash scripts/cn-frontend/release.sh 发布；回滚用 rollback.sh。详见 docs/ops/线上开发规范.md\n`); process.exit(2); };
let raw = ''; process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  let ev = {}; try { ev = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const tool = ev.tool_name || ''; const input = ev.tool_input || {};
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = path.resolve(input.file_path || input.notebook_path || '');
    if (ARTIFACT_RE.test(p)) block(`禁止直接修改产出物：${p}`);
    if (ARTIFACT_IN_REPO.some((r) => r.test(p))) block(`禁止修改构建产物目录：${p}`);
    if (!(p === REPO || p.startsWith(REPO + '/')) && !ALLOW_OUTSIDE.some((r) => r.test(p))) block(`只允许修改 ai-dca 源项目，拒绝写入：${p}`);
    process.exit(0);
  }
  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    for (const seg of cmd.split(/&&|\|\||;|\n/)) {
      if (!ARTIFACT_RE.test(seg) && !/\/etc\/nginx\/sites-/.test(seg)) continue;
      if (SAFE_CMD.test(seg) || READONLY_CMD.test(seg) && !WRITE_HINT.test(seg.replace(/^\s*curl\s.*$/, ''))) continue;
      block(`命令涉及线上产出物，已拦截：${seg.trim().slice(0, 200)}`);
    }
  }
  process.exit(0);
});
