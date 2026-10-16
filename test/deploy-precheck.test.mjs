/* deploy-precheck.test.mjs — deploy.yml「部署前 secret 预检」那段 shell 的行为回归
 *
 * 为什么需要它：这段判据是**部署链上唯一的门禁**（缺 ADMIN_PASSWORD 就上线 = 站点直接不可用），
 * 可它写在 workflow 的内联 shell 里 —— 五道静态门禁不执行它、单测也覆盖不到，历史上已经因此
 * 误报过一次（2026-10-06：判据按 YAML 列表行锚定，wrangler v4 实际输出 JSON/表格 → 假阳性拒绝部署）。
 *
 * 做法：从 deploy.yml 里**原样抠出**那段 for 循环喂给真实 bash 执行（不接受复制一份副本 ——
 * 副本会与线上实现漂移，断言就失去意义），只把 `npx wrangler secret list` 换成可控的 mock。
 * 2026-10-16 本条抓到的缺陷：`not found` 放行分支只 echo、没有跳出该轮检查 →
 * 紧随其后的 `grep -qw "$s"` 拿错误输出必然不命中 → exit 1 → **首部署死锁照旧**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const YAML = new URL('../.github/workflows/deploy.yml', import.meta.url);
const MARK = '__PRE_DEPLOY__';

/** 从 deploy.yml 抠出「部署前 secret 预检」的 for 循环（提取锚：for s in ADMIN_PASSWORD SESSION_SECRET） */
function extractPrecheck() {
  const lines = fs.readFileSync(YAML, 'utf8').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('for s in ADMIN_PASSWORD SESSION_SECRET; do'));
  assert.ok(start > 0, 'deploy.yml 里找不到 secret 预检的 for 循环 —— 提取锚已被改动？判据必须 fail loud');
  const indent = lines[start].match(/^\s*/)[0].length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === 'done' && lines[i].match(/^\s*/)[0].length === indent) {
      return lines.slice(start, i + 1).join('\n');
    }
  }
  throw new Error('for 循环没有配对的 done（deploy.yml 结构已变）');
}

/** 跑一次预检：mock 掉 wrangler 的返回，返回 { code, stdout } */
function runPrecheck({ out, rc }) {
  const raw = extractPrecheck();
  const body = raw.replace(/npx wrangler secret list 2>&1/,
    "printf '%s\\n' \"$MOCK_OUT\"; [ \"$MOCK_RC\" = 0 ]");
  assert.notEqual(body, raw, 'mock 替换没命中 —— wrangler 命令的写法已改动');
  const script = 'set -e\n' + body + '\necho ' + MARK + '\n';
  try {
    const stdout = execFileSync('bash', ['-c', script], {
      env: { ...process.env, MOCK_OUT: out, MOCK_RC: rc },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: String(stdout) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('预检：Worker 尚不存在（首部署）→ 必须放行，且不得被后续 secret 检查拦下', () => {
  const r = runPrecheck({ out: 'X [ERROR] A worker with that name was not found. [code: 10007]', rc: 1 });
  assert.equal(r.code, 0, '首部署必须放行：否则「要先部署才有 Worker、要先有 Worker 才肯部署」永久死锁');
  assert.match(r.stdout, /跳过 secret 预检/, '应给出可辨认的放行说明');
  assert.match(r.stdout, new RegExp(MARK), '★ 必须真的走到部署那一步（2026-10-16 缺陷：放行后又 exit 1）');
});

test('预检：首部署的另一种文案（错误码 10007 / does not exist）也要认得', () => {
  const a = runPrecheck({ out: 'Error: Worker does not exist [code: 10007]', rc: 1 });
  assert.equal(a.code, 0, '错误码 10007 就是「Worker 不存在」，必须放行');
  assert.match(a.stdout, new RegExp(MARK));
});

test('预检：其他查询失败（Token/网络）→ 必须 fail loud，不得静默跳过', () => {
  const r = runPrecheck({ out: 'X [ERROR] Authentication error [code: 10000]', rc: 1 });
  assert.notEqual(r.code, 0, '非「Worker 不存在」的查询失败必须拒绝部署（否则用错 Token 也照样往下走）');
  assert.doesNotMatch(r.stdout, new RegExp(MARK), '不得继续往下走');
});

test('预检：secret 齐全 → 放行', () => {
  const r = runPrecheck({ out: 'ADMIN_PASSWORD\nSESSION_SECRET', rc: 0 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(MARK));
});

test('预检：缺 SESSION_SECRET → 必须拒绝部署', () => {
  const r = runPrecheck({ out: 'ADMIN_PASSWORD', rc: 0 });
  assert.notEqual(r.code, 0, '缺 secret 时上线 = 站点无法登录（2026-10-06 审计 P1 的原始动机）');
  assert.doesNotMatch(r.stdout, new RegExp(MARK));
});

test('预检：判据本身有判别力（mock 输出必须真的参与判定）', () => {
  // 反向自检：把「齐全」的输出喂进去却报缺 secret，说明判据没在看 mock → 前面几条会假绿
  const a = runPrecheck({ out: 'ADMIN_PASSWORD SESSION_SECRET', rc: 0 });
  const b = runPrecheck({ out: 'none', rc: 0 });
  assert.equal(a.code, 0, '两个 secret 都在时必须放行');
  assert.notEqual(b.code, 0, '一个都不在时必须拒绝 —— 若这条也放行，说明判据根本没生效');
});
