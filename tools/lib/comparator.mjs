/**
 * 同分比较（对齐实施方案 §6 与主逻辑 §6.8）
 * 顺序：产出向量 → 中枢平均回复强度 → 占用人数（含机会成本）→ 班长 → charId 升序
 */

import { sizeOf } from './set.mjs';

export const VALUE_TOL = 1e-9;

function cmpNum(a, b, tol, preferSmaller) {
  if (Math.abs(a - b) <= tol) return 0;
  const win = a < b ? 1 : -1;          // 越小越好的项
  return preferSmaller ? win : -win;
}

/**
 * plan/metrics:
 *   { score, centerDemand, usedCount, keepStrength, tieHours, charIds }
 */
export function comparePlans(a, b, cfg) {
  const tol = (cfg && cfg.limits ? cfg.limits.valueTol : VALUE_TOL);

  // 1) 产出向量（字典序，越大越好）
  for (let i = 0; i < a.score.length; i++) {
    if (Math.abs(a.score[i] - b.score[i]) <= tol) continue;
    return a.score[i] > b.score[i] ? 1 : -1;
  }
  // 2) 中枢需求（越小越好）
  const c2 = cmpNum(a.centerDemand, b.centerDemand, tol, true);
  if (c2) return c2;
  // 3) 占用人数（越少越好）；同人数比"剩余池能否保住低优先级满档"（越大越好）
  const c3 = cmpNum(a.usedCount, b.usedCount, 0, true);
  if (c3) return c3;
  const c3b = cmpNum(-a.keepStrength, -b.keepStrength, tol, true);
  if (c3b) return c3b;
  // 4) Compare each facility's tie-break hour in stable facility order.
  const aHours = a.tieHours || [a.hAvg || 0];
  const bHours = b.tieHours || [b.hAvg || 0];
  for (let i = 0; i < Math.min(aHours.length, bHours.length); i += 1) {
    const c4 = cmpNum(aHours[i], bHours[i], tol, false);
    if (c4) return c4;
  }
  if (aHours.length !== bHours.length) return aHours.length > bHours.length ? 1 : -1;
  // 5) charId 升序（越小越优先）
  const n = Math.min(a.charIds.length, b.charIds.length);
  for (let i = 0; i < n; i++) {
    if (a.charIds[i] !== b.charIds[i]) return a.charIds[i] < b.charIds[i] ? 1 : -1;
  }
  if (a.charIds.length !== b.charIds.length) return a.charIds.length < b.charIds.length ? 1 : -1;
  // 6) 决定性尾序（§6.8 四级打平后仍可能"同一批人、不同班次归属"）：
  //    按设施顺序 → A/B 班顺序比较 charId 序列，保证输出可复现。
  const ao = a.occupancy || [];
  const bo = b.occupancy || [];
  for (let i = 0; i < Math.min(ao.length, bo.length); i += 1) {
    if (ao[i] !== bo[i]) return ao[i] < bo[i] ? 1 : -1;
  }
  if (ao.length !== bo.length) return ao.length < bo.length ? 1 : -1;
  return 0;
}

/**
 * 把方案压成"决定性尾序"用的字符串序列：
 * 设施按固定顺序（会客室 → 制造舱1 → 制造舱2 → 培养舱）→ A 班 charId 升序 → B 班 charId 升序。
 */
export function occupancyKeyOf(picks, charIdOf) {
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
    .map((p) => `${p.spec.key}|A:${[...p.crewAIds].sort().join(',')}|B:${[...p.crewBIds].sort().join(',')}`);
}

/** 中枢"平均回复强度需求"：所有班次 max (d·h)/(24−h) */
export function centerDemandOf(shifts) {
  let m = 0;
  for (const s of shifts) {
    if (!s || !Number.isFinite(s.d) || s.d <= 0) continue;
    const need = s.single
      ? (Number.isFinite(s.tFull) && s.tFull > 0 ? 1 / s.tFull : Infinity)
      : (s.d * s.len) / Math.max(1e-9, 24 - s.len);
    if (need > m) m = need;
  }
  return m;
}

export function usedCountOf(masks) {
  let m = 0n;
  for (const x of masks) m |= x;
  return sizeOf(m);
}
