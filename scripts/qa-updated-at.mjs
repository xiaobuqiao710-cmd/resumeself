#!/usr/bin/env node
/**
 * 探针：profiles.updated_at 到底是谁写的？
 *
 * 为什么需要它
 * ------------
 * 多设备防覆盖那套逻辑（标签页重新获得焦点 → 问一句服务端「你那边什么时候写的」）
 * 完全建立在 updated_at 是**服务端时间**这个前提上。
 * 但这个前提不是 schema 自带的：
 *   profiles 只有 `updated_at TIMESTAMPTZ DEFAULT NOW()`，DEFAULT 只在 INSERT 时生效，
 *   走 upsert 的 UPDATE 分支时客户端传什么就存什么。
 * 必须靠 003_touch_updated_at.sql 的触发器把 NEW.updated_at 强制改成 NOW()。
 *
 * 一旦某个环境漏跑了 003，故障是**静默**的：网站照常工作、同步照常成功，
 * 只有「两台设备时钟差得较多时后写的数据被先写的覆盖」这一条会失效，且不留任何痕迹。
 * 所以必须有这个能在几秒内跑完的探针。
 *
 * 用法（会真实写一次数据库，但会把 data 原样还原）：
 *   QZ_USER=you@example.com QZ_PASS='...' node scripts/qa-updated-at.mjs
 * 只读检查（不写，因此只能验证「触发器存在」这一半）：
 *   QZ_USER=... QZ_PASS=... node scripts/qa-updated-at.mjs --dry
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'lib', 'supabase.ts');

/* 配置从环境变量取（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY），
   和站点自己用的是同一份，避免这份脚本再抄一遍、将来改了配置忘了改脚本。
   anon key 本来就是公开信息（安全性由 RLS 保证），但仍不硬编码进源码。 */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function readProjectConfig() {
  // 优先环境变量，其次 .env.local / .env（与 vite 的加载顺序一致）
  const fileEnv = { ...readEnvFile(join(HERE, '..', '.env')), ...readEnvFile(join(HERE, '..', '.env.local')) };
  const url = process.env.VITE_SUPABASE_URL || fileEnv.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      '没找到 Supabase 配置。请在项目根目录 .env.local 里填 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY，'
      + '或用环境变量传入（见 .env.example）。',
    );
  }
  return { url, key };
}

const DRY = process.argv.includes('--dry');
const USER = process.env.QZ_USER;
const PASS = process.env.QZ_PASS;
const TOLERANCE_MS = 5 * 60 * 1000; // 允许的服务端时间与本机偏差

if (!USER || !PASS) {
  console.error('缺 QZ_USER / QZ_PASS。用法：');
  console.error("  QZ_USER=you@example.com QZ_PASS='...' node scripts/qa-updated-at.mjs");
  console.error('  （加 --dry 则只读，不写任何数据）');
  process.exit(2);
}

const { url, key } = readProjectConfig();
const base = { apikey: key, 'Content-Type': 'application/json' };
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };

const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: base, body: JSON.stringify({ email: USER, password: PASS }),
}).then((r) => r.json());

if (!auth.access_token) {
  console.error('❌ 登录失败：', JSON.stringify(auth).slice(0, 200));
  process.exit(1);
}
const uid = auth.user.id;
const H = { ...base, Authorization: `Bearer ${auth.access_token}` };
const readRow = async () => {
  const rows = await fetch(`${url}/rest/v1/profiles?user_id=eq.${uid}&select=updated_at,data`, { headers: H }).then((r) => r.json());
  return rows[0];
};

const before = await readRow();
if (!before) { console.error('❌ 该账号没有 profiles 行（先登录一次网站再说）'); process.exit(1); }
console.log(`账号 ${USER}\n写入前 updated_at = ${before.updated_at}`);

if (DRY) {
  console.log('\n--dry：到此为止，没有写入。');
  process.exit(0);
}

/* 关键设计：必须同时放一个**哨兵**进 data。
   第一版探针只传了一个假的 updated_at，看到 updated_at 没变就断言「有触发器」——
   实际是那次 upsert 因为缺 ?on_conflict=user_id 被 PostgREST 当成纯 INSERT 返回了 409，
   整个写入根本没发生。**先把「写进去了」证明掉，再谈这一列的值。** */
const BOGUS = '2000-01-01T00:00:00.000Z';
const sentinel = `QA-PROBE-${Date.now()}`;
const probe = { ...(before.data || {}), __updated_at_probe: sentinel };

const w = await fetch(`${url}/rest/v1/profiles?on_conflict=user_id`, {
  method: 'POST',
  headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({ user_id: uid, data: probe, updated_at: BOGUS }),
});
if (!w.ok) {
  console.error(`❌ 写入失败 HTTP ${w.status}：${(await w.text()).slice(0, 200)}`);
  process.exit(1);
}

const after = await readRow();
ok(after?.data?.__updated_at_probe === sentinel, '写入确实生效了（哨兵已在库中）');
const got = after?.updated_at;
/* 时间戳一律按时刻比，不能按字符串比：
   Postgres 回的是 '2000-01-01T00:00:00+00:00'，而假时间是 '2000-01-01T00:00:00.000Z'，
   两者是**同一时刻的不同写法**，字符串比较会把它们判成不同 —— 探针第一版就栽在这里，
   把「客户端时间被原样存下」误报成了「服务端已接管」。 */
const stored = new Date(got).getTime();
const bogusMs = new Date(BOGUS).getTime();
ok(stored !== bogusMs, `服务端没有接受客户端给的假时间（读回 ${got}）`);
const skew = Math.abs(stored - Date.now());
ok(Number.isFinite(skew) && skew < TOLERANCE_MS, `读回的时间接近当前时刻（偏差 ${Math.round(skew / 1000)} 秒）`);

if (stored === bogusMs) {
  console.log('\n→ 结论：profiles 上没有 touch_updated_at 触发器。');
  console.log('  多设备防覆盖目前依赖的是**写入设备的本机时钟**。');
  console.log('  修法：在 Supabase SQL Editor 里跑 supabase/migrations/003_touch_updated_at.sql');
} else {
  console.log('\n→ 结论：服务端接管了 updated_at，多设备防覆盖的前提成立。');
}

/* 还原 data（去掉哨兵）。updated_at 不还原：装触发器后它由服务端写，也没法还原成旧值；
   把它当作「刚刚同步过」在语义上是安全的，比留一个伪造的过去时间要好。 */
const restored = { ...(after?.data || {}) };
delete restored.__updated_at_probe;
const rw = await fetch(`${url}/rest/v1/profiles?on_conflict=user_id`, {
  method: 'POST',
  headers: { ...H, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({ user_id: uid, data: restored }),
});
ok(rw.ok, `已还原数据（HTTP ${rw.status}）`);

console.log(failed ? `\n❌ ${failed} 项未通过` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
