import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { createRequire } from 'node:module';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('../..', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (rel) => JSON.stringify(join(root, rel));

// 入口写在临时目录，所有依赖用绝对路径（与组件解析到同一份 react）。
const entrySource = `
import { createElement as h } from ${JSON.stringify(requireFromRoot.resolve('react'))};
import { renderToStaticMarkup } from ${JSON.stringify(requireFromRoot.resolve('react-dom/server'))};
import { NotifyConfigCard } from ${abs('src/pages/NotifyConfigCard.jsx')};
import { NotifyRulesCard } from ${abs('src/pages/NotifyRulesCard.jsx')};
import { NotifyHistoryCard } from ${abs('src/pages/NotifyHistoryCard.jsx')};
export function render(name, props) {
  const map = { NotifyConfigCard, NotifyRulesCard, NotifyHistoryCard };
  return renderToStaticMarkup(h(map[name], props));
}

`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'notify-ui-'));
  const entry = join(dir, 'entry.jsx');
  writeFileSync(entry, entrySource);
  const bundle = await rolldown({
    input: entry,
    platform: 'node',
    resolve: { alias: { '@': join(root, 'src') } },
    logLevel: 'silent',
    moduleTypes: { '.css': 'empty', '.jpg': 'empty', '.png': 'empty', '.svg': 'empty' },
    transform: { jsx: 'react-jsx', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' } },
  });
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false });
  await bundle.close();
  const file = join(dir, 'bundle.mjs');
  writeFileSync(file, output[0].code);
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const { mod, cleanup } = await loadBundle();
export const renderNotifyCard = mod.render;
export { cleanup };
