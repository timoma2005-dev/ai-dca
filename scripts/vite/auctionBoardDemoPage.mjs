// 竞价看板演示页：构建时由 public/auction-board.html（正式页，nginx 对其做 auth_request 鉴权）生成 auction-board-demo.html，
// 只在唯一的看板脚本前插入 public/auction-board-demo.js（模拟时钟 + 模拟行情 + 演示持仓），保证演示页与正式页同一份渲染逻辑。
// 新路径不在 nginx 的 `location = /auction-board.html` 精确匹配内，未登录可访问。
import fs from 'node:fs';
import path from 'node:path';

export const AUCTION_BOARD_SOURCE = 'public/auction-board.html';
export const AUCTION_BOARD_DEMO_FILE = 'auction-board-demo.html';
export const AUCTION_BOARD_DEMO_SCRIPT = 'auction-board-demo.js';

const TITLE = '<title>纳指期指与ETF竞价看板</title>';
const SCRIPT_OPEN = '<script>';

export function buildAuctionBoardDemoHtml(html) {
  const source = String(html);
  if (!source.includes(TITLE)) throw new Error('auction-board.html: 找不到标题，无法生成演示页');
  if (source.split(SCRIPT_OPEN).length !== 2 || /<script\s+src=/.test(source)) {
    throw new Error('auction-board.html: 需要恰好一个内联看板脚本，无法生成演示页');
  }
  return source
    .replace(TITLE, '<title>【演示数据】纳指期指与ETF竞价看板</title>\n    <meta name="robots" content="noindex"/>')
    .replace(SCRIPT_OPEN, `<script src="./${AUCTION_BOARD_DEMO_SCRIPT}"></script>\n    ${SCRIPT_OPEN}`);
}

export function readAuctionBoardDemoHtml(root) {
  return buildAuctionBoardDemoHtml(fs.readFileSync(path.resolve(root, AUCTION_BOARD_SOURCE), 'utf8'));
}

/** Vite 插件：开发服务器按需生成，构建时作为静态资源输出到产物根目录。 */
export function auctionBoardDemoPlugin({ root }) {
  return {
    name: 'auction-board-demo',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (String(req.url || '').split('?')[0] !== `/${AUCTION_BOARD_DEMO_FILE}`) return next();
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(readAuctionBoardDemoHtml(root));
        return undefined;
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: AUCTION_BOARD_DEMO_FILE, source: readAuctionBoardDemoHtml(root) });
    },
  };
}
