#!/usr/bin/env node
/**
 * 帝江号排班求解器（CLI）
 * =====================================================================
 * 算法见 `documents/计算逻辑/`；本文件只做参数解析、数据装载与输出格式化。
 * 求解在 `tools/lib/optimizer.mjs`，评价在 `evaluator.mjs`，校验在 `verify-plan.mjs`。
 *
 * 用法：
 *   node tools/scheduler.mjs [名单.json] [选项]
 *
 * 选项：
 *   --mfg=1干员1武器 | 2干员 | 2武器        制造舱布局（默认 1干员1武器）
 *   --grow=晶植:9,菌类:0,矿物:0              培养舱槽分布（默认 9 晶植；全 0 则不建培养舱）
 *   --priority=线索,干员经验,武器经验,培养    类别优先级
 *   --levels=center:5,mfg1:3,mfg2:3,grow:3,guest:3  舱室等级
 *   --assist                                启用中枢助力（每天 2 点，按文档 §6.3-5 顺延）
 *   --budget=<节点数>                        候选评价节点上限（默认 2000000）
 *   --time=<毫秒>                            墙钟上限（默认 30000，先到先停）
 *   --data=干员数据                          默认 data/ship-data.json（客户端 TableCfg 解析副本）
 *
 * 名单 JSON：
 *   { "operators": [ { "name": "洛茜", "elite": 4 } ] }
 *   elite = 精英化阶段 0–4；技能档位由技能表按阶段自动推。
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig, validateRoster, MAX_ELITE } from './lib/config.mjs';
import { solveLayout } from './lib/optimizer.mjs';
import { verifyPlan } from './lib/verify-plan.mjs';
import { loadShipData, skillsAtElite } from './lib/ship-data.mjs';
import { crewStats, SLOTS, COST_BASE, REC_BASE, integrateWrap, timeToRecoverWrap, EPS } from './lib/evaluator.mjs';
import { toIndices, sizeOf } from './lib/set.mjs';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));

// ───────────────────────── 数据 ─────────────────────────
// 唯一数据源：data/ship-data.json（客户端 TableCfg 的解析副本，含干员 charId 与帝江号技能）。
const DEFAULT_DATA = path.join(HERE, '..', 'data', 'ship-data.json');

function loadRoster(file, data) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.operators;
  const validated = validateRoster(list, new Set(data.byName.keys()));
  return validated.map((e) => {
    const entry = data.byName.get(e.name);
    const charId = entry && entry.charId;
    if (!charId) throw new Error(`[roster] 「${e.name}」缺少稳定 charId，无法执行最终同分裁决`);
    return { name: e.name, charId, elite: e.elite, skills: skillsAtElite(entry.skills, e.elite) };
  });
}

function fullRoster(data) {
  return data.names.map((name) => {
    const entry = data.byName.get(name);
    if (!entry.charId) throw new Error(`[data] 「${name}」缺少稳定 charId，无法执行最终同分裁决`);
    return { name, charId: entry.charId, elite: MAX_ELITE, skills: skillsAtElite(entry.skills, MAX_ELITE) };
  });
}

// ───────────────────────── 参数 ─────────────────────────
function parseArgs(argv) {
  const a = {
    input: null, data: null, mfg: null, grow: null, levels: null,
    priority: null, budget: null, time: null, assist: false, unknown: [],
  };
  for (const x of argv) {
    if (x.startsWith('--mfg=')) a.mfg = x.slice(6);
    else if (x.startsWith('--grow=')) a.grow = x.slice(7);
    else if (x.startsWith('--priority=')) a.priority = x.slice(11);
    else if (x.startsWith('--levels=')) a.levels = x.slice(9);
    else if (x.startsWith('--budget=')) a.budget = x.slice(9);
    else if (x.startsWith('--time=')) a.time = x.slice(7);
    else if (x === '--assist') a.assist = true;
    else if (x.startsWith('--data=')) a.data = x.slice(7);
    else if (x.startsWith('--')) a.unknown.push(x);
    else a.input = x;
  }
  return a;
}

// ───────────────────────── 输出 ─────────────────────────
const pct = (x, d = 2) => (x * 100).toFixed(d) + '%';
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const hhmm = (h) => {
  if (!Number.isFinite(h)) return '—';
  const total = Math.max(0, h);
  const hh = Math.floor(total);
  const mm = Math.floor((total - hh) * 60);
  const ss = Math.round((((total - hh) * 60) - mm) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const PER_ITEM = { 线索: 24.4444, 干员经验: 24.4444, 武器经验: 9.7778 };
const PER_BATCH = { 晶植: 3, 菌类: 1, 矿物: 1 };
const CATEGORY_ORDER = { 会客室: 0, 制造舱1: 1, 制造舱2: 2, 培养舱: 3 };

function shiftEval(st, len, rs, re, timeline) {
  const C = Math.min(1, st.d * len);
  const R = integrateWrap(rs, re, timeline);
  const stable = R >= C - EPS;
  const restHours = Math.max(0, re - rs);
  const tFull = timeToRecoverWrap(C, rs, timeline, restHours);
  return { C, R, stable, tFull, margin: Number.isFinite(tFull) ? restHours - tFull : -Infinity, d: st.d };
}

/** 培养舱各类的等效小时（批/日 = 等效小时 / 125；件/日再乘每批件数） */
function growKindValues(pick) {
  const out = {};
  const weights = pick.spec.weights || {};
  if (pick.simulation && pick.simulation.avgByKind) return { ...pick.simulation.avgByKind };
  if (pick.single) {
    let total = 0;
    for (const k of Object.keys(weights)) total += weights[k] * (1 + (pick.stA.b[k] || 0));
    for (const k of Object.keys(weights)) {
      out[k] = total > 0 ? pick.trueValue * (weights[k] * (1 + (pick.stA.b[k] || 0)) / total) : 0;
    }
    return out;
  }
  const h = pick.h;
  const hA = pick.stA.d > 0 ? Math.min(h, 1 / pick.stA.d) : h;
  const hB = pick.stB && pick.stB.d > 0 ? Math.min(24 - h, 1 / pick.stB.d) : 0;
  for (const k of Object.keys(weights)) {
    const bA = pick.stA.b[k] || 0;
    const bB = pick.stB ? (pick.stB.b[k] || 0) : 0;
    out[k] = weights[k] * ((1 + 0.4 * pick.nA) * (1 + bA) * hA + (1 + 0.4 * pick.nB) * (1 + bB) * hB);
  }
  return out;
}

function categoryDetail(cat, r, cfg) {
  if (cat === '线索') {
    return `${num(r.value / PER_ITEM.线索, 4)} 张/日　${num((20 * r.value) / PER_ITEM.线索, 2)} 信用/日`;
  }
  if (cat === '干员经验' || cat === '武器经验') {
    return `${num(r.value / PER_ITEM[cat], 4)} 件/日`;
  }
  const byKind = {};
  for (const pick of r.picks) {
    for (const [kind, value] of Object.entries(growKindValues(pick))) byKind[kind] = (byKind[kind] || 0) + value;
  }
  let batches = 0;
  let items = 0;
  for (const k of Object.keys(cfg.grow)) {
    const b = (byKind[k] || 0) / 125;
    batches += b;
    items += b * (PER_BATCH[k] || 1);
  }
  const perKind = Object.entries(byKind)
    .filter(([, v]) => Math.abs(v) > EPS)
    .map(([k, v]) => `${k} ${num(v / 125, 4)} 批`)
    .join('，');
  return `${num(batches, 4)} 批/日（${num(items, 4)} 件/日）${perKind ? `　[${perKind}]` : ''}`;
}

function assistSummary(pick, ops) {
  const a = pick.assist;
  if (!a) return [];
  const names = (list) => list.map((i) => ops[i].name).join('+');
  const points = a.points || a.cycle[0].length;
  const inj = (pick.simulation?.lastInjections || []).slice().sort((x, y) => x.hour - y.hour);
  const window = inj.length
    ? `${hhmm(inj[0].hour)} 起（目标心情 ${pct(inj[0].mood, 1)} ≤ 70%）`
    : '未记录到注入时刻';
  return [
    `    助力：${points} 点/天 → ${a.shift} 班；轮转 ${a.cycle.length} 天：${a.cycle.map((d) => names(d)).join(' / ')}`,
    `    注入时刻：${window}；注入点 ${inj.length} 个${inj.length ? `（心情 ${inj.map((x) => pct(x.mood, 1)).join(' / ')}）` : ''}`,
  ];
}

function render(result, cfg, ops, verification, baseline) {
  const L = [];
  const p = result.plan;
  if (!p) {
    return `未找到方案（停止原因 ${result.status.stopReason}，中枢候选 ${result.status.centersVisited}/${result.status.centersTotal}，搜索节点 ${result.status.nodes}）。`;
  }
  L.push('='.repeat(80));
  L.push('帝江号排班结果');
  L.push('='.repeat(80));
  L.push(`配置：中枢 Lv${cfg.levels.center}｜制造舱 ${cfg.levels.manufacturing.map((level) => `Lv${level}`).join('/')}（${cfg.mfgLabel}）｜培养舱 Lv${cfg.levels.grow}｜会客室 Lv${cfg.levels.guest}｜培养槽 ${Object.entries(cfg.grow).map(([k, v]) => k + v).join(' / ') || '未配置'}`);
  L.push(`优先级：${cfg.priority.join(' > ')}${cfg.assistOn ? '｜助力：开启（2 点/天）' : '｜助力：关闭'}`);
  const reason = {
    'node-budget': `节点预算耗尽（${result.status.nodeLimit}）`,
    'time-budget': `墙钟上限耗尽（${result.status.timeLimitMs} ms）`,
    'non-converged-candidate': `有候选逐日模拟未收敛（${result.status.unresolved} 个）`,
    'approximation-applied': `启用了近似：${result.status.approximations.join('；')}`,
  }[result.status.stopReason];
  L.push(`搜索：中枢候选 ${result.status.centersVisited}/${result.status.centersTotal}，节点 ${result.status.nodes}，逐日模拟 ${result.status.simulated} 次`
    + (reason ? `｜${reason}` : ''));
  if (cfg.assistOn && baseline) {
    L.push(`助力增量：相对关闭助力（同一求解器）　${cfg.priority.map((c, i) => `${c} ${(p.score[i] - (baseline.score[i] || 0) >= 0 ? '+' : '')}${num(p.score[i] - (baseline.score[i] || 0), 4)}`).join('　')}`);
  }
  L.push('');

  const c = p.center;
  L.push('【中枢 · 时间轴】');
  L.push(`  换班 ${String(c.hCenter).padStart(2, '0')}:00　（A 段 0-${c.hCenter}，B 段 ${c.hCenter}-24）`);
  L.push(`  A 组：${c.idxA.map((i) => ops[i].name).join('、')}　=> u = ${pct(c.uA, 0)}，v = ${pct(REC_BASE * (1 + c.uA))}`);
  L.push(`  B 组：${c.idxB.map((i) => ops[i].name).join('、')}　=> u = ${pct(c.uB, 0)}，v = ${pct(REC_BASE * (1 + c.uB))}`);
  L.push(`  中枢自身：A 段 C=${pct(c.cA)} R=${pct(c.rA)}｜B 段 C=${pct(c.cB)} R=${pct(c.rB)}`);
  for (const pair of [[c.hCenter, 'A'], [24 - c.hCenter, 'B']]) {
    if (pair[0] > 1 / COST_BASE + EPS) L.push(`  注意：${pair[1]} 段 ${pair[0]} h > ${num(1 / COST_BASE, 3)} h ⇒ 段尾中枢红脸离岗，u=0`);
  }
  L.push('');

  L.push('【类别汇总】（字典序比较的单位）');
  let total = 0;
  for (const cat of cfg.priority) {
    const r = p.catRes[cat];
    if (!r || r.value <= EPS) { L.push(`  ${cat.padEnd(6)} —（本方案该类无设施）`); continue; }
    total += r.value;
    L.push(`  ${cat.padEnd(6)} ${num(r.value, 4).padStart(11)} 等效小时/日　${categoryDetail(cat, r, cfg)}`);
  }
  L.push(`  ${'合计'.padEnd(6)} ${num(total, 4).padStart(11)} 等效小时/日　※不同类别只作规模参考`);
  L.push('');

  L.push('【设施明细】');
  for (const cat of cfg.priority) {
    const r = p.catRes[cat];
    if (!r || !r.picks.length) continue;
    const picks = r.picks.slice().sort((a, b) => (CATEGORY_ORDER[a.spec.key] ?? 9) - (CATEGORY_ORDER[b.spec.key] ?? 9));
    for (const pick of picks) {
      const names = (m) => toIndices(m).map((i) => ops[i].name).join('、');
      const crew = (m, fillMask) => {
        const skilled = names(m);
        const fillers = toIndices(fillMask || 0n).map((i) => `${ops[i].name}(白板)`);
        return [skilled, ...fillers].filter(Boolean).join('、') || '（空）';
      };
      let detail;
      if (pick.spec.isGrow) {
        const byKind = growKindValues(pick);
        detail = Object.entries(byKind).filter(([, v]) => Math.abs(v) > EPS)
          .map(([kind, value]) => `${kind} ${num(value / 125, 4)} 批/日`).join('，');
      } else {
        detail = `${cat} ${num(pick.trueValue, 4)} 等效小时/日`;
      }
      if (pick.single) {
        L.push(`  ${pick.spec.key}（${cat}）　单班　${detail}`);
        L.push(`    ${crew(pick.crewA, pick.fillCrewA)}　E=${num(pick.stA.unit, 3)}`);
        for (const line of assistSummary(pick, ops)) L.push(line);
        continue;
      }
      L.push(`  ${pick.spec.key}（${cat}）　换班 ${pick.h} / ${24 - pick.h}　${detail}`);
      L.push(`    A 班 0-${pick.h}h　${crew(pick.crewA, pick.fillCrewA)}　E=${num(pick.stA.unit, 3)}`);
      L.push(`    B 班 ${pick.h}-24h　${crew(pick.crewB, pick.fillCrewB)}　E=${num(pick.stB.unit, 3)}`);
      for (const line of assistSummary(pick, ops)) L.push(line);
    }
  }
  L.push('');

  L.push('【心情闭环】（C/R 与回满时间）');
  L.push('  设施       班  h    d         C          R       t满      余量     状态');
  for (const cat of cfg.priority) {
    const r = p.catRes[cat];
    if (!r || !r.picks.length) continue;
    for (const pick of r.picks) {
      if (pick.single) {
        const effective = pick.stA.unit > EPS ? pick.trueValue / pick.stA.unit : 0;
        L.push(`  ${pick.spec.key.padEnd(9)} 单班　长期有效时长 ${num(effective, 3)} h/日（周期模拟）`);
        continue;
      }
      for (const row of [['A', pick.stA, pick.h, pick.h, 24], ['B', pick.stB, 24 - pick.h, 0, pick.h]]) {
        const e = shiftEval(row[1], row[2], row[3], row[4], c.timeline);
        const full = Number.isFinite(e.tFull) ? num(e.tFull, 2).padStart(7) : '     ∞';
        const margin = Number.isFinite(e.margin) ? num(e.margin, 2).padStart(7) : '     —';
        L.push(`  ${pick.spec.key.padEnd(9)} ${row[0]} ${String(row[2]).padStart(2)}h  ${pct(e.d)}  ${pct(e.C).padStart(9)} ${pct(e.R).padStart(9)} ${full} ${margin}  ${e.stable ? '稳定' : '衰减（长期值由模拟算出）'}`);
      }
    }
  }
  L.push('');

  L.push('【自检】');
  L.push(verification.ok ? '  ✔ verifier 通过（人员唯一、人数合法、中枢约束、助力约束、产出可重算）' : `  ✘ ${verification.errors.join('；')}`);
  L.push('');
  L.push('【缺口与备注】');
  L.push(`  占用干员 ${sizeOf(p.usedMask)} / 池 ${ops.length}`);
  if (result.status.gaps && result.status.gaps.length) {
    for (const g of result.status.gaps) L.push(`  缺口：${g.cat} — ${g.reason}（${g.detail}）`);
  }
  if (!cfg.hasGrow) L.push('  培养舱未配置（槽数为 0），不生成班次');
  if (!cfg.assistOn) L.push('  助力关闭：全文只用合并口径；开启用 --assist');

  return L.join('\n');
}

// ───────────────────────── main ─────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length) {
    throw new Error('未知选项：' + args.unknown.join(' ') + '（可用：--assist --mfg= --grow= --levels= --priority= --budget= --time= --data=）');
  }
  const data = loadShipData(args.data || DEFAULT_DATA);
  const ops = args.input ? loadRoster(args.input, data) : fullRoster(data);

  const cfg = normalizeConfig({
    mfg: args.mfg || undefined,
    grow: args.grow ?? undefined,
    levels: args.levels ?? undefined,
    priority: args.priority || undefined,
    budget: args.budget || undefined,
    time: args.time || undefined,
    assist: args.assist,
  });

  const t0 = Date.now();
  const result = solveLayout({ ops, cfg });
  let baseline = null;
  if (cfg.assistOn) {
    // 增量口径：同一求解器关掉助力再跑一遍（用户已确认）
    baseline = solveLayout({ ops, cfg: { ...cfg, assistOn: false, assistPoints: 0 } });
  }
  if (process.env.TIMING) process.stderr.write(`${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  const verification = verifyPlan({ ops, cfg, plan: result.plan });
  process.stdout.write(`${render(result, cfg, ops, verification, baseline ? baseline.plan : null)}\n`);
  if (!verification.ok) process.exitCode = 2;
}

try {
  main();
} catch (e) {
  process.stderr.write(`错误：${e.message}\n`);
  process.exit(1);
}
