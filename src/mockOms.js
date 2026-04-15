/**
 * Mock Order Management System
 * Generates realistic order-level data for a21.controlpanel.
 *
 * Usage:
 *   import { generateDay, slotSummaries } from './mockOms';
 *   const orders = generateDay();               // full day of orders
 *   const slots  = slotSummaries(orders);        // 15-min slot aggregates
 *   const slots5 = slotSummaries(orders, 5);     // 5-min slots
 */

/* ── demand curve (orders / hr) ── */
const CURVE = [
  [0, 1.5],
  [1, 1.5],
  [2, 1.5],
  [3, 1.5],
  [4, 1.5],
  [5, 1.5],
  [6, 2],
  [7, 3],
  [8, 6],
  [9, 12],
  [10, 8],
  [11, 6],
  [12, 10],
  [13, 20],
  [14, 15],
  [15, 10],
  [16, 8],
  [17, 10],
  [18, 18],
  [19, 28],
  [20, 38],
  [21, 32],
  [22, 20],
  [23, 10],
  [24, 3],
];

function lerp(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i][0] && x <= pts[i + 1][0]) {
      const t = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
    }
  }
  return pts[pts.length - 1][1];
}

/* ── seeded PRNG (deterministic across runs) ── */
function makePrng(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/* ── captain / packer pool helpers ── */
function capsAt(t, pool) {
  let n = 0;
  if (t >= pool.mIn && t < pool.mOut) n += pool.mN;
  if (t >= pool.eIn && t < pool.eOut) n += pool.eN;
  if (n === 0 && t < pool.mIn) n = pool.overnight;
  return n;
}

function paksAt(t, pool) {
  let n = 0;
  if (t >= pool.mIn && t < pool.mOut) n += pool.mN;
  if (t >= pool.eIn && t < pool.eOut) n += pool.eN;
  if (n === 0 && t < pool.mIn) n = pool.overnight;
  return n;
}

/* ═══════════════════════════════════════════
   generateDay()
   Returns individual order records for one day
   ═══════════════════════════════════════════ */

export function generateDay(opts = {}) {
  const {
    seed = 42,
    demandScale = 1.0,
    curve = CURVE,
    captains = {
      mN: 8,
      mIn: 7,
      mOut: 15,
      eN: 6,
      eIn: 15,
      eOut: 23,
      overnight: 12,
    },
    packers = {
      mN: 6,
      mIn: 8,
      mOut: 16,
      eN: 8,
      eIn: 16,
      eOut: 24,
      overnight: 10,
    },
    avgAssignSec = 55, // seconds from creation → captain assigned
    avgPrepMin = 7, // minutes packing
    avgTransitMin = 18, // minutes one-way transit
    peakTrafficFac = 1.5, // transit multiplier 6-9pm
    slaMinutes = 45, // SLA target: creation → delivery
  } = opts;

  const rand = makePrng(seed);
  const orders = [];
  let t = 0;
  let orderId = 1;

  // Available captain & packer tracking (simple model)
  let capsOnRoad = 0;
  let returnQueue = []; // [{returnAt, n}]

  while (t < 24) {
    const rate = lerp(curve, t) * demandScale;
    if (rate < 0.05) {
      t += 0.1;
      continue;
    }

    // Poisson inter-arrival
    const gap = -Math.log(1 - rand()) / rate;
    t += gap;
    if (t >= 24) break;

    // Process returns
    returnQueue = returnQueue.filter((r) => {
      if (r.returnAt <= t) {
        capsOnRoad = Math.max(0, capsOnRoad - r.n);
        return false;
      }
      return true;
    });

    const totalCaps = capsAt(t, captains);
    const capsAvail = Math.max(0, totalCaps - capsOnRoad);
    const paksNow = paksAt(t, packers);

    // Assignment latency: longer when capacity is thin
    const loadFactor = totalCaps > 0 ? capsOnRoad / totalCaps : 1;
    const assignSec =
      avgAssignSec * (0.6 + rand() * 0.8) * (1 + loadFactor * 1.5);
    const assignedAt = t + assignSec / 3600;

    // Prep latency
    const prepMin = avgPrepMin * (0.5 + rand() * 1.0);
    const packedAt = assignedAt + prepMin / 60;

    // Transit: longer during 18-21h traffic peak
    const peakMult = t >= 18 && t <= 21 ? peakTrafficFac : 1;
    const transitMin = avgTransitMin * (0.6 + rand() * 0.8) * peakMult;
    const deliveredAt = packedAt + transitMin / 60;
    const returnAt = deliveredAt + transitMin / 60; // return leg

    // Track captain usage
    if (capsAvail > 0) {
      capsOnRoad++;
      returnQueue.push({ returnAt, n: 1 });
    }

    const totalMin = (deliveredAt - t) * 60;
    const zoneNames = ["North", "Central", "East", "South"];
    const zone = zoneNames[Math.floor(rand() * 4)];

    orders.push({
      id: orderId++,
      createdAt: t,
      assignedAt,
      packedAt,
      dispatchedAt: packedAt, // dispatched when packed
      deliveredAt,
      assignLatency: assignSec, // seconds
      prepTime: prepMin, // minutes
      transitTime: transitMin, // minutes (one-way)
      roundTrip: transitMin * 2, // minutes
      totalMinutes: totalMin,
      slaMinutes,
      slaBreached: totalMin > slaMinutes,
      zone,
    });
  }

  return orders;
}

/* ═══════════════════════════════════════════
   slotSummaries()
   Aggregates order list into time slots
   ═══════════════════════════════════════════ */

export function slotSummaries(orders, slotMin = 15) {
  const step = slotMin / 60;
  const slots = [];

  for (let h = 0; h < 24; h += step) {
    const end = h + step;

    const arrived = orders.filter((o) => o.createdAt >= h && o.createdAt < end);
    const delivered = orders.filter(
      (o) => o.deliveredAt >= h && o.deliveredAt < end,
    );
    const pending = orders.filter(
      (o) => o.createdAt < end && o.deliveredAt >= end,
    );
    const breached = arrived.filter((o) => o.slaBreached);
    const dispatched = orders.filter(
      (o) => o.dispatchedAt >= h && o.dispatchedAt < end,
    );

    const oldestAge =
      pending.length > 0
        ? Math.round((end - Math.min(...pending.map((o) => o.createdAt))) * 60)
        : 0;

    const avgAssign =
      arrived.length > 0
        ? Math.round(
            arrived.reduce((s, o) => s + o.assignLatency, 0) / arrived.length,
          )
        : 0;
    const avgPrep =
      arrived.length > 0
        ? +(
            arrived.reduce((s, o) => s + o.prepTime, 0) / arrived.length
          ).toFixed(1)
        : 0;
    const avgTransit =
      delivered.length > 0
        ? +(
            delivered.reduce((s, o) => s + o.transitTime, 0) / delivered.length
          ).toFixed(1)
        : 0;
    const avgRoundTrip =
      delivered.length > 0
        ? +(
            delivered.reduce((s, o) => s + o.roundTrip, 0) / delivered.length
          ).toFixed(1)
        : 0;

    // Stack depth: avg orders that were dispatched in same minute window
    // Approximation: dispatched / unique captain trips (unique ~= dispatched for now)
    const stackDepth =
      dispatched.length > 0
        ? +(dispatched.length / Math.max(1, dispatched.length * 0.7)).toFixed(1)
        : 1;

    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);

    slots.push({
      hour: h,
      slot: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      incoming: arrived.length,
      pending: pending.length,
      dispatched: dispatched.length,
      delivered: delivered.length,
      slaBreached: breached.length,
      slaDenom: arrived.length,
      slaRate:
        arrived.length > 0 ? +(breached.length / arrived.length).toFixed(3) : 0,
      oldestAge, // minutes
      avgAssignSec: avgAssign, // seconds
      avgPrepMin: avgPrep, // minutes
      avgTransitMin: avgTransit, // minutes (one-way)
      avgRoundTrip, // minutes
      stackDepth,
      // Derived
      cumDelivered: 0, // filled below
      cumIncoming: 0,
    });
  }

  // Cumulative totals
  let cumD = 0,
    cumI = 0;
  slots.forEach((s) => {
    cumD += s.delivered;
    cumI += s.incoming;
    s.cumDelivered = cumD;
    s.cumIncoming = cumI;
  });

  return slots;
}

/* ═══════════════════════════════════════════
   Convenience: generate + aggregate in one call
   ═══════════════════════════════════════════ */

export function generateDaySlots(opts = {}) {
  const orders = generateDay(opts);
  const slots = slotSummaries(orders, opts.slotMin || 15);
  return { orders, slots, stats: dayStats(orders) };
}

function dayStats(orders) {
  if (!orders.length) return {};
  const totalOrders = orders.length;
  const totalBreached = orders.filter((o) => o.slaBreached).length;
  const avgTotal = +(
    orders.reduce((s, o) => s + o.totalMinutes, 0) / totalOrders
  ).toFixed(1);
  const p95Total = +orders
    .map((o) => o.totalMinutes)
    .sort((a, b) => a - b)
    [Math.floor(totalOrders * 0.95)].toFixed(1);
  const peakSlotOrders = Math.max(
    ...slotSummaries(orders, 15).map((s) => s.incoming),
  );
  return {
    totalOrders,
    totalBreached,
    slaBreachRate: +(totalBreached / totalOrders).toFixed(3),
    avgTotal,
    p95Total,
    peakSlotOrders,
  };
}
