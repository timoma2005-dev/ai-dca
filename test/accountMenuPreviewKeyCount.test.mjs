import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const menuSource = fs.readFileSync(path.resolve(testDir, '../src/components/account-menu.jsx'), 'utf8');
const webdavBackupSource = fs.readFileSync(path.resolve(testDir, '../src/app/webdavBackup.js'), 'utf8');

test('previewKeyCount 来自服务端 envelope export，而非 localStorage 或已删除的 collectBackupPayload', () => {
  assert.match(menuSource, /import \{ fetchAccountEnvelopeExport \} from '\.\.\/app\/accountApi\.js';/);
  assert.doesNotMatch(menuSource, /collectBackupPayload/);
});

test('一次刷新只有一个 envelope 调用点，不为计数单独重复请求', () => {
  // 源码中 fetchAccountEnvelopeExport 仅出现两次：一次 import，一次统一刷新入口内的唯一调用点。
  assert.equal((menuSource.match(/fetchAccountEnvelopeExport/g) || []).length, 2);
});

test('countEnvelopeItems 统一解析项数：keys 优先、payload 回退、空值与异常形态归零', () => {
  assert.match(menuSource, /function countEnvelopeItems\(envelope\) \{/);
  assert.match(menuSource, /if \(!envelope \|\| typeof envelope !== 'object'\) return 0;/);
  assert.match(menuSource, /if \(Array\.isArray\(envelope\.keys\)\) return envelope\.keys\.length;/);
  assert.match(menuSource, /if \(envelope\.payload && typeof envelope\.payload === 'object'\) return Object\.keys\(envelope\.payload\)\.length;/);
});

test('统一刷新入口 refreshLocalState 与菜单打开都会重新获取项数', () => {
  assert.match(menuSource, /function refreshLocalState\(event\) \{[\s\S]*?refreshEnvelopeKeyCount\(nextSession\);/);
  assert.match(
    menuSource,
    /if \(!open \|\| !session\?\.accessToken\) \{\s*if \(!session\?\.accessToken\) setPreviewKeyCount\(0\);\s*return undefined;\s*\}\s*refreshEnvelopeKeyCount\(\);/
  );
});

test('无会话与请求失败都归零，且旧请求结果不覆盖新结果', () => {
  assert.match(menuSource, /if \(!session\?\.accessToken\) \{\s*setPreviewKeyCount\(0\);\s*return;/);
  assert.match(
    menuSource,
    /\.then\(\(envelope\) => \{\s*if \(requestId !== envelopeCountRequestRef\.current\) return;\s*setPreviewKeyCount\(countEnvelopeItems\(envelope\)\);/
  );
  assert.match(
    menuSource,
    /\.catch\(\(\) => \{\s*if \(requestId !== envelopeCountRequestRef\.current\) return;\s*setPreviewKeyCount\(0\);/
  );
});

test('三个展示位置使用同一 previewKeyCount 计数', () => {
  assert.match(menuSource, /\{conflict\.localKeyCount \?\? previewKeyCount\} 项/);
  const plainCountSlots = menuSource.match(/\{previewKeyCount\} 项/g) || [];
  assert.equal(plainCountSlots.length, 2);
});

test('countEnvelopeItems 与服务端导出 buildBackupEnvelope 的 keyCount 口径一致', () => {
  assert.match(
    webdavBackupSource,
    /keyCount: Array\.isArray\(envelope\.keys\) \? envelope\.keys\.length : Object\.keys\(envelope\.payload\)\.length/
  );
});
