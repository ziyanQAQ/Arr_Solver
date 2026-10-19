/**
 * 完全穷举参考求解器（只用于差分验证，不追求速度）
 * =====================================================================
 * 与 `tools/lib/optimizer.mjs` 的**唯一**区别：这里不做任何归并/剪枝。
 *   · 中枢：枚举全部 (h_中枢, A 组, B 组)，不做 (uA,uB) 归并、不做支配剪枝、不挑补位
 *   · 类别：每班 = 可用池里任意"恰好 n 元"的子集（不做签名分组、不做补位规则）
 *   · 班长：h = 1..23 全枚举（不做闭式截断）
 *   · 同类双舱：真笛卡尔积 + 不相交过滤（不做 SOS subset-max）
 *   · 助力：枚举周期 ≤ 3 的每日目标序列（不套固定轮转模板）
 *
 * 评价口径与主求解器一致（这是"同构"的含义）：
 *   两班都稳定 → 闭式；否则逐日模拟取长期值；模拟不收敛 → 该候选不可用。
 *
 * 允许的两件事（不影响"穷举"性质）：crewStats / 模拟结果缓存、一个评估次数上限（超过抛错）。
 */

import {
  EMPTY, sizeOf, subsetsOfSize, toIndices, union, without,
} from './set.mjs';
import {
  SLOTS, COST_BASE, EPS, crewStats, val, buildTimeline, integrate,
  shiftFromRecovery, recoveryTable, simulateFacility, timeToRecoverWrap,
} from './evaluator.mjs';

const charIdOf = (op) => (op && (op.charId || op.name)) || '';

function maskAll(n) {
  let m = EMPTY;
  for (let i = 0; i < n; i += 1) m |= 1n << BigInt(i);
  return m;
}

/** 设施规格（与 optimizer.facilitySpecs 同构，独立实现） */
export function referenceSpecs(cfg) {
  const specs = [];
  if (cfg.hasGuest) {
    specs.push({ key: '会客室', room: '会客室', weights: { 线索: 1 }, cat: '线索', slots: cfg.levels.guestSlots });
  }
  cfg.manufacturing.forEach((cat, i) => specs.push({
    key: `制造舱${i + 1}`, room: '制造舱', weights: { [cat]: 1 }, cat, slots: cfg.levels.manufacturingSlots[i],
  }));
  if (cfg.hasGrow) {
    const pots = {};
    for (const k of Object.keys(cfg.grow)) if (cfg.grow[k] > 0) pots[k] = cfg.grow[k];
    specs.push({ key: '培养舱', room: '培养舱', weights: pots, isGrow: true, cat: '培养', slots: cfg.levels.growSlots });
  }
  return specs;
}

const catOf = (spec) => (spec.isGrow ? '培养' : spec.cat);

/** 中枢全部候选：任意两组不相交的 centerSeats 元子集 × h=1..23，且中枢自身两段 R ≥ C */
export function referenceCenters(ops, cfg) {
  const seats = cfg.centerSlots || SLOTS;
  const universe = maskAll(ops.length);
  const out = [];
  for (const A of subsetsOfSize(universe, seats)) {
    const idsA = toIndices(A);
    for (const B of subsetsOfSize(without(universe, A), seats)) {
      const idsB = toIndices(B);
      const uA = idsA.reduce((s, i) => s + val(ops[i], '中枢', '恢复'), 0);
      const uB = idsB.reduce((s, i) => s + val(ops[i], '中枢', '恢复'), 0);
      for (let hc = 1; hc <= 23; hc += 1) {
        const timeline = buildTimeline({ hCenter: hc, uA, uB });
        const cA = Math.min(1, COST_BASE * hc);
        const cB = Math.min(1, COST_BASE * (24 - hc));
        const rA = integrate(hc, 24, timeline);
        const rB = integrate(0, hc, timeline);
        if (rA < cA - EPS || rB < cB - EPS) continue;
        out.push({
          idxA: idsA, idxB: idsB, maskA: A, maskB: B, uA, uB, hCenter: hc, timeline,
          cA, cB, rA, rB, used: union(A, B),
        });
      }
    }
  }
  return out;
}

/**
 * 主入口。options:
 *   centerMode: 'full' | 'fixed'
 *   center: 固定中枢（centerMode==='fixed' 时必填）
 *   nRange(seats) → 人数候选数组（默认 [seats]；M2 后传 1..seats）
 *   assist: 是否枚举助力（默认跟 cfg.assistOn）
 *   evalCap: 评估次数上限（超过抛错，绝不静默截断）
 */
export function solveReference({ ops, cfg, options = {} }) {
  const specs = referenceSpecs(cfg);
  const byCat = new Map();
  for (const s of specs) {
    const c = catOf(s);
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(s);
  }
  const state = {
    ops,
    cfg,
    cats: cfg.priority.slice(),
    byCat,
    allMask: maskAll(ops.length),
    limits: cfg.limits,
    nRange: options.nRange || ((seats) => [seats]),
    statCache: new Map(),
    planCache: new Map(),
    simCache: new Map(),
    evals: 0,
    evalCap: options.evalCap ?? 80_000_000,
    assist: options.assist !== false && !!cfg.assistOn,
    assistMaxPeriod: options.assistMaxPeriod ?? 3,
  };

  const centers = options.centerMode === 'fixed' ? [options.center] : referenceCenters(ops, cfg);
  let best = null;
  for (const center of centers) {
    const res = refDfs(state, center, 0, center.used, cfg.assistPoints);
    if (!res) continue;
    const cand = { score: res.score, picks: res.picks, center, usedMask: union(center.used, res.usedMask) };
    if (!best || refCompare(cand, best, state) > 0) best = cand;
  }
  return best;
}

// ───────────────────────── 递归（按类别） ─────────────────────────
function refDfs(state, center, catIdx, usedMask, assistLeft) {
  if (catIdx >= state.cats.length) return { score: [], picks: [], usedMask: EMPTY, assistUsed: 0 };
  const cat = state.cats[catIdx];
  const specs = state.byCat.get(cat) || [];
  if (!specs.length) {
    const rest = refDfs(state, center, catIdx + 1, usedMask, assistLeft);
    if (!rest) return null;
    return { score: [0, ...rest.score], picks: rest.picks, usedMask: rest.usedMask, assistUsed: rest.assistUsed };
  }
  const avail = without(state.allMask, usedMask);
  const combos = categoryCombos(state, specs, center, avail, assistLeft);
  if (!combos.length) {
    // 文档 §6.4：该类别记 0 并继续；若为线索（最高优先级）则整条时间轴作废
    if (cat === '线索') return null;
    const rest = refDfs(state, center, catIdx + 1, usedMask, assistLeft);
    if (!rest) return null;
    return { score: [0, ...rest.score], picks: rest.picks, usedMask: rest.usedMask, assistUsed: rest.assistUsed };
  }
  const tol = state.limits.valueTol;
  let maxV = -Infinity;
  for (const c of combos) if (c.value > maxV) maxV = c.value;

  let best = null;
  for (const combo of combos) {
    if (combo.value < maxV - tol) continue;
    const rest = refDfs(state, center, catIdx + 1, union(usedMask, combo.used), assistLeft - combo.assistUsed);
    if (!rest) continue;
    const cand = {
      score: [combo.value, ...rest.score],
      picks: combo.picks.concat(rest.picks),
      usedMask: union(combo.used, rest.usedMask),
      assistUsed: combo.assistUsed + rest.assistUsed,
    };
    if (!best || refCompare(cand, best, state) > 0) best = cand;
  }
  return best;
}

function categoryCombos(state, specs, center, avail, assistLeft) {
  const perFacility = specs.map((spec) => facilityPlans(state, spec, center, avail, assistLeft));
  if (perFacility.some((list) => !list.length)) return [];
  if (perFacility.length === 1) {
    return perFacility[0].map((p) => ({
      value: p.value, picks: [p], used: p.mask, assistUsed: p.assistUsed || 0,
    }));
  }
  if (perFacility.length !== 2) return [];       // 本工具最多 2 座同类设施
  const [A, B] = perFacility;
  const out = [];
  for (const a of A) {
    for (const b of B) {
      if ((a.mask & b.mask) !== 0n) continue;
      const assistUsed = (a.assistUsed || 0) + (b.assistUsed || 0);
      if (assistUsed > assistLeft) continue;
      out.push({ value: a.value + b.value, picks: [a, b], used: union(a.mask, b.mask), assistUsed });
    }
  }
  return out;
}

/** 单设施全部候选：单班 + 两班 × 全部 h；班组 = 任意"恰好 n 元"子集 */
function facilityPlans(state, spec, center, avail, assistLeft) {
  const seats = Math.min(spec.slots || SLOTS, SLOTS);
  const nList = state.nRange(seats).filter((n) => Number.isInteger(n) && n >= 1 && n <= seats);
  const cum = recoveryTable(center.timeline);

  const crews = [];
  for (const n of nList) for (const mask of subsetsOfSize(avail, n)) crews.push({ mask, n });

  const statOf = (c) => {
    const key = `${spec.key}|${c.mask}|${c.n}`;      // 必须带设施：crewStats 依赖 room/weights
    let st = state.statCache.get(key);
    if (!st) { st = crewStats(state.ops, c.mask, spec, c.n); state.statCache.set(key, st); }
    return st;
  };

  const plans = [];
  // 单班
  for (const c of crews) {
    const st = statOf(c);
    const single = singleShiftValue(state, st, center);
    if (single != null) {
      plans.push({
        spec, single: true, h: null, crewA: c.mask, crewB: EMPTY, nA: c.n, nB: 0,
        stA: st, stB: null, mask: c.mask, value: single, assistUsed: 0,
      });
    }
  }
  // 两班
  for (const a of crews) {
    for (const b of crews) {
      if ((a.mask & b.mask) !== 0n) continue;
      const stA = statOf(a);
      const stB = statOf(b);
      const mask = union(a.mask, b.mask);
      for (let h = 1; h <= 23; h += 1) {
        const base = twoShiftValue(state, spec, center, cum, stA, stB, a, b, h);
        if (!base) continue;
        const plan = {
          spec, single: false, h, crewA: a.mask, crewB: b.mask, nA: a.n, nB: b.n,
          stA, stB, mask, value: base.value, stable: base.stable, assistUsed: 0,
        };
        if (state.assist && assistLeft > 0 && !base.stable) {
          const assisted = bestAssist(state, spec, center, plan, assistLeft);
          if (assisted && assisted.value > plan.value) {
            plan.value = assisted.value;
            plan.assist = assisted.assist;
            plan.assistUsed = assisted.assistUsed;
          }
        }
        plans.push(plan);
      }
    }
  }
  return plans;
}

// ───────────────────────── 取值 ─────────────────────────
function countEval(state) {
  state.evals += 1;
  if (state.evals > state.evalCap) {
    throw new Error(`[reference] 评估次数超过上限 ${state.evalCap}，请缩小实例规模`);
  }
}

function singleShiftValue(state, st, center) {
  countEval(state);
  if (!(st.d > EPS)) return null;
  const T = 1 / st.d;
  const tFull = timeToRecoverWrap(1, T, center.timeline);
  const cycle = T + tFull;
  if (!Number.isFinite(cycle) || cycle <= 0) return null;
  return st.unit * T * 24 / cycle;
}

function twoShiftValue(state, spec, center, cum, stA, stB, a, b, h) {
  countEval(state);
  const eA = shiftFromRecovery({ st: stA, len: h, R: cum[24] - cum[h] });
  const eB = shiftFromRecovery({ st: stB, len: 24 - h, R: cum[h] });
  if (eA.stable && eB.stable) {
    return { value: eA.work * stA.unit + eB.work * stB.unit, stable: true };
  }
  const key = `${spec.key}|${a.mask}|${b.mask}|${h}|${center.hCenter}|${center.uA}|${center.uB}`;
  if (!state.simCache.has(key)) {
    const sim = simulateFacility({
      facility: spec,
      ops: state.ops,
      timeline: center.timeline,
      limits: state.limits,
      plan: {
        h, crewA: a.mask, crewB: b.mask, fillCrewA: EMPTY, fillCrewB: EMPTY, nA: a.n, nB: b.n,
      },
    });
    state.simCache.set(key, sim.converged ? sim.avg : null);
  }
  const avg = state.simCache.get(key);
  if (avg == null) return null;                  // 不收敛 → 该候选不可用（与主求解器同口径）
  return { value: avg, stable: false };
}

// ───────────────────────── 助力（周期 ≤ maxPeriod 的全序列） ─────────────────────────
function assistTargetOptions(crewMask, points) {
  const members = toIndices(crewMask);
  const opts = [[]];
  for (const m of members) opts.push([m]);
  if (points >= 2) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) opts.push([members[i], members[j]]);
    }
  }
  return opts;
}

function bestAssist(state, spec, center, plan, assistLeft) {
  const capA = plan.stA.d > EPS ? 1 / plan.stA.d : Infinity;
  const capB = plan.stB.d > EPS ? 1 / plan.stB.d : Infinity;
  const shifts = [];
  if (plan.h > capA + EPS) shifts.push('A');
  if (24 - plan.h > capB + EPS) shifts.push('B');
  if (!shifts.length) return null;
  let best = null;
  const maxPoints = Math.min(2, assistLeft);
  for (const shift of shifts) {
    const crew = shift === 'A' ? plan.crewA : plan.crewB;
    const opts = assistTargetOptions(crew, maxPoints);
    for (let period = 1; period <= state.assistMaxPeriod; period += 1) {
      const total = opts.length ** period;
      if (total > 2000) continue;
      for (let code = 0; code < total; code += 1) {
        let x = code;
        const cycle = [];
        for (let d = 0; d < period; d += 1) {
          cycle.push(opts[x % opts.length]);
          x = Math.floor(x / opts.length);
        }
        if (cycle.every((day) => day.length === 0)) continue;
        const points = Math.max(...cycle.map((day) => day.length));
        if (points > maxPoints) continue;
        const sim = simulateFacility({
          facility: spec,
          ops: state.ops,
          timeline: center.timeline,
          limits: state.limits,
          plan: {
            h: plan.h, crewA: plan.crewA, crewB: plan.crewB,
            fillCrewA: EMPTY, fillCrewB: EMPTY, nA: plan.nA, nB: plan.nB,
          },
          assistPlan: { shift, cycle },
        });
        if (!sim.converged) continue;
        if (!best || sim.avg > best.value) {
          best = { value: sim.avg, assist: { shift, cycle, points }, assistUsed: points };
        }
      }
    }
  }
  return best;
}

// ───────────────────────── 比较（独立实现，不用 comparator） ─────────────────────────
function demandOf(plan) {
  if (plan.single) return 0;
  const a = (plan.stA.d * plan.h) / Math.max(EPS, 24 - plan.h);
  const b = (plan.stB.d * (24 - plan.h)) / Math.max(EPS, plan.h);
  return Math.max(a, b);
}

function facilityOrder(key) {
  const m = /^制造舱(\d)$/.exec(key);
  if (key === '会客室') return 0;
  if (m) return Number(m[1]);
  if (key === '培养舱') return 9;
  return 5;
}

function tieHoursOf(picks) {
  return picks
    .slice()
    .sort((x, y) => facilityOrder(x.spec.key) - facilityOrder(y.spec.key))
    .map((p) => (p.single ? (p.stA.d > EPS ? 1 / p.stA.d : 0) : p.h));
}

function refCompare(a, b, state) {
  const tol = state.limits.valueTol;
  for (let i = 0; i < a.score.length; i += 1) {
    if (Math.abs(a.score[i] - b.score[i]) <= tol) continue;
    return a.score[i] > b.score[i] ? 1 : -1;
  }
  const da = Math.max(0, ...a.picks.map(demandOf));
  const db = Math.max(0, ...b.picks.map(demandOf));
  if (Math.abs(da - db) > tol) return da < db ? 1 : -1;
  const ca = sizeOf(a.usedMask);
  const cb = sizeOf(b.usedMask);
  if (ca !== cb) return ca < cb ? 1 : -1;
  const ha = tieHoursOf(a.picks);
  const hb = tieHoursOf(b.picks);
  for (let i = 0; i < Math.min(ha.length, hb.length); i += 1) {
    if (Math.abs(ha[i] - hb[i]) > tol) return ha[i] > hb[i] ? 1 : -1;
  }
  const sa = toIndices(a.usedMask).map((i) => charIdOf(state.ops[i])).sort();
  const sb = toIndices(b.usedMask).map((i) => charIdOf(state.ops[i])).sort();
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    if (sa[i] !== sb[i]) return sa[i] < sb[i] ? 1 : -1;
  }
  if (sa.length !== sb.length) return sa.length < sb.length ? 1 : -1;
  // 第 6 级：决定性尾序（同一批人、不同班次归属）——与主求解器相同口径
  const oa = occupancyOf(state.ops, a.picks);
  const ob = occupancyOf(state.ops, b.picks);
  for (let i = 0; i < Math.min(oa.length, ob.length); i += 1) {
    if (oa[i] !== ob[i]) return oa[i] < ob[i] ? 1 : -1;
  }
  if (oa.length !== ob.length) return oa.length < ob.length ? 1 : -1;
  return 0;
}

/** 占用串：设施顺序 → A/B 班 charId 升序（§6.8 四级打平后的决定性尾序） */
function occupancyOf(ops, picks) {
  const order = (key) => {
    if (key === '会客室') return 0;
    const m = /^制造舱(\d)$/.exec(key);
    if (m) return Number(m[1]);
    if (key === '培养舱') return 9;
    return 5;
  };
  return picks
    .slice()
    .sort((x, y) => order(x.spec.key) - order(y.spec.key))
    .map((p) => {
      const idsA = toIndices(p.crewA).map((i) => charIdOf(ops[i])).sort();
      const idsB = toIndices(p.crewB).map((i) => charIdOf(ops[i])).sort();
      return `${p.spec.key}|A:${idsA.join(',')}|B:${idsB.join(',')}`;
    });
}

/** 把方案压成可比较的快照（占用集用 charId 表达） */
export function referenceSnapshot(plan, ops) {
  if (!plan) return { feasible: false };
  const occ = plan.picks.map((p) => ({
    spec: p.spec.key,
    single: !!p.single,
    h: p.h,
    A: toIndices(p.crewA).map((i) => charIdOf(ops[i])).sort(),
    B: toIndices(p.crewB).map((i) => charIdOf(ops[i])).sort(),
    nA: p.nA,
    nB: p.nB,
    value: p.value,
  })).sort((x, y) => (x.spec < y.spec ? -1 : x.spec > y.spec ? 1 : 0));
  return {
    feasible: true,
    score: plan.score.slice(),
    center: {
      h: plan.center.hCenter,
      A: plan.center.idxA.map((i) => charIdOf(ops[i])).sort(),
      B: plan.center.idxB.map((i) => charIdOf(ops[i])).sort(),
      uA: plan.center.uA,
      uB: plan.center.uB,
    },
    occupancy: occ,
    usedCount: sizeOf(plan.usedMask),
  };
}
