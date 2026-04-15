import { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { generateDaySlots } from "./mockOms";

/* ═══════════════════════════════════════════════════════════════
   SIMULATION ENGINE  (composite stress, order-queue SLA tracking)
═══════════════════════════════════════════════════════════════ */
const DT = 0.25;
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

function runSim(params, curve) {
  const {
    captainMorningN = 8,
    captainMorningIn = 7,
    captainMorningOut = 15,
    captainEveningN = 6,
    captainEveningIn = 15,
    captainEveningOut = 23,
    captainNightN = 0,
    captainNightIn = 23,
    captainNightOut = 24,
    packerMorningN = 6,
    packerMorningIn = 8,
    packerMorningOut = 16,
    packerEveningN = 8,
    packerEveningIn = 16,
    packerEveningOut = 24,
    deliveryBase = 1.0,
    deliveryPeakFactor = 1.5,
    packTime = 0.25,
    l1Threshold = 0.25,
    l2Threshold = 0.5,
    l3Threshold = 0.75,
    l2CallbackFrac = 0.4,
    l3CaptainFrac = 0.2,
    l3PackerFrac = 0.25,
    demandScale = 1.0,
    initialCaptains = 12,
    initialPackers = 10,
    slaThreshold = 15,
    slaWeight = 0.8,
    ageWeight = 0.6,
  } = params;
  const capShift = (t) => {
    let n = 0;
    if (t >= captainMorningIn && t < captainMorningOut) n += captainMorningN;
    if (t >= captainEveningIn && t < captainEveningOut) n += captainEveningN;
    if (captainNightN > 0 && t >= captainNightIn && t < captainNightOut)
      n += captainNightN;
    return n === 0 && t < captainMorningIn ? initialCaptains : n;
  };
  const pakShift = (t) => {
    let n = 0;
    if (t >= packerMorningIn && t < packerMorningOut) n += packerMorningN;
    if (t >= packerEveningIn && t < packerEveningOut) n += packerEveningN;
    return n === 0 && t < packerMorningIn ? initialPackers : n;
  };
  const dTime = (t) =>
    t >= 18 && t <= 21 ? deliveryBase * deliveryPeakFactor : deliveryBase;
  const demand = (t) => Math.max(0, lerp(curve, t) * demandScale);
  let capPipe = [],
    pakPipe = [],
    capRoad = 0,
    pakJob = 0,
    pending = 0,
    delivered = 0,
    stressLag = 0,
    orderQueue = [];
  const ticks = [],
    N = Math.round(24 / DT) + 1;
  for (let i = 0; i < N; i++) {
    const t = i * DT;
    capPipe
      .filter((r) => r.at <= t + DT * 0.01 && r.at > t - DT * 0.99)
      .forEach((r) => {
        capRoad = Math.max(0, capRoad - r.n);
      });
    capPipe = capPipe.filter(
      (r) => !(r.at <= t + DT * 0.01 && r.at > t - DT * 0.99),
    );
    pakPipe
      .filter((r) => r.at <= t + DT * 0.01 && r.at > t - DT * 0.99)
      .forEach((r) => {
        pakJob = Math.max(0, pakJob - r.n);
      });
    pakPipe = pakPipe.filter(
      (r) => !(r.at <= t + DT * 0.01 && r.at > t - DT * 0.99),
    );
    const l1 = stressLag > l1Threshold ? 1 : 0,
      l2 = stressLag > l2Threshold ? 1 : 0,
      l3 = stressLag > l3Threshold ? 1 : 0,
      mult = l1 ? 2 : 1;
    const cs = capShift(t),
      ps = pakShift(t);
    const ec = cs + cs * l2CallbackFrac * l2 + cs * l3CaptainFrac * l3,
      ep = ps + ps * l3PackerFrac * l3;
    const ca = Math.max(0, ec - capRoad),
      pa = Math.max(0, ep - pakJob);
    const inc = demand(t) * DT;
    pending = Math.max(0, pending + inc);
    if (inc > 0) orderQueue.push({ at: t, qty: inc });
    const cap = Math.min(ca * mult, pa),
      disp = Math.max(0, Math.min(pending, cap));
    if (disp > 0) {
      const cn = Math.ceil(disp / mult);
      capRoad = Math.min(ec, capRoad + cn);
      pakJob = Math.min(ep, pakJob + disp);
      capPipe.push({ at: t + dTime(t), n: cn });
      pakPipe.push({ at: t + packTime, n: disp });
      pending = Math.max(0, pending - disp);
      delivered += disp;
      let td = disp;
      while (td > 0 && orderQueue.length > 0) {
        if (orderQueue[0].qty <= td) {
          td -= orderQueue[0].qty;
          orderQueue.shift();
        } else {
          orderQueue[0].qty -= td;
          td = 0;
        }
      }
    }
    const oldestAge = orderQueue.length > 0 ? (t - orderQueue[0].at) * 60 : 0;
    const slaBreachedQty = orderQueue
      .filter((b) => (t - b.at) * 60 > slaThreshold)
      .reduce((s, b) => s + b.qty, 0);
    const totalPendQty = orderQueue.reduce((s, b) => s + b.qty, 0);
    const slaRate = totalPendQty > 0 ? slaBreachedQty / totalPendQty : 0;
    const baseStress =
      ec * mult > 0 ? Math.min(1, pending / (ec * mult)) : pending > 0 ? 1 : 0;
    const slaStress = Math.min(1, slaRate),
      ageStress = Math.min(1, oldestAge / slaThreshold);
    const stress = Math.min(
      1,
      Math.max(baseStress, slaStress * slaWeight, ageStress * ageWeight),
    );
    ticks.push({
      t,
      incomingOrders: inc / DT,
      pendingOrders: pending,
      deliveredOrders: delivered,
      capsOnShift: cs,
      capsAvail: ca,
      capsOnRoad: capRoad,
      effCaps: ec,
      paksOnShift: ps,
      paksAvail: pa,
      effPaks: ep,
      dispatchRate: disp / DT,
      dispatchCap: cap,
      stressIndex: stress,
      baseStress,
      slaStress,
      ageStress,
      l1,
      l2,
      l3,
      mult,
      fillRate: delivered + pending > 0 ? delivered / (delivered + pending) : 1,
      capUtil: ec > 0 ? capRoad / ec : 0,
      pakUtil: ep > 0 ? pakJob / ep : 0,
      oldestAge,
      slaBreached: slaBreachedQty,
      slaRate,
      roundTripMin: dTime(t) * 60,
      captTrips: disp > 0 ? Math.ceil(disp / mult) : 0,
      stackDepth: mult,
      assignSec: Math.max(5, 60 * (1 + stress * 2)),
      prepMin: packTime * 60,
      dispatched: disp / DT,
    });
    stressLag = stress;
  }
  return ticks;
}

/* ═══════════════════════════════════════════════════════════════ */
const BASE_CURVE = [
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
const STATIONS = [
  { id: "hub-central", label: "Central Hub" },
  { id: "hub-north", label: "North Hub" },
  { id: "hub-east", label: "East Hub" },
];

function buildDates() {
  const out = [];
  const today = new Date();
  for (let i = 10; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
    const monName = d.toLocaleDateString("en-US", { month: "short" });
    out.push({
      iso,
      label: `${dayName} ${d.getDate()} ${monName}${i === 0 ? " (today)" : ""}`,
      seed: 42 + i * 17 + d.getDay() * 3,
      isToday: i === 0,
    });
  }
  return out;
}
const DATES = buildDates();
const EVENT_MARKERS = [
  { hour: 7, label: "Morning shift in" },
  { hour: 12, label: "Lunch peak" },
  { hour: 15, label: "Shift changeover" },
  { hour: 18, label: "Dinner ramp" },
  { hour: 20, label: "Sun peak" },
  { hour: 23, label: "Evening shift out" },
];

const INTERVENTIONS = [
  {
    id: "l1",
    label: "Activate L1 — 2 orders/trip",
    changes: { l1Threshold: 0 },
    level: "l1",
    impact: "Doubles captain throughput",
  },
  {
    id: "l2",
    label: "Activate L2 — Recall captains",
    changes: { l2Threshold: 0 },
    level: "l2",
    impact: "+40% captain pool via off-shift callback",
  },
  {
    id: "l3",
    label: "Activate L3 — All-hands",
    changes: { l3Threshold: 0 },
    level: "l3",
    impact: "+20% captains, +25% packers emergency",
  },
  {
    id: "cap+2",
    label: "+2 evening captains",
    changes: { captainEveningN: 8 },
    level: "staff",
    impact: "6 → 8 captains on evening shift",
  },
  {
    id: "cap+4",
    label: "+4 evening captains",
    changes: { captainEveningN: 10 },
    level: "staff",
    impact: "6 → 10 captains on evening shift",
  },
  {
    id: "pak+2",
    label: "+2 evening packers",
    changes: { packerEveningN: 10 },
    level: "staff",
    impact: "8 → 10 packers on evening shift",
  },
  {
    id: "earlyL1",
    label: "Lower L1 threshold → 15%",
    changes: { l1Threshold: 0.15 },
    level: "tune",
    impact: "Activates 2-order trips earlier",
  },
  {
    id: "earlyL2",
    label: "Lower L2 threshold → 35%",
    changes: { l2Threshold: 0.35 },
    level: "tune",
    impact: "Triggers captain recall sooner",
  },
];

const DEFAULTS = {
  captainMorningN: 8,
  captainMorningIn: 7,
  captainMorningOut: 15,
  captainEveningN: 6,
  captainEveningIn: 15,
  captainEveningOut: 23,
  captainNightN: 0,
  captainNightIn: 23,
  captainNightOut: 24,
  packerMorningN: 6,
  packerMorningIn: 8,
  packerMorningOut: 16,
  packerEveningN: 8,
  packerEveningIn: 16,
  packerEveningOut: 24,
  deliveryBase: 1.0,
  deliveryPeakFactor: 1.5,
  packTime: 0.25,
  l1Threshold: 0.25,
  l2Threshold: 0.5,
  l3Threshold: 0.75,
  l2CallbackFrac: 0.4,
  l3CaptainFrac: 0.2,
  l3PackerFrac: 0.25,
  demandScale: 1.0,
  initialCaptains: 12,
  initialPackers: 10,
  slaThreshold: 15,
  slaWeight: 0.8,
  ageWeight: 0.6,
};

const PARAM_SCHEMA = [
  { section: "Stress formula" },
  {
    id: "slaThreshold",
    label: "SLA threshold",
    unit: "min",
    min: 5,
    max: 60,
    step: 1,
    fmt: (x) => x + " min",
  },
  {
    id: "slaWeight",
    label: "SLA stress weight",
    min: 0,
    max: 1,
    step: 0.05,
    fmt: (x) => x.toFixed(2),
  },
  {
    id: "ageWeight",
    label: "Age stress weight",
    min: 0,
    max: 1,
    step: 0.05,
    fmt: (x) => x.toFixed(2),
  },
  { section: "Lever thresholds" },
  {
    id: "l1Threshold",
    label: "L1 threshold",
    min: 0.05,
    max: 0.5,
    step: 0.05,
    fmt: (x) => (x * 100).toFixed(0) + "%",
  },
  {
    id: "l2Threshold",
    label: "L2 threshold",
    min: 0.2,
    max: 0.75,
    step: 0.05,
    fmt: (x) => (x * 100).toFixed(0) + "%",
  },
  {
    id: "l3Threshold",
    label: "L3 threshold",
    min: 0.4,
    max: 0.95,
    step: 0.05,
    fmt: (x) => (x * 100).toFixed(0) + "%",
  },
  { section: "Lever capacity" },
  {
    id: "l2CallbackFrac",
    label: "L2 callback fraction",
    min: 0.1,
    max: 1.0,
    step: 0.05,
    fmt: (x) => (x * 100).toFixed(0) + "%",
  },
  {
    id: "l3CaptainFrac",
    label: "L3 captain fraction",
    min: 0.05,
    max: 0.5,
    step: 0.05,
    fmt: (x) => (x * 100).toFixed(0) + "%",
  },
  {
    id: "l3PackerFrac",
    label: "L3 packer fraction",
    min: 0.05,
    max: 0.5,
    step: 0.05,
    fmt: (x) => (x * 100).toFixed(0) + "%",
  },
  { section: "Shift headcount" },
  {
    id: "captainMorningN",
    label: "Capt. morning",
    min: 0,
    max: 30,
    step: 1,
    fmt: (x) => x,
  },
  {
    id: "captainEveningN",
    label: "Capt. evening",
    min: 0,
    max: 30,
    step: 1,
    fmt: (x) => x,
  },
  {
    id: "packerMorningN",
    label: "Pack. morning",
    min: 0,
    max: 30,
    step: 1,
    fmt: (x) => x,
  },
  {
    id: "packerEveningN",
    label: "Pack. evening",
    min: 0,
    max: 30,
    step: 1,
    fmt: (x) => x,
  },
  { section: "Delivery" },
  {
    id: "deliveryBase",
    label: "Base round-trip (hr)",
    min: 0.25,
    max: 4,
    step: 0.25,
    fmt: (x) => x + "hr",
  },
  {
    id: "deliveryPeakFactor",
    label: "Peak traffic factor",
    min: 1,
    max: 3,
    step: 0.1,
    fmt: (x) => x.toFixed(1) + "×",
  },
  {
    id: "packTime",
    label: "Pack time (hr)",
    min: 0.08,
    max: 0.5,
    step: 0.02,
    fmt: (x) => Math.round(x * 60) + "min",
  },
];

function hLabel(h) {
  if (h >= 24) h -= 24;
  const hh = Math.floor(h),
    mm = Math.round((h - hh) * 60);
  const ampm = hh < 12 ? "am" : "pm";
  const d = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  return mm === 0
    ? `${d}${ampm}`
    : `${d}:${String(mm).padStart(2, "0")}${ampm}`;
}

/* ═══════════════════════════════════════════════════════════════
   MONITOR CHART DATA — OMS actuals + sim capacity, clean lines
═══════════════════════════════════════════════════════════════ */
function buildMonitorData(omsSlots, baseTicks, nowHour, wiTicks) {
  const windowStart = nowHour - 1;
  const rows = omsSlots
    .filter((s) => s.hour >= windowStart && s.hour <= nowHour)
    .map((s) => {
      const sim = baseTicks.find((t) => Math.abs(t.t - s.hour) < 0.13) || {};
      return {
        hour: s.hour,
        pending: s.pending,
        incoming: s.incoming * 4,
        capsOnShift: Math.round(sim.capsOnShift || 0),
        capsAvail: Math.round(sim.capsAvail || 0),
        stress: Math.round((sim.stressIndex || 0) * 100),
      };
    });

  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    last.fc_stress = last.stress;
    last.fc_pending = last.pending;
    last.fc_incoming = last.incoming;
    last.fc_caps = last.capsAvail;
    last.stress_hi = last.stress;
    last.stress_lo = last.stress;
    last.pending_hi = last.pending;
    last.pending_lo = last.pending;
    last.incoming_hi = last.incoming;
    last.incoming_lo = last.incoming;
    last.caps_hi = last.capsAvail;
    last.caps_lo = last.capsAvail;
  }

  const ci15 = 0.03,
    ci30 = 0.06;
  [
    { dt: 0.25, ci: ci15 },
    { dt: 0.5, ci: ci30 },
  ].forEach(({ dt, ci }) => {
    const fh = nowHour + dt;
    const sim = baseTicks.find((t) => Math.abs(t.t - fh) < 0.13) || {};
    const wi = wiTicks && wiTicks.find((t) => Math.abs(t.t - fh) < 0.13);
    const st = (sim.stressIndex || 0) * 100;
    const pn = sim.pendingOrders || 0;
    const inc = sim.incomingOrders || 0;
    const cap = sim.capsAvail || 0;
    rows.push({
      hour: fh,
      pending: null,
      incoming: null,
      capsOnShift: null,
      capsAvail: null,
      stress: null,
      fc_stress: Math.round(st),
      fc_pending: Math.round(pn),
      fc_incoming: Math.round(inc),
      fc_caps: Math.round(cap),
      stress_hi: Math.min(100, Math.round(st * (1 + ci))),
      stress_lo: Math.max(0, Math.round(st * (1 - ci))),
      pending_hi: Math.round(pn * (1 + ci)),
      pending_lo: Math.max(0, Math.round(pn * (1 - ci))),
      incoming_hi: Math.round(inc * (1 + ci)),
      incoming_lo: Math.max(0, Math.round(inc * (1 - ci))),
      caps_hi: Math.round(cap + 1),
      caps_lo: Math.max(0, Math.round(cap - 1)),
      wi_stress: wi ? Math.round((wi.stressIndex || 0) * 100) : null,
      wi_pending: wi ? Math.round(wi.pendingOrders || 0) : null,
      wi_caps: wi ? Math.round(wi.capsAvail || 0) : null,
    });
  });

  if (wiTicks && rows.length > 0) {
    const bridgeIdx = rows.findIndex((r) => r.hour === nowHour);
    if (bridgeIdx >= 0) {
      rows[bridgeIdx].wi_stress = rows[bridgeIdx].stress;
      rows[bridgeIdx].wi_pending = rows[bridgeIdx].pending;
      rows[bridgeIdx].wi_caps = rows[bridgeIdx].capsAvail;
    }
  }

  return rows;
}

/* ═══════════════════════════════════════════════════════════════
   ALERT + AI GENERATORS
═══════════════════════════════════════════════════════════════ */
function generateAlerts(ticks, now, p) {
  const a = [],
    f = ticks.filter((t) => t.t > now && t.t <= now + 0.5);
  const first = (th) => f.find((t) => t.stressIndex > th);
  const l1t = first(p.l1Threshold),
    l2t = first(p.l2Threshold),
    l3t = first(p.l3Threshold);
  if (l1t) {
    const m = Math.round((l1t.t - now) * 60);
    a.push({
      id: "l1",
      sev: m < 15 ? "high" : "medium",
      time: l1t.t,
      mins: m,
      title: "L1 crossing in " + m + " min",
      detail: `Stress > ${(p.l1Threshold * 100).toFixed(0)}% at ${hLabel(l1t.t)}. base=${(l1t.baseStress * 100).toFixed(0)}% sla=${(l1t.slaStress * 100).toFixed(0)}% age=${(l1t.ageStress * 100).toFixed(0)}%`,
    });
  }
  if (l2t) {
    const m = Math.round((l2t.t - now) * 60);
    a.push({
      id: "l2",
      sev: "critical",
      time: l2t.t,
      mins: m,
      title: "L2 crossing in " + m + " min",
      detail: `Stress > ${(p.l2Threshold * 100).toFixed(0)}% at ${hLabel(l2t.t)}. Recall captains.`,
    });
  }
  if (l3t) {
    const m = Math.round((l3t.t - now) * 60);
    a.push({
      id: "l3",
      sev: "critical",
      time: l3t.t,
      mins: m,
      title: "L3 crossing in " + m + " min",
      detail: `Stress > ${(p.l3Threshold * 100).toFixed(0)}% at ${hLabel(l3t.t)}. All-hands.`,
    });
  }
  return a;
}

function generateAIRecs(alerts, now, p) {
  if (!alerts.length)
    return [
      {
        agent: "ops-advisor",
        confidence: 0.95,
        sev: "ok",
        interventionId: null,
        analysis: "No threshold crossings in next 30 min. Staffing adequate.",
        rootCause: "N/A",
        action: "Continue monitoring.",
      },
    ];
  const recs = [];
  const l2a = alerts.find((a) => a.id === "l2"),
    l1a = alerts.find((a) => a.id === "l1");
  if (l2a) {
    const recall = Math.round(p.captainEveningN * p.l2CallbackFrac);
    recs.push({
      agent: "capacity-analyst",
      confidence: 0.87,
      sev: "high",
      interventionId: "l2",
      analysis: `Stress will exceed L2 in ${l2a.mins} min. Evening captains (${p.captainEveningN}) insufficient.`,
      rootCause: "Demand exceeding dispatch capacity",
      action: `Issue L2 recall — mobilise ${recall} off-shift captains. Use What-If to verify.`,
    });
  } else if (l1a) {
    recs.push({
      agent: "capacity-analyst",
      confidence: 0.82,
      sev: "medium",
      interventionId: "l1",
      analysis: `Stress approaching L1 in ${l1a.mins} min. L1 auto-activation should suffice.`,
      rootCause: "Normal peak pattern",
      action: `Brief captains for 2-order trips.`,
    });
  }
  return recs;
}

/* ═══════════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════════ */
const DARK_T = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  surface2: "#222222",
  border: "#2a2a2a",
  accent: "#D4C919",
  accentDim: "#2a2700",
  accentFg: "#0f0f0f",
  textHi: "#f0ede6",
  textMid: "#a09a8e",
  textLo: "#5a5550",
  red: "#e05252",
  redBg: "#2a1010",
  redBd: "#4a2020",
  amber: "#d4900a",
  amberBg: "#2a1e00",
  amberBd: "#4a3000",
  green: "#34d399",
  greenBg: "#0d2010",
  greenBd: "#1a4020",
  yellow: "#D4C919",
  yellowBg: "#2a2700",
  yellowBd: "#3a3500",
  blue: "#60a5fa",
  blueBg: "#0d1520",
  blueBd: "#1a2a40",
  series: {
    incoming: "#e05252",
    pending: "#d4900a",
    shift: "#9d94f0",
    avail: "#34d399",
    stress: "#60a5fa",
  },
  chartGrid: "rgba(255,255,255,.04)",
  scrubberHighlight: "rgba(212,201,25,.12)",
};
const LIGHT_T = {
  bg: "#f5f3ee",
  surface: "#ffffff",
  surface2: "#edeae3",
  border: "#dedad0",
  accent: "#2563a8",
  accentDim: "#eaf1fb",
  accentFg: "#ffffff",
  textHi: "#1c1a16",
  textMid: "#9c9484",
  textLo: "#c8c3b6",
  red: "#c0392b",
  redBg: "#fdecea",
  redBd: "#f5c6cb",
  amber: "#b85c00",
  amberBg: "#fef4e6",
  amberBd: "#fed7aa",
  green: "#1a7f5a",
  greenBg: "#eaf5ee",
  greenBd: "#86efac",
  yellow: "#ca8a04",
  yellowBg: "#fefce8",
  yellowBd: "#fde68a",
  blue: "#1a5fa8",
  blueBg: "#eaf1fb",
  blueBd: "#bfdbfe",
  series: {
    incoming: "#c0392b",
    pending: "#b85c00",
    shift: "#7c6fcd",
    avail: "#1a7f5a",
    stress: "#1a5fa8",
  },
  chartGrid: "rgba(0,0,0,.05)",
  scrubberHighlight: "rgba(37,99,168,.18)",
};

const M = "'DM Mono','IBM Plex Mono',monospace";

function Tip({ active, payload, label, T }) {
  const theme = T || DARK_T;
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "8px 12px",
        fontSize: 11,
        boxShadow: "0 4px 12px rgba(0,0,0,.3)",
      }}
    >
      <div
        style={{
          fontFamily: M,
          fontSize: 10,
          color: theme.textMid,
          marginBottom: 5,
        }}
      >
        {typeof label === "number" ? hLabel(label) : label}
      </div>
      {payload
        .filter((p) => p.value != null)
        .map((p, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 2,
            }}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: p.color,
              }}
            />
            <span style={{ color: theme.textMid, flex: 1 }}>{p.name}</span>
            <span
              style={{ fontFamily: M, fontWeight: 500, color: theme.textHi }}
            >
              {typeof p.value === "number" ? p.value.toFixed(1) : p.value}
            </span>
          </div>
        ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   APP
═══════════════════════════════════════════════════════════════ */
export default function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [leftTab, setLeftTab] = useState("live");
  const [rightTab, setRightTab] = useState("monitor");
  const [stationId, setStationId] = useState("hub-central");
  const [currentDate, setCurrentDate] = useState(DATES[DATES.length - 1].iso);
  const [nowHour, setNowHour] = useState(() => {
    const d = new Date();
    return Math.round((d.getHours() + d.getMinutes() / 60) * 4) / 4;
  });
  const [selectedInterventions, setSelectedInterventions] = useState([]);
  const [wiActive, setWiActive] = useState(false);
  const [cfg, setCfg] = useState({ ...DEFAULTS });
  const [visible, setVisible] = useState({
    incoming: true,
    pending: true,
    capsOnShift: false,
    capsAvail: true,
    stress: true,
  });
  const toggleSeries = (k) => setVisible((v) => ({ ...v, [k]: !v[k] }));
  const [acceptedByAI, setAcceptedByAI] = useState(new Set());

  const handleAccept = (interventionId) => {
    if (!interventionId) return;
    setSelectedInterventions((p) =>
      p.includes(interventionId) ? p : [...p, interventionId],
    );
    setAcceptedByAI((s) => new Set([...s, interventionId]));
    setWiActive(true);
    setRightTab("monitor");
  };

  const runDemo = () => {
    setNowHour(19.0);
    setCurrentDate(DATES[DATES.length - 1].iso);
    setSelectedInterventions([]);
    setWiActive(false);
    setAcceptedByAI(new Set());
    setLeftTab("alerts");
    setRightTab("agents");
  };

  const T = darkMode ? DARK_T : LIGHT_T;

  const S = {
    app: {
      fontFamily: "'DM Sans','IBM Plex Sans',sans-serif",
      background: T.bg,
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      color: T.textHi,
      fontSize: 13,
    },
    header: {
      background: T.surface,
      borderBottom: `1px solid ${T.border}`,
      padding: "0 24px",
      height: 52,
      display: "flex",
      alignItems: "center",
      gap: 14,
      flexShrink: 0,
      position: "sticky",
      top: 0,
      zIndex: 100,
      boxShadow: darkMode
        ? "0 1px 3px rgba(0,0,0,.4)"
        : "0 1px 3px rgba(0,0,0,.06)",
    },
    badge: (c, bg, bd) => ({
      fontFamily: M,
      fontSize: 9,
      letterSpacing: ".1em",
      textTransform: "uppercase",
      background: bg || T.surface2,
      border: `1px solid ${bd || T.border}`,
      borderRadius: 3,
      padding: "2px 8px",
      color: c || T.textMid,
    }),
    body: { display: "flex", flex: 1, overflow: "hidden" },
    left: {
      width: 320,
      background: T.surface,
      borderRight: `1px solid ${T.border}`,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      flexShrink: 0,
    },
    right: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    },
    tabs: {
      display: "flex",
      borderBottom: `1px solid ${T.border}`,
      flexShrink: 0,
    },
    tab: (a) => ({
      padding: "8px 16px",
      fontFamily: M,
      fontSize: 10,
      letterSpacing: ".08em",
      textTransform: "uppercase",
      color: a ? T.accent : T.textMid,
      cursor: "pointer",
      borderBottom: a ? `2px solid ${T.accent}` : "2px solid transparent",
      background: "none",
      border: "none",
      marginBottom: "-1px",
    }),
    scroll: { flex: 1, overflowY: "auto", padding: "12px 14px" },
    sh: {
      fontFamily: M,
      fontSize: 9,
      letterSpacing: ".12em",
      textTransform: "uppercase",
      color: T.textMid,
      borderBottom: `1px solid ${T.border}`,
      paddingBottom: 5,
      marginBottom: 10,
    },
    kpiStrip: {
      display: "grid",
      gridTemplateColumns: "repeat(4,1fr)",
      gap: 8,
      padding: "12px 24px",
      borderBottom: `1px solid ${T.border}`,
      flexShrink: 0,
    },
    kpi: (a) => ({
      background:
        a === "crit"
          ? T.redBg
          : a === "high"
            ? T.amberBg
            : a === "med"
              ? T.yellowBg
              : T.surface,
      border: `1px solid ${a === "crit" ? T.redBd : a === "high" ? T.amberBd : a === "med" ? T.yellowBd : T.border}`,
      borderRadius: 6,
      padding: "8px 10px",
    }),
    kL: {
      fontFamily: M,
      fontSize: 9,
      letterSpacing: ".1em",
      textTransform: "uppercase",
      color: T.textMid,
      marginBottom: 3,
    },
    kV: (s) => ({
      fontFamily: M,
      fontSize: 22,
      fontWeight: 500,
      lineHeight: 1,
      color: s > 0.6 ? T.red : s > 0.25 ? T.amber : T.green,
    }),
    kS: { fontFamily: M, fontSize: 9, color: T.textMid, marginTop: 3 },
    btn: (v = "default") => {
      const variants = {
        default: { bg: T.surface2, bd: T.border, c: T.textMid },
        primary: { bg: T.accent, bd: T.accent, c: T.accentFg },
        danger: { bg: T.redBg, bd: T.red, c: T.red },
        success: { bg: T.greenBg, bd: T.green, c: T.green },
        warning: { bg: T.amberBg, bd: T.amber, c: T.amber },
      };
      const t = variants[v] || variants.default;
      return {
        fontFamily: M,
        fontSize: 10,
        letterSpacing: ".06em",
        padding: "7px 14px",
        borderRadius: 6,
        border: `1px solid ${t.bd}`,
        background: t.bg,
        color: t.c,
        cursor: "pointer",
      };
    },
    ac: (sev) => {
      const t = {
        critical: { bg: T.redBg, bd: T.redBd, dot: T.red },
        high: { bg: T.amberBg, bd: T.amberBd, dot: T.amber },
        medium: { bg: T.yellowBg, bd: T.yellowBd, dot: T.yellow },
        info: { bg: T.blueBg, bd: T.blueBd, dot: T.blue },
        ok: { bg: T.greenBg, bd: T.greenBd, dot: T.green },
      }[sev] || { bg: T.surface2, bd: T.border, dot: T.textMid };
      return {
        ...t,
        wrap: {
          background: t.bg,
          border: `1px solid ${t.bd}`,
          borderRadius: 6,
          padding: "10px 12px",
          marginBottom: 8,
        },
      };
    },
    metric: {
      background: T.surface2,
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      padding: "8px 10px",
    },
    mLabel: {
      fontFamily: M,
      fontSize: 9,
      letterSpacing: ".1em",
      textTransform: "uppercase",
      color: T.textMid,
      marginBottom: 3,
    },
    mVal: {
      fontFamily: M,
      fontSize: 22,
      fontWeight: 500,
      lineHeight: 1,
      color: T.textHi,
    },
    mSub: { fontFamily: M, fontSize: 9, color: T.textMid, marginTop: 3 },
    lever: (on) => ({
      display: "flex",
      alignItems: "center",
      gap: 10,
      fontFamily: M,
      fontSize: 10,
      padding: "7px 10px",
      borderRadius: 6,
      marginBottom: 4,
      border: `1px solid ${on ? T.amberBd : T.border}`,
      background: on ? T.amberBg : T.surface2,
      color: on ? T.amber : T.textMid,
      transition: "all .2s",
    }),
    card: {
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: 10,
      padding: "16px 18px",
      marginBottom: 14,
      boxShadow: darkMode
        ? "0 1px 4px rgba(0,0,0,.4)"
        : "0 1px 3px rgba(0,0,0,.06)",
    },
    cardTitle: {
      fontFamily: M,
      fontSize: 9,
      letterSpacing: ".12em",
      textTransform: "uppercase",
      color: T.textMid,
      marginBottom: 12,
    },
  };

  const dateInfo =
    DATES.find((d) => d.iso === currentDate) || DATES[DATES.length - 1];
  const omsData = useMemo(
    () => generateDaySlots({ seed: dateInfo.seed }),
    [dateInfo.seed],
  );
  const isToday = dateInfo.isToday;

  const baseTicks = useMemo(() => runSim(cfg, BASE_CURVE), [cfg]);
  const wiParams = useMemo(() => {
    const p = { ...cfg };
    selectedInterventions.forEach((id) => {
      const iv = INTERVENTIONS.find((x) => x.id === id);
      if (iv) Object.assign(p, iv.changes);
    });
    return p;
  }, [selectedInterventions, cfg]);
  const wiTicks = useMemo(
    () =>
      wiActive && selectedInterventions.length
        ? runSim(wiParams, BASE_CURVE)
        : null,
    [wiActive, wiParams],
  );

  const monitorData = useMemo(
    () => buildMonitorData(omsData.slots, baseTicks, nowHour, wiTicks),
    [omsData, baseTicks, nowHour, wiTicks],
  );

  const idxNow = Math.min(Math.round(nowHour / DT), baseTicks.length - 1);
  const idx15 = Math.min(idxNow + 1, baseTicks.length - 1);
  const idx30 = Math.min(idxNow + 2, baseTicks.length - 1);
  const tkNow = baseTicks[idxNow],
    tk15 = baseTicks[idx15],
    tk30 = baseTicks[idx30];
  const omsNow =
    omsData.slots.find((s) => Math.abs(s.hour - nowHour) < 0.13) || {};

  const alerts = useMemo(
    () => generateAlerts(baseTicks, nowHour, cfg),
    [baseTicks, nowHour, cfg],
  );
  const aiRecs = useMemo(
    () => generateAIRecs(alerts, nowHour, cfg),
    [alerts, nowHour, cfg],
  );
  const critCount = alerts.filter((a) => a.sev === "critical").length;

  const peakTk = baseTicks
    .filter((t) => t.t >= nowHour)
    .reduce(
      (a, b) => (b.stressIndex > a.stressIndex ? b : a),
      baseTicks[idxNow],
    );
  const wiPeak = wiTicks
    ? wiTicks
        .filter((t) => t.t >= nowHour)
        .reduce(
          (a, b) => (b.stressIndex > a.stressIndex ? b : a),
          wiTicks[idxNow],
        )
    : null;
  const wi15 = wiTicks ? wiTicks[idx15] : null;
  const wi30 = wiTicks ? wiTicks[idx30] : null;
  const selectedLabels = selectedInterventions
    .map((id) => INTERVENTIONS.find((iv) => iv.id === id)?.label)
    .filter(Boolean);

  const toggleIntervention = (id) =>
    setSelectedInterventions((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );
  const updateCfg = (id, v) => setCfg((p) => ({ ...p, [id]: v }));

  return (
    <div style={S.app}>
      {/* ── HEADER ── */}
      <div style={S.header}>
        <img
          src="/a21.ai-logo-black-bg-png-01-01.webp"
          style={{ height: 28, display: "block" }}
          alt="a21"
        />
        <select
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          style={{
            fontFamily: M,
            fontSize: 11,
            padding: "6px 10px",
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            background: T.surface2,
            color: T.textHi,
            cursor: "pointer",
          }}
        >
          {STATIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={currentDate}
          onChange={(e) => setCurrentDate(e.target.value)}
          style={{
            fontFamily: M,
            fontSize: 10,
            letterSpacing: ".06em",
            padding: "4px 8px",
            border: `1px solid ${T.accent}40`,
            borderRadius: 4,
            background: T.accentDim,
            color: T.accent,
            cursor: "pointer",
            textTransform: "uppercase",
          }}
        >
          {DATES.map((d) => (
            <option key={d.iso} value={d.iso}>
              {d.label}
            </option>
          ))}
        </select>
        <div
          style={S.badge(
            isToday ? T.green : T.textMid,
            isToday ? T.greenBg : T.surface2,
            isToday ? T.greenBd : T.border,
          )}
        >
          {isToday ? (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: T.green,
                  display: "inline-block",
                  marginRight: 5,
                  animation: "pulse 1.2s ease-in-out infinite",
                }}
              />
              OMS LIVE
            </>
          ) : (
            "HISTORICAL"
          )}
        </div>
        {critCount > 0 && (
          <div style={S.badge(T.red, T.redBg, T.redBd)}>
            {critCount} ALERT{critCount > 1 ? "S" : ""}
          </div>
        )}
        {wiActive && (
          <div style={S.badge(T.green, T.greenBg, T.greenBd)}>
            WHAT-IF · {selectedInterventions.length} lever
            {selectedInterventions.length !== 1 ? "s" : ""}
          </div>
        )}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontFamily: M, fontSize: 10, color: T.textMid }}>
            {omsData.stats.totalOrders} orders today
          </span>
          <span
            style={{
              fontFamily: M,
              fontSize: 11,
              fontWeight: 500,
              color: T.accent,
              letterSpacing: ".06em",
            }}
          >
            {hLabel(nowHour)}
          </span>
          <button
            style={{
              fontFamily: M,
              fontSize: 9,
              padding: "4px 10px",
              borderRadius: 5,
              border: `1px solid ${T.border}`,
              background: T.surface2,
              color: T.textMid,
              cursor: "pointer",
              letterSpacing: ".06em",
            }}
            onClick={() => setDarkMode((d) => !d)}
          >
            {darkMode ? "☀ Light" : "☾ Dark"}
          </button>
          <button
            style={{
              fontFamily: M,
              fontSize: 9,
              padding: "4px 12px",
              borderRadius: 5,
              border: `1px solid ${T.accent}`,
              background: T.accentDim,
              color: T.accent,
              cursor: "pointer",
              letterSpacing: ".06em",
              fontWeight: 600,
            }}
            onClick={runDemo}
          >
            ▶ Run Demo
          </button>
        </div>
      </div>

      {/* ── KPI STRIP ── */}
      <div style={S.kpiStrip}>
        <div
          style={S.kpi(
            tkNow.stressIndex > 0.5
              ? "crit"
              : tkNow.stressIndex > 0.25
                ? "med"
                : null,
          )}
        >
          <div style={S.kL}>Stress now</div>
          <div style={S.kV(tkNow.stressIndex)}>
            {(tkNow.stressIndex * 100).toFixed(0)}%
          </div>
          <div style={{ height: 3, background: T.surface2, borderRadius: 2, margin: "5px 0 4px", position: "relative" }}>
            <div style={{ height: "100%", width: `${Math.min(100, tkNow.stressIndex * 100)}%`, background: tkNow.stressIndex > 0.5 ? T.red : tkNow.stressIndex > 0.25 ? T.amber : T.green, borderRadius: 2, transition: "width .3s" }} />
            {[cfg.l1Threshold, cfg.l2Threshold, cfg.l3Threshold].map((th, i) => (
              <div key={i} style={{ position: "absolute", left: `${th * 100}%`, top: 0, height: "100%", width: 1, background: T.border }} />
            ))}
          </div>
          <div style={S.kS}>
            base {(tkNow.baseStress * 100).toFixed(0)} · sla{" "}
            {(tkNow.slaStress * 100).toFixed(0)} · age{" "}
            {(tkNow.ageStress * 100).toFixed(0)}
          </div>
        </div>
        <div
          style={S.kpi(
            tk15.stressIndex > 0.5
              ? "high"
              : tk15.stressIndex > 0.25
                ? "med"
                : null,
          )}
        >
          <div style={S.kL}>@ {hLabel(nowHour + 0.25)} (+15m)</div>
          <div style={S.kV(tk15.stressIndex)}>
            {(tk15.stressIndex * 100).toFixed(0)}%
          </div>
          <div style={{ height: 3, background: T.surface2, borderRadius: 2, margin: "5px 0 4px", position: "relative" }}>
            <div style={{ height: "100%", width: `${Math.min(100, tk15.stressIndex * 100)}%`, background: tk15.stressIndex > 0.5 ? T.red : tk15.stressIndex > 0.25 ? T.amber : T.green, borderRadius: 2, transition: "width .3s" }} />
            {[cfg.l1Threshold, cfg.l2Threshold, cfg.l3Threshold].map((th, i) => (
              <div key={i} style={{ position: "absolute", left: `${th * 100}%`, top: 0, height: "100%", width: 1, background: T.border }} />
            ))}
          </div>
          <div style={S.kS}>
            demand {tk15.incomingOrders.toFixed(0)}/hr · ±3% CI
          </div>
        </div>
        <div
          style={S.kpi(
            tk30.stressIndex > 0.5
              ? "high"
              : tk30.stressIndex > 0.25
                ? "med"
                : null,
          )}
        >
          <div style={S.kL}>@ {hLabel(Math.min(24, nowHour + 0.5))} (+30m)</div>
          <div style={S.kV(tk30.stressIndex)}>
            {(tk30.stressIndex * 100).toFixed(0)}%
          </div>
          <div style={{ height: 3, background: T.surface2, borderRadius: 2, margin: "5px 0 4px", position: "relative" }}>
            <div style={{ height: "100%", width: `${Math.min(100, tk30.stressIndex * 100)}%`, background: tk30.stressIndex > 0.5 ? T.red : tk30.stressIndex > 0.25 ? T.amber : T.green, borderRadius: 2, transition: "width .3s" }} />
            {[cfg.l1Threshold, cfg.l2Threshold, cfg.l3Threshold].map((th, i) => (
              <div key={i} style={{ position: "absolute", left: `${th * 100}%`, top: 0, height: "100%", width: 1, background: T.border }} />
            ))}
          </div>
          <div style={S.kS}>
            demand {tk30.incomingOrders.toFixed(0)}/hr · ±6% CI
          </div>
        </div>
        <div style={S.kpi(omsNow.slaRate > 0.3 ? "high" : null)}>
          <div style={S.kL}>SLA breach rate</div>
          <div
            style={{
              fontFamily: M,
              fontSize: 22,
              fontWeight: 500,
              lineHeight: 1,
              color:
                omsNow.slaRate > 0.3
                  ? T.red
                  : omsNow.slaRate > 0.1
                    ? T.amber
                    : T.green,
            }}
          >
            {((omsNow.slaRate || 0) * 100).toFixed(0)}%
          </div>
          <div style={S.kS}>
            {omsNow.slaBreached || 0} / {omsNow.slaDenom || 0} this slot
          </div>
        </div>
      </div>

      <div style={S.body}>
        {/* ── LEFT ── */}
        <div style={S.left}>
          <div style={S.tabs}>
            {[
              ["live", "Live"],
              ["alerts", `Alerts${alerts.length ? ` (${alerts.length})` : ""}`],
              ["whatif", "What-If"],
              ["params", "Params"],
            ].map(([id, lbl]) => (
              <button
                key={id}
                style={{
                  ...S.tab(leftTab === id),
                  color:
                    id === "alerts" && critCount > 0 && leftTab !== id
                      ? T.red
                      : undefined,
                }}
                onClick={() => setLeftTab(id)}
              >
                {lbl}
              </button>
            ))}
          </div>

          {/* LIVE */}
          {leftTab === "live" && (
            <div style={S.scroll}>
              <div style={S.sh}>Forecast — next 15 / 30 min</div>
              {[
                {
                  l: "Demand",
                  v: `${tk15.incomingOrders.toFixed(1)} / ${tk30.incomingOrders.toFixed(1)} orders/hr`,
                },
                {
                  l: "Stress",
                  v: `${(tk15.stressIndex * 100).toFixed(0)}% / ${(tk30.stressIndex * 100).toFixed(0)}%`,
                },
                {
                  l: "Pending",
                  v: `${tk15.pendingOrders.toFixed(0)} / ${tk30.pendingOrders.toFixed(0)}`,
                },
                {
                  l: "Caps avail",
                  v: `${tk15.capsAvail.toFixed(0)} / ${tk30.capsAvail.toFixed(0)}`,
                },
                {
                  l: "SLA breach",
                  v: `${(tk15.slaRate * 100).toFixed(0)}% / ${(tk30.slaRate * 100).toFixed(0)}%`,
                },
                {
                  l: "Oldest age",
                  v: `${tk15.oldestAge.toFixed(0)} / ${tk30.oldestAge.toFixed(0)} min`,
                },
              ].map((r) => (
                <div
                  key={r.l}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "4px 0",
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  <span
                    style={{ fontFamily: M, fontSize: 9, color: T.textMid }}
                  >
                    {r.l}
                  </span>
                  <span
                    style={{
                      fontFamily: M,
                      fontSize: 10,
                      fontWeight: 500,
                      color: T.textHi,
                    }}
                  >
                    {r.v}
                  </span>
                </div>
              ))}

              <div style={{ ...S.sh, marginTop: 14 }}>
                OMS slot — {hLabel(nowHour)}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 6,
                }}
              >
                {[
                  { l: "Incoming", v: omsNow.incoming || 0 },
                  { l: "Pending", v: omsNow.pending || 0 },
                  { l: "Delivered", v: omsNow.delivered || 0 },
                  { l: "Dispatched", v: omsNow.dispatched || 0 },
                  { l: "SLA breached", v: omsNow.slaBreached || 0 },
                  { l: "Oldest age", v: `${omsNow.oldestAge || 0}m` },
                  { l: "Assign latency", v: `${omsNow.avgAssignSec || 0}s` },
                  { l: "Prep time", v: `${omsNow.avgPrepMin || 0}m` },
                  { l: "Round-trip", v: `${omsNow.avgRoundTrip || 0}m` },
                  { l: "Stack depth", v: `×${omsNow.stackDepth || 1}` },
                ].map((r) => (
                  <div key={r.l} style={S.metric}>
                    <div style={S.mLabel}>{r.l}</div>
                    <div style={{ ...S.mVal, fontSize: 14 }}>{r.v}</div>
                  </div>
                ))}
              </div>

              <div style={{ ...S.sh, marginTop: 14 }}>Levers</div>
              {[
                { id: "l1", l: `L1 >${(cfg.l1Threshold * 100).toFixed(0)}% — 2 orders/trip`, on: tkNow.l1 },
                { id: "l2", l: `L2 >${(cfg.l2Threshold * 100).toFixed(0)}% — recall +${(cfg.l2CallbackFrac * 100).toFixed(0)}%`, on: tkNow.l2 },
                { id: "l3", l: `L3 >${(cfg.l3Threshold * 100).toFixed(0)}% — all-hands`, on: tkNow.l3 },
              ].map((lv, i) => (
                <div key={i} style={S.lever(lv.on)}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: lv.on ? T.amber : T.textLo }} />
                  L{i + 1} {lv.on ? "ACTIVE" : "—"}
                  {lv.on && acceptedByAI.has(lv.id) && (
                    <span style={{ fontFamily: M, fontSize: 7, background: T.accent, color: T.accentFg, borderRadius: 3, padding: "1px 5px", marginLeft: 4, letterSpacing: ".06em" }}>AI</span>
                  )}
                  {" "}{lv.l}
                </div>
              ))}
            </div>
          )}

          {/* ALERTS */}
          {leftTab === "alerts" && (
            <div style={S.scroll}>
              <div style={S.sh}>ML alerts — next 30 min</div>
              {alerts.length === 0 && (
                <div style={{ ...S.ac("ok").wrap, textAlign: "center" }}>
                  <span
                    style={{
                      fontFamily: M,
                      fontSize: 11,
                      color: T.green,
                      fontWeight: 500,
                    }}
                  >
                    All clear — no crossings in 30 min
                  </span>
                </div>
              )}
              {alerts.map((a) => {
                const st = S.ac(a.sev);
                return (
                  <div key={a.id} style={st.wrap}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <div
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: st.dot,
                        }}
                      />
                      <span
                        style={{
                          fontFamily: M,
                          fontSize: 11,
                          fontWeight: 500,
                          color: T.textHi,
                        }}
                      >
                        {a.title}
                      </span>
                      <span
                        style={{
                          fontFamily: M,
                          fontSize: 8,
                          background: `${st.dot}22`,
                          color: st.dot,
                          borderRadius: 3,
                          padding: "1px 5px",
                          marginLeft: "auto",
                        }}
                      >
                        {a.sev.toUpperCase()}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: T.textMid,
                        lineHeight: 1.6,
                      }}
                    >
                      {a.detail}
                    </div>
                  </div>
                );
              })}
              <div style={{ ...S.sh, marginTop: 16 }}>GenAI analysis</div>
              {aiRecs.map((r, i) => (
                <div
                  key={i}
                  style={{
                    background: T.surface,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: M,
                        fontSize: 9,
                        background: T.blueBg,
                        color: T.blue,
                        border: `1px solid ${T.blueBd}`,
                        borderRadius: 3,
                        padding: "1px 6px",
                      }}
                    >
                      {r.agent}
                    </div>
                    <span
                      style={{
                        fontFamily: M,
                        fontSize: 9,
                        color: T.textMid,
                        marginLeft: "auto",
                      }}
                    >
                      conf {(r.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: T.textMid,
                      lineHeight: 1.6,
                      marginBottom: 6,
                    }}
                  >
                    {r.analysis}
                  </div>
                  <div
                    style={{
                      fontFamily: M,
                      fontSize: 9,
                      color: T.textMid,
                      marginBottom: 4,
                    }}
                  >
                    <strong>Root cause:</strong> {r.rootCause}
                  </div>
                  <div
                    style={{
                      fontFamily: M,
                      fontSize: 10,
                      background: T.greenBg,
                      border: `1px solid ${T.greenBd}`,
                      borderRadius: 5,
                      padding: "6px 8px",
                      lineHeight: 1.5,
                      color: T.textHi,
                    }}
                  >
                    <strong style={{ color: T.green }}>Action:</strong>{" "}
                    {r.action}
                  </div>
                  <button
                    style={{ ...S.btn(), fontSize: 9, marginTop: 8 }}
                    onClick={() => setLeftTab("whatif")}
                  >
                    Test in What-If →
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* WHAT-IF */}
          {leftTab === "whatif" && (
            <div style={S.scroll}>
              <div style={S.sh}>Interventions</div>
              <div
                style={{
                  fontFamily: M,
                  fontSize: 9,
                  color: T.textMid,
                  marginBottom: 10,
                  lineHeight: 1.6,
                }}
              >
                Select levers. Sim re-runs full day — compare baseline vs
                what-if.
              </div>
              {["l1", "l2", "l3", "staff", "tune"].map((lvl) => {
                const items = INTERVENTIONS.filter((x) => x.level === lvl);
                const labels = {
                  l1: "Level 1",
                  l2: "Level 2",
                  l3: "Level 3",
                  staff: "Staffing",
                  tune: "Threshold",
                };
                return (
                  <div key={lvl} style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        fontFamily: M,
                        fontSize: 9,
                        color: T.textMid,
                        marginBottom: 4,
                      }}
                    >
                      {labels[lvl]}
                    </div>
                    {items.map((iv) => {
                      const sel = selectedInterventions.includes(iv.id);
                      return (
                        <label
                          key={iv.id}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 8,
                            padding: "5px 8px",
                            marginBottom: 3,
                            borderRadius: 5,
                            background: sel ? T.accentDim : "transparent",
                            border: `1px solid ${sel ? T.accent + "60" : "transparent"}`,
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={sel}
                            onChange={() => toggleIntervention(iv.id)}
                            style={{ accentColor: T.accent, marginTop: 2 }}
                          />
                          <div>
                            <div
                              style={{
                                fontFamily: M,
                                fontSize: 10,
                                color: sel ? T.accent : T.textMid,
                              }}
                            >
                              {iv.label}
                            </div>
                            <div
                              style={{
                                fontFamily: M,
                                fontSize: 9,
                                color: T.textMid,
                              }}
                            >
                              {iv.impact}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  style={S.btn(
                    selectedInterventions.length ? "primary" : "default",
                  )}
                  onClick={() => {
                    setWiActive(true);
                    setRightTab("monitor");
                  }}
                  disabled={!selectedInterventions.length}
                >
                  Run
                </button>
                <button
                  style={S.btn()}
                  onClick={() => {
                    setWiActive(false);
                    setSelectedInterventions([]);
                  }}
                >
                  Clear
                </button>
              </div>
              {wiActive && wiPeak && (
                <div
                  style={{
                    marginTop: 14,
                    background: T.greenBg,
                    border: `1px solid ${T.greenBd}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                  }}
                >
                  <div
                    style={{
                      fontFamily: M,
                      fontSize: 9,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: T.green,
                      marginBottom: 6,
                    }}
                  >
                    Result
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                    }}
                  >
                    <div>
                      <div
                        style={{ fontFamily: M, fontSize: 8, color: T.textMid }}
                      >
                        Baseline peak
                      </div>
                      <div style={S.kV(peakTk.stressIndex)}>
                        {(peakTk.stressIndex * 100).toFixed(0)}%
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 400,
                            color: T.textMid,
                          }}
                        >
                          {" "}
                          @ {hLabel(peakTk.t)}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div
                        style={{ fontFamily: M, fontSize: 8, color: T.textMid }}
                      >
                        What-if peak
                      </div>
                      <div style={S.kV(wiPeak.stressIndex)}>
                        {(wiPeak.stressIndex * 100).toFixed(0)}%
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 400,
                            color: T.textMid,
                          }}
                        >
                          {" "}
                          @ {hLabel(wiPeak.t)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: M,
                      fontSize: 10,
                      marginTop: 6,
                      color:
                        wiPeak.stressIndex < peakTk.stressIndex
                          ? T.green
                          : T.red,
                    }}
                  >
                    {wiPeak.stressIndex < peakTk.stressIndex
                      ? `▼ ${((peakTk.stressIndex - wiPeak.stressIndex) * 100).toFixed(0)}pp`
                      : `▲ ${((wiPeak.stressIndex - peakTk.stressIndex) * 100).toFixed(0)}pp`}
                    {wiPeak.stressIndex < cfg.l1Threshold
                      ? " — below L1"
                      : wiPeak.stressIndex < cfg.l2Threshold
                        ? " — L1 only"
                        : " — still L2+"}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PARAMS */}
          {leftTab === "params" && (
            <div style={S.scroll}>
              <div
                style={{
                  fontFamily: M,
                  fontSize: 10,
                  color: T.textMid,
                  background: T.blueBg,
                  border: `1px solid ${T.blueBd}`,
                  borderRadius: 6,
                  padding: "10px 12px",
                  marginBottom: 14,
                  lineHeight: 1.8,
                }}
              >
                <strong style={{ color: T.blue }}>Composite stress</strong>
                <br />
                base = pending / (caps × mult)
                <br />
                sla = breached / pending × W<sub>sla</sub>
                <br />
                age = oldest_min / threshold × W<sub>age</sub>
                <br />
                <strong>stress = max(base, sla, age)</strong>
              </div>
              {PARAM_SCHEMA.map((item, i) => {
                if (item.section)
                  return (
                    <div key={i} style={{ ...S.sh, marginTop: i > 0 ? 14 : 0 }}>
                      {item.section}
                    </div>
                  );
                const val = cfg[item.id] ?? DEFAULTS[item.id];
                return (
                  <div key={item.id} style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 11,
                        color: T.textMid,
                        marginBottom: 3,
                      }}
                    >
                      <span>
                        {item.label}
                        {item.unit ? ` (${item.unit})` : ""}
                      </span>
                      <span
                        style={{
                          fontFamily: M,
                          fontWeight: 500,
                          color: T.textHi,
                        }}
                      >
                        {item.fmt(val)}
                      </span>
                    </div>
                    <input
                      type="range"
                      style={{ width: "100%", accentColor: T.accent }}
                      min={item.min}
                      max={item.max}
                      step={item.step}
                      value={val}
                      onChange={(e) =>
                        updateCfg(item.id, parseFloat(e.target.value))
                      }
                    />
                  </div>
                );
              })}
              <button
                style={{ ...S.btn(), width: "100%", marginTop: 10 }}
                onClick={() => setCfg({ ...DEFAULTS })}
              >
                Reset defaults
              </button>
            </div>
          )}
        </div>

        {/* ── RIGHT ── */}
        <div style={S.right}>
          <div style={S.tabs}>
            {[
              ["monitor", "Monitor"],
              ["dashboard", "Dashboard"],
              ["agents", "Agent Log"],
            ].map(([id, lbl]) => (
              <button
                key={id}
                style={S.tab(rightTab === id)}
                onClick={() => setRightTab(id)}
              >
                {lbl}
              </button>
            ))}
          </div>

          {/* MONITOR */}
          {rightTab === "monitor" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              {/* What-if comparison */}
              {wiActive &&
                wi15 &&
                wi30 &&
                (() => {
                  const StressBar = ({
                    label,
                    value,
                    wi,
                    showDelta,
                    baselineVal,
                  }) => {
                    const pct = value * 100;
                    const color =
                      pct > cfg.l3Threshold * 100
                        ? T.red
                        : pct > cfg.l2Threshold * 100
                          ? T.amber
                          : pct > cfg.l1Threshold * 100
                            ? T.yellow
                            : T.green;
                    const barColor = wi ? T.green : color;
                    return (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          marginBottom: 5,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: M,
                            fontSize: 10,
                            color: T.textMid,
                            minWidth: 46,
                          }}
                        >
                          {label}
                        </div>
                        <div
                          style={{
                            fontFamily: M,
                            fontSize: 12,
                            fontWeight: 500,
                            color: barColor,
                            minWidth: 36,
                            textAlign: "right",
                          }}
                        >
                          {pct.toFixed(0)}%
                        </div>
                        <div
                          style={{
                            flex: 1,
                            height: 16,
                            background: T.surface2,
                            border: `1px solid ${T.border}`,
                            borderRadius: 3,
                            position: "relative",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${Math.min(100, pct)}%`,
                              background: barColor,
                              opacity: wi ? 0.85 : 1,
                              transition: "width .3s",
                            }}
                          />
                          {[
                            cfg.l1Threshold,
                            cfg.l2Threshold,
                            cfg.l3Threshold,
                          ].map((th, i) => (
                            <div
                              key={i}
                              style={{
                                position: "absolute",
                                left: `${th * 100}%`,
                                top: 0,
                                height: "100%",
                                borderLeft: `1px dashed ${T.textMid}`,
                                pointerEvents: "none",
                              }}
                            />
                          ))}
                        </div>
                        {showDelta && baselineVal != null ? (
                          <div
                            style={{
                              fontFamily: M,
                              fontSize: 10,
                              fontWeight: 500,
                              color: value < baselineVal ? T.green : T.red,
                              minWidth: 48,
                              textAlign: "right",
                            }}
                          >
                            {value < baselineVal ? "▼" : "▲"}{" "}
                            {Math.abs((value - baselineVal) * 100).toFixed(0)}pp
                          </div>
                        ) : (
                          <div style={{ minWidth: 48 }} />
                        )}
                      </div>
                    );
                  };
                  const bestCrossed =
                    tk30.stressIndex >= cfg.l3Threshold
                      ? "L3"
                      : tk30.stressIndex >= cfg.l2Threshold
                        ? "L2"
                        : tk30.stressIndex >= cfg.l1Threshold
                          ? "L1"
                          : null;
                  const wiCrossed =
                    wi30.stressIndex >= cfg.l3Threshold
                      ? "L3"
                      : wi30.stressIndex >= cfg.l2Threshold
                        ? "L2"
                        : wi30.stressIndex >= cfg.l1Threshold
                          ? "L1"
                          : null;
                  return (
                    <div
                      style={{ ...S.card, borderLeft: `3px solid ${T.green}` }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 10,
                        }}
                      >
                        <div style={S.cardTitle}>
                          What-if comparison ·{" "}
                          {selectedLabels.length > 2
                            ? `${selectedLabels.length} interventions`
                            : selectedLabels.join(" + ")}
                        </div>
                        <button
                          style={{
                            ...S.btn(),
                            fontSize: 9,
                            padding: "3px 8px",
                          }}
                          onClick={() => setWiActive(false)}
                        >
                          ✕ close
                        </button>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          marginBottom: 4,
                          height: 10,
                          marginLeft: 46 + 10 + 36 + 10,
                          marginRight: 10 + 48,
                        }}
                      >
                        <div style={{ flex: 1, position: "relative" }}>
                          {[
                            { th: cfg.l1Threshold, l: "L1" },
                            { th: cfg.l2Threshold, l: "L2" },
                            { th: cfg.l3Threshold, l: "L3" },
                          ].map((t, i) => (
                            <span
                              key={i}
                              style={{
                                position: "absolute",
                                left: `${t.th * 100}%`,
                                fontFamily: M,
                                fontSize: 8,
                                color: T.textMid,
                                transform: "translateX(-50%)",
                              }}
                            >
                              {t.l}
                            </span>
                          ))}
                        </div>
                      </div>
                      <StressBar label="NOW" value={tkNow.stressIndex} />
                      <div
                        style={{
                          fontFamily: M,
                          fontSize: 9,
                          letterSpacing: ".1em",
                          color: T.textMid,
                          textTransform: "uppercase",
                          marginTop: 10,
                          marginBottom: 3,
                        }}
                      >
                        Baseline forecast
                      </div>
                      <StressBar
                        label={hLabel(nowHour + 0.25)}
                        value={tk15.stressIndex}
                      />
                      <StressBar
                        label={hLabel(nowHour + 0.5)}
                        value={tk30.stressIndex}
                      />
                      <div
                        style={{
                          fontFamily: M,
                          fontSize: 9,
                          letterSpacing: ".1em",
                          color: T.green,
                          textTransform: "uppercase",
                          marginTop: 10,
                          marginBottom: 3,
                        }}
                      >
                        With intervention
                      </div>
                      <StressBar
                        label={hLabel(nowHour + 0.25)}
                        value={wi15.stressIndex}
                        wi
                        showDelta
                        baselineVal={tk15.stressIndex}
                      />
                      <StressBar
                        label={hLabel(nowHour + 0.5)}
                        value={wi30.stressIndex}
                        wi
                        showDelta
                        baselineVal={tk30.stressIndex}
                      />
                      <div
                        style={{
                          marginTop: 10,
                          padding: "8px 10px",
                          background: wiCrossed
                            ? bestCrossed !== wiCrossed
                              ? T.amberBg
                              : T.redBg
                            : T.greenBg,
                          borderRadius: 5,
                          border: `1px solid ${wiCrossed ? (bestCrossed !== wiCrossed ? T.amberBd : T.redBd) : T.greenBd}`,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: M,
                            fontSize: 10,
                            color: T.textHi,
                            lineHeight: 1.6,
                          }}
                        >
                          <strong
                            style={{
                              color:
                                wi30.stressIndex < tk30.stressIndex
                                  ? T.green
                                  : T.red,
                            }}
                          >
                            Net:{" "}
                            {wi30.stressIndex < tk30.stressIndex ? "▼" : "▲"}{" "}
                            {Math.abs(
                              (tk30.stressIndex - wi30.stressIndex) * 100,
                            ).toFixed(0)}
                            pp at {hLabel(nowHour + 0.5)}
                          </strong>
                          {" · "}
                          {!wiCrossed ? (
                            <span style={{ color: T.green }}>
                              ✓ stays below L1
                            </span>
                          ) : !bestCrossed || wiCrossed === bestCrossed ? (
                            <span style={{ color: T.amber }}>
                              still crosses {wiCrossed}
                            </span>
                          ) : (
                            <span style={{ color: T.green }}>
                              ✓ avoids {bestCrossed}, only crosses {wiCrossed}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}

              {/* Chart card */}
              <div style={S.card}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <div style={S.cardTitle}>Timeline — {dateInfo.label}</div>
                  <div
                    style={{ display: "flex", gap: 4, alignItems: "center" }}
                  >
                    <button
                      style={{ ...S.btn(), fontSize: 9, padding: "4px 8px" }}
                      onClick={() => setNowHour((h) => Math.max(1, h - 1))}
                    >
                      ◀ 1h
                    </button>
                    <button
                      style={{ ...S.btn(), fontSize: 9, padding: "4px 8px" }}
                      onClick={() => setNowHour((h) => Math.max(1, h - 0.25))}
                    >
                      ◀ 15m
                    </button>
                    <span
                      style={{
                        fontFamily: M,
                        fontSize: 11,
                        fontWeight: 500,
                        color: T.accent,
                        minWidth: 70,
                        textAlign: "center",
                      }}
                    >
                      {hLabel(nowHour)}
                    </span>
                    <button
                      style={{ ...S.btn(), fontSize: 9, padding: "4px 8px" }}
                      onClick={() => setNowHour((h) => Math.min(24, h + 0.25))}
                    >
                      15m ▶
                    </button>
                    <button
                      style={{ ...S.btn(), fontSize: 9, padding: "4px 8px" }}
                      onClick={() => setNowHour((h) => Math.min(24, h + 1))}
                    >
                      1h ▶
                    </button>
                    {!isToday && (
                      <button
                        style={{
                          ...S.btn("primary"),
                          fontSize: 9,
                          padding: "4px 8px",
                          marginLeft: 6,
                        }}
                        onClick={() => {
                          const d = new Date();
                          setNowHour(
                            Math.round(
                              (d.getHours() + d.getMinutes() / 60) * 4,
                            ) / 4,
                          );
                          setCurrentDate(DATES[DATES.length - 1].iso);
                        }}
                      >
                        Jump to now
                      </button>
                    )}
                  </div>
                </div>
                {/* Day scrubber */}
                <div
                  style={{
                    height: 20,
                    background: T.surface2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    position: "relative",
                    cursor: "pointer",
                    marginBottom: 3,
                  }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const pct = (e.clientX - r.left) / r.width;
                    setNowHour(
                      Math.round(Math.max(0, Math.min(24, pct * 24)) * 4) / 4,
                    );
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: `${(Math.max(0, nowHour - 1) / 24) * 100}%`,
                      width: `${(Math.min(1.5, nowHour + 0.5 - Math.max(0, nowHour - 1)) / 24) * 100}%`,
                      height: "100%",
                      background: T.scrubberHighlight,
                      pointerEvents: "none",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: `${(nowHour / 24) * 100}%`,
                      width: 2,
                      height: "100%",
                      background: T.accent,
                      pointerEvents: "none",
                    }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontFamily: M,
                    fontSize: 8,
                    color: T.textMid,
                    marginBottom: 10,
                  }}
                >
                  <span>12am</span>
                  <span>3am</span>
                  <span>6am</span>
                  <span>9am</span>
                  <span>12pm</span>
                  <span>3pm</span>
                  <span>6pm</span>
                  <span>9pm</span>
                  <span>12am</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {[
                    { k: "incoming", c: T.series.incoming, l: "Incoming" },
                    { k: "pending", c: T.series.pending, l: "Pending" },
                    { k: "capsOnShift", c: T.series.shift, l: "Caps on shift" },
                    { k: "capsAvail", c: T.series.avail, l: "Caps avail" },
                    { k: "stress", c: T.series.stress, l: "Stress %" },
                  ].map((s) => {
                    const on = visible[s.k];
                    return (
                      <button
                        key={s.k}
                        onClick={() => toggleSeries(s.k)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          fontFamily: M,
                          fontSize: 9,
                          color: on ? T.textHi : T.textLo,
                          background: on ? T.surface : T.bg,
                          border: `1px solid ${on ? T.border : T.border}`,
                          borderRadius: 4,
                          padding: "3px 8px",
                          cursor: "pointer",
                          userSelect: "none",
                          opacity: on ? 1 : 0.55,
                        }}
                      >
                        <span
                          style={{ width: 14, height: 2, background: s.c }}
                        />
                        {s.l}
                      </button>
                    );
                  })}
                  <span
                    style={{
                      fontFamily: M,
                      fontSize: 9,
                      color: T.textMid,
                      alignSelf: "center",
                    }}
                  >
                    solid = actual · dotted = forecast · click to toggle
                  </span>
                </div>
                <div style={{ height: 230 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={monitorData}
                      margin={{ top: 4, right: 40, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke={T.chartGrid}
                      />
                      <XAxis
                        dataKey="hour"
                        tickFormatter={hLabel}
                        tick={{ fontFamily: M, fontSize: 9, fill: T.textMid }}
                        ticks={[
                          nowHour - 1,
                          nowHour - 0.75,
                          nowHour - 0.5,
                          nowHour - 0.25,
                          nowHour,
                          nowHour + 0.25,
                          nowHour + 0.5,
                        ]}
                        domain={[nowHour - 1, nowHour + 0.5]}
                        type="number"
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontFamily: M, fontSize: 9, fill: T.textMid }}
                        width={35}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[0, 100]}
                        tick={{ fontFamily: M, fontSize: 9, fill: T.textMid }}
                        width={35}
                        tickFormatter={(v) => v + "%"}
                      />
                      <Tooltip content={(props) => <Tip {...props} T={T} />} />
                      {visible.incoming && (
                        <>
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="incoming"
                            stroke={T.series.incoming}
                            strokeWidth={1.5}
                            dot={false}
                            name="Incoming"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="fc_incoming"
                            stroke={T.series.incoming}
                            strokeWidth={1.5}
                            strokeDasharray="2 3"
                            dot={{
                              fill: T.series.incoming,
                              r: 3,
                              strokeWidth: 0,
                            }}
                            connectNulls={false}
                            legendType="none"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="incoming_hi"
                            stroke={T.series.incoming}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="incoming_lo"
                            stroke={T.series.incoming}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                        </>
                      )}
                      {visible.pending && (
                        <>
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="pending"
                            stroke={T.series.pending}
                            strokeWidth={1.5}
                            dot={false}
                            name="Pending"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="fc_pending"
                            stroke={T.series.pending}
                            strokeWidth={1.5}
                            strokeDasharray="2 3"
                            dot={{
                              fill: T.series.pending,
                              r: 3,
                              strokeWidth: 0,
                            }}
                            connectNulls={false}
                            legendType="none"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="pending_hi"
                            stroke={T.series.pending}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="pending_lo"
                            stroke={T.series.pending}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                        </>
                      )}
                      {visible.capsOnShift && (
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="capsOnShift"
                          stroke={T.series.shift}
                          strokeWidth={1.5}
                          dot={false}
                          name="Caps on shift"
                        />
                      )}
                      {visible.capsAvail && (
                        <>
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="capsAvail"
                            stroke={T.series.avail}
                            strokeWidth={1.5}
                            dot={false}
                            name="Caps avail"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="fc_caps"
                            stroke={T.series.avail}
                            strokeWidth={1.5}
                            strokeDasharray="2 3"
                            dot={{ fill: T.series.avail, r: 3, strokeWidth: 0 }}
                            connectNulls={false}
                            legendType="none"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="caps_hi"
                            stroke={T.series.avail}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="caps_lo"
                            stroke={T.series.avail}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                        </>
                      )}
                      {visible.stress && (
                        <>
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="stress"
                            stroke={T.series.stress}
                            strokeWidth={1.5}
                            dot={false}
                            name="Stress %"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="fc_stress"
                            stroke={T.series.stress}
                            strokeWidth={1.5}
                            strokeDasharray="2 3"
                            dot={{
                              fill: T.series.stress,
                              r: 3,
                              strokeWidth: 0,
                            }}
                            connectNulls={false}
                            legendType="none"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="stress_hi"
                            stroke={T.series.stress}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="stress_lo"
                            stroke={T.series.stress}
                            strokeWidth={1}
                            strokeDasharray="1 3"
                            dot={false}
                            connectNulls={false}
                            legendType="none"
                            opacity={0.35}
                          />
                        </>
                      )}
                      <ReferenceLine
                        yAxisId="right"
                        x={nowHour}
                        stroke={T.accent}
                        strokeWidth={1.5}
                        label={{
                          value: `NOW`,
                          position: "insideTopLeft",
                          fontSize: 9,
                          fill: T.accent,
                          fontFamily: M,
                        }}
                      />
                      <ReferenceLine
                        yAxisId="right"
                        y={cfg.l1Threshold * 100}
                        stroke={T.textMid}
                        strokeDasharray="3 3"
                        label={{
                          value: "L1",
                          position: "right",
                          fontSize: 8,
                          fill: T.textMid,
                          fontFamily: M,
                        }}
                      />
                      <ReferenceLine
                        yAxisId="right"
                        y={cfg.l2Threshold * 100}
                        stroke={T.textMid}
                        strokeDasharray="3 3"
                        label={{
                          value: "L2",
                          position: "right",
                          fontSize: 8,
                          fill: T.textMid,
                          fontFamily: M,
                        }}
                      />
                      <ReferenceLine
                        yAxisId="right"
                        y={cfg.l3Threshold * 100}
                        stroke={T.textMid}
                        strokeDasharray="3 3"
                        label={{
                          value: "L3",
                          position: "right",
                          fontSize: 8,
                          fill: T.textMid,
                          fontFamily: M,
                        }}
                      />
                      {(() => {
                        const markers = [];
                        const check = (level, th, color) => {
                          const last = tkNow.stressIndex * 100,
                            at15 = tk15.stressIndex * 100,
                            at30 = tk30.stressIndex * 100;
                          const t15 = nowHour + 0.25,
                            t30 = nowHour + 0.5;
                          if (last < th * 100 && at15 >= th * 100)
                            markers.push({ x: t15, y: at15, level, color });
                          else if (at15 < th * 100 && at30 >= th * 100)
                            markers.push({ x: t30, y: at30, level, color });
                        };
                        check("L1", cfg.l1Threshold, T.amber);
                        check("L2", cfg.l2Threshold, T.amber);
                        check("L3", cfg.l3Threshold, T.red);
                        return markers.map((m, i) => (
                          <ReferenceLine
                            key={i}
                            yAxisId="right"
                            x={m.x}
                            stroke={m.color}
                            strokeWidth={2}
                            label={{
                              value: `▼ ${m.level}`,
                              position: "top",
                              fontSize: 9,
                              fill: m.color,
                              fontFamily: M,
                              fontWeight: "bold",
                            }}
                          />
                        ));
                      })()}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div
                  style={{
                    fontFamily: M,
                    fontSize: 9,
                    color: T.textMid,
                    textAlign: "center",
                    marginTop: 5,
                  }}
                >
                  OMS orders feed · sim-derived capacity + stress · hover to
                  inspect
                </div>
              </div>

              {/* Forecast cards */}
              <div style={S.card}>
                <div style={S.cardTitle}>
                  ML forecast — {hLabel(nowHour + 0.25)} and{" "}
                  {hLabel(Math.min(24, nowHour + 0.5))}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: M,
                        fontSize: 10,
                        fontWeight: 500,
                        color: T.blue,
                        marginBottom: 8,
                      }}
                    >
                      t+15 · {hLabel(nowHour + 0.25)}
                      <span
                        style={{
                          fontFamily: M,
                          fontSize: 8,
                          color: T.textMid,
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        ± 3% CI
                      </span>
                    </div>
                    {[
                      {
                        l: "Stress",
                        v: tk15.stressIndex,
                        fmt: (v) => (v * 100).toFixed(0) + "%",
                        ci: 0.03,
                        cls: tk15.stressIndex,
                      },
                      {
                        l: "Demand",
                        v: tk15.incomingOrders,
                        fmt: (v) => v.toFixed(0) + "/hr",
                        ci: 0.03,
                        cls: 0,
                      },
                      {
                        l: "Pending",
                        v: tk15.pendingOrders,
                        fmt: (v) => v.toFixed(0),
                        ci: 0.03,
                        cls: tk15.pendingOrders > 15 ? 0.5 : 0,
                      },
                      {
                        l: "Caps avail",
                        v: tk15.capsAvail,
                        fmt: (v) => v.toFixed(0),
                        ci: 0,
                        cls: tk15.capsAvail < 2 ? 0.7 : 0,
                      },
                      {
                        l: "SLA breach",
                        v: tk15.slaRate,
                        fmt: (v) => (v * 100).toFixed(0) + "%",
                        ci: 0.02,
                        cls: tk15.slaRate,
                      },
                      {
                        l: "Oldest age",
                        v: tk15.oldestAge,
                        fmt: (v) => v.toFixed(0) + "m",
                        ci: 0.05,
                        cls: tk15.oldestAge > cfg.slaThreshold ? 0.7 : 0,
                      },
                    ].map((r) => {
                      const lo = Math.max(0, r.v * (1 - r.ci)),
                        hi = r.v * (1 + r.ci);
                      return (
                        <div
                          key={r.l}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            padding: "4px 0",
                            borderBottom: `1px solid ${T.border}`,
                            alignItems: "baseline",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: M,
                              fontSize: 9,
                              color: T.textMid,
                            }}
                          >
                            {r.l}
                          </span>
                          <span
                            style={{
                              fontFamily: M,
                              fontSize: 12,
                              fontWeight: 500,
                              color:
                                r.cls > 0.5
                                  ? T.red
                                  : r.cls > 0.25
                                    ? T.amber
                                    : T.textHi,
                            }}
                          >
                            {r.fmt(r.v)}
                            {r.ci > 0 && (
                              <span
                                style={{
                                  fontFamily: M,
                                  fontSize: 9,
                                  fontWeight: 400,
                                  color: T.textMid,
                                  marginLeft: 4,
                                }}
                              >
                                ({r.fmt(lo)}–{r.fmt(hi)})
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div>
                    <div
                      style={{
                        fontFamily: M,
                        fontSize: 10,
                        fontWeight: 500,
                        color: T.blue,
                        marginBottom: 8,
                      }}
                    >
                      t+30 · {hLabel(Math.min(24, nowHour + 0.5))}
                      <span
                        style={{
                          fontFamily: M,
                          fontSize: 8,
                          color: T.textMid,
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        ± 6% CI
                      </span>
                    </div>
                    {[
                      {
                        l: "Stress",
                        v: tk30.stressIndex,
                        fmt: (v) => (v * 100).toFixed(0) + "%",
                        ci: 0.06,
                        cls: tk30.stressIndex,
                      },
                      {
                        l: "Demand",
                        v: tk30.incomingOrders,
                        fmt: (v) => v.toFixed(0) + "/hr",
                        ci: 0.06,
                        cls: 0,
                      },
                      {
                        l: "Pending",
                        v: tk30.pendingOrders,
                        fmt: (v) => v.toFixed(0),
                        ci: 0.06,
                        cls: tk30.pendingOrders > 15 ? 0.5 : 0,
                      },
                      {
                        l: "Caps avail",
                        v: tk30.capsAvail,
                        fmt: (v) => v.toFixed(0),
                        ci: 0,
                        cls: tk30.capsAvail < 2 ? 0.7 : 0,
                      },
                      {
                        l: "SLA breach",
                        v: tk30.slaRate,
                        fmt: (v) => (v * 100).toFixed(0) + "%",
                        ci: 0.04,
                        cls: tk30.slaRate,
                      },
                      {
                        l: "Oldest age",
                        v: tk30.oldestAge,
                        fmt: (v) => v.toFixed(0) + "m",
                        ci: 0.1,
                        cls: tk30.oldestAge > cfg.slaThreshold ? 0.7 : 0,
                      },
                    ].map((r) => {
                      const lo = Math.max(0, r.v * (1 - r.ci)),
                        hi = r.v * (1 + r.ci);
                      return (
                        <div
                          key={r.l}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            padding: "4px 0",
                            borderBottom: `1px solid ${T.border}`,
                            alignItems: "baseline",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: M,
                              fontSize: 9,
                              color: T.textMid,
                            }}
                          >
                            {r.l}
                          </span>
                          <span
                            style={{
                              fontFamily: M,
                              fontSize: 12,
                              fontWeight: 500,
                              color:
                                r.cls > 0.5
                                  ? T.red
                                  : r.cls > 0.25
                                    ? T.amber
                                    : T.textHi,
                            }}
                          >
                            {r.fmt(r.v)}
                            {r.ci > 0 && (
                              <span
                                style={{
                                  fontFamily: M,
                                  fontSize: 9,
                                  fontWeight: 400,
                                  color: T.textMid,
                                  marginLeft: 4,
                                }}
                              >
                                ({r.fmt(lo)}–{r.fmt(hi)})
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Lever status */}
              <div style={S.card}>
                <div style={S.cardTitle}>Corrective levers</div>
                {[
                  { id: "l1", l: `L1 >${(cfg.l1Threshold * 100).toFixed(0)}% — captains carry 2 orders/trip (×2 throughput)`, on: tkNow.l1 },
                  { id: "l2", l: `L2 >${(cfg.l2Threshold * 100).toFixed(0)}% — recall off-shift captains (+${(cfg.l2CallbackFrac * 100).toFixed(0)}%)`, on: tkNow.l2 },
                  { id: "l3", l: `L3 >${(cfg.l3Threshold * 100).toFixed(0)}% — all-hands (+${(cfg.l3CaptainFrac * 100).toFixed(0)}% caps, +${(cfg.l3PackerFrac * 100).toFixed(0)}% paks)`, on: tkNow.l3 },
                ].map((lv, i) => (
                  <div key={i} style={S.lever(lv.on)}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: lv.on ? T.amber : T.textLo }} />
                    L{i + 1} {lv.on ? "ACTIVE" : "—"}
                    {lv.on && acceptedByAI.has(lv.id) && (
                      <span style={{ fontFamily: M, fontSize: 7, background: T.accent, color: T.accentFg, borderRadius: 3, padding: "1px 5px", marginLeft: 4, letterSpacing: ".06em" }}>AI</span>
                    )}
                    {" "}{lv.l}
                  </div>
                ))}
              </div>

              {/* Shift bars */}
              <div style={S.card}>
                <div style={S.cardTitle}>Shift coverage</div>
                {[
                  {
                    label: "Captains",
                    shifts: [
                      {
                        from: cfg.captainMorningIn,
                        to: cfg.captainMorningOut,
                        c: "#7c6fcd",
                      },
                      {
                        from: cfg.captainEveningIn,
                        to: cfg.captainEveningOut,
                        c: "#5dade2",
                      },
                    ],
                  },
                  {
                    label: "Packers",
                    shifts: [
                      {
                        from: cfg.packerMorningIn,
                        to: cfg.packerMorningOut,
                        c: "#1a9e8a",
                      },
                      {
                        from: cfg.packerEveningIn,
                        to: cfg.packerEveningOut,
                        c: "#58d68d",
                      },
                    ],
                  },
                ].map((row) => (
                  <div key={row.label} style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        fontFamily: M,
                        fontSize: 9,
                        color: T.textMid,
                        marginBottom: 3,
                      }}
                    >
                      {row.label}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        height: 20,
                        background: T.surface2,
                        borderRadius: 4,
                        overflow: "hidden",
                        border: `1px solid ${T.border}`,
                        position: "relative",
                      }}
                    >
                      {row.shifts.map((sh, i) => (
                        <div
                          key={i}
                          style={{
                            position: "absolute",
                            left: `${(sh.from / 24) * 100}%`,
                            width: `${((sh.to - sh.from) / 24) * 100}%`,
                            height: "100%",
                            background: sh.c,
                            opacity: 0.35,
                            borderRadius: 2,
                          }}
                        />
                      ))}
                      <div
                        style={{
                          position: "absolute",
                          left: `${(nowHour / 24) * 100}%`,
                          width: 2,
                          height: "100%",
                          background: T.accent,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontFamily: M,
                        fontSize: 8,
                        color: T.textMid,
                        marginTop: 2,
                      }}
                    >
                      <span>12am</span>
                      <span>6am</span>
                      <span>12pm</span>
                      <span>6pm</span>
                      <span>12am</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DASHBOARD */}
          {rightTab === "dashboard" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              <div style={S.card}>
                <div style={S.cardTitle}>
                  Full KPI snapshot — {hLabel(nowHour)}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4,1fr)",
                    gap: 8,
                  }}
                >
                  {[
                    {
                      l: "Incoming",
                      v: tkNow.incomingOrders.toFixed(1) + "/hr",
                      cls: 0,
                    },
                    {
                      l: "Pending",
                      v: tkNow.pendingOrders.toFixed(0),
                      cls: tkNow.pendingOrders > 15 ? 0.5 : 0,
                    },
                    {
                      l: "Composite stress",
                      v: (tkNow.stressIndex * 100).toFixed(0) + "%",
                      cls: tkNow.stressIndex,
                    },
                    {
                      l: "Fill rate",
                      v: (tkNow.fillRate * 100).toFixed(1) + "%",
                      cls: 1 - tkNow.fillRate,
                    },
                    { l: "Caps on shift", v: tkNow.capsOnShift, cls: 0 },
                    {
                      l: "Caps available",
                      v: tkNow.capsAvail.toFixed(0),
                      cls: tkNow.capsAvail < 2 ? 0.7 : 0,
                    },
                    { l: "Packs on shift", v: tkNow.paksOnShift, cls: 0 },
                    {
                      l: "Packs available",
                      v: tkNow.paksAvail.toFixed(0),
                      cls: tkNow.paksAvail < 2 ? 0.7 : 0,
                    },
                    {
                      l: "Delivered",
                      v: tkNow.deliveredOrders.toFixed(0),
                      cls: 0,
                    },
                    {
                      l: "SLA breach",
                      v: (tkNow.slaRate * 100).toFixed(0) + "%",
                      cls: tkNow.slaRate > 0.3 ? 0.7 : 0,
                    },
                    {
                      l: "Oldest pending",
                      v: tkNow.oldestAge.toFixed(0) + "m",
                      cls: tkNow.oldestAge > cfg.slaThreshold ? 0.7 : 0,
                    },
                    {
                      l: "Assign latency",
                      v: tkNow.assignSec.toFixed(0) + "s",
                      cls: tkNow.assignSec > 120 ? 0.5 : 0,
                    },
                    { l: "Stack depth", v: `×${tkNow.stackDepth}`, cls: 0 },
                    {
                      l: "Round-trip",
                      v: tkNow.roundTripMin.toFixed(0) + "m",
                      cls: 0,
                    },
                    {
                      l: "Dispatch rate",
                      v: tkNow.dispatchRate.toFixed(1) + "/hr",
                      cls: 0,
                    },
                    {
                      l: "Captain util",
                      v: (tkNow.capUtil * 100).toFixed(0) + "%",
                      cls: tkNow.capUtil > 0.9 ? 0.5 : 0,
                    },
                  ].map((k, i) => (
                    <div key={i} style={S.metric}>
                      <div style={S.mLabel}>{k.l}</div>
                      <div
                        style={{
                          ...S.mVal,
                          fontSize: 16,
                          color:
                            k.cls > 0.6
                              ? T.red
                              : k.cls > 0.25
                                ? T.amber
                                : T.textHi,
                        }}
                      >
                        {k.v}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>Stress breakdown</div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 8,
                  }}
                >
                  {[
                    {
                      l: "Base",
                      v: (tkNow.baseStress * 100).toFixed(0) + "%",
                      sub: "pending / (caps × mult)",
                      cls: tkNow.baseStress,
                    },
                    {
                      l: "SLA",
                      v: (tkNow.slaStress * 100).toFixed(0) + "%",
                      sub: `× ${cfg.slaWeight} weight`,
                      cls: tkNow.slaStress * cfg.slaWeight,
                    },
                    {
                      l: "Age",
                      v: (tkNow.ageStress * 100).toFixed(0) + "%",
                      sub: `× ${cfg.ageWeight} weight`,
                      cls: tkNow.ageStress * cfg.ageWeight,
                    },
                  ].map((k, i) => (
                    <div key={i} style={S.metric}>
                      <div style={S.mLabel}>{k.l} stress</div>
                      <div
                        style={{
                          ...S.mVal,
                          fontSize: 18,
                          color:
                            k.cls > 0.5
                              ? T.red
                              : k.cls > 0.25
                                ? T.amber
                                : T.green,
                        }}
                      >
                        {k.v}
                      </div>
                      <div style={S.mSub}>{k.sub}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>OMS day totals</div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 8,
                  }}
                >
                  {[
                    { l: "Total orders", v: omsData.stats.totalOrders },
                    { l: "SLA breaches", v: omsData.stats.totalBreached },
                    {
                      l: "Breach rate",
                      v: (omsData.stats.slaBreachRate * 100).toFixed(1) + "%",
                    },
                    { l: "Avg order-to-door", v: omsData.stats.avgTotal + "m" },
                    { l: "P95 order-to-door", v: omsData.stats.p95Total + "m" },
                    {
                      l: "Peak slot",
                      v: omsData.stats.peakSlotOrders + " orders",
                    },
                  ].map((k, i) => (
                    <div key={i} style={S.metric}>
                      <div style={S.mLabel}>{k.l}</div>
                      <div style={{ ...S.mVal, fontSize: 14 }}>{k.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* AGENT LOG */}
          {rightTab === "agents" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              <div
                style={{
                  fontFamily: M,
                  fontSize: 9,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: T.textMid,
                  marginBottom: 14,
                }}
              >
                GenAI agent log · {hLabel(nowHour)}
              </div>
              {aiRecs.map((r, i) => (
                <div key={i} style={{ ...S.card, marginBottom: 12, borderLeft: `3px solid ${r.sev === "high" || r.sev === "critical" ? T.amber : r.sev === "medium" ? T.yellow : r.sev === "ok" ? T.green : T.blue}` }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: T.blueBg,
                        border: `1px solid ${T.blueBd}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <span
                        style={{ fontFamily: M, fontSize: 10, color: T.blue }}
                      >
                        AI
                      </span>
                    </div>
                    <div>
                      <div
                        style={{
                          fontFamily: M,
                          fontSize: 11,
                          fontWeight: 500,
                          color: T.textHi,
                        }}
                      >
                        {r.agent}
                      </div>
                      <div
                        style={{ fontFamily: M, fontSize: 9, color: T.textMid }}
                      >
                        conf {(r.confidence * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: T.textHi,
                      lineHeight: 1.7,
                      marginBottom: 10,
                    }}
                  >
                    {r.analysis}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        background: T.surface2,
                        borderRadius: 6,
                        padding: "8px 10px",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: M,
                          fontSize: 8,
                          letterSpacing: ".1em",
                          textTransform: "uppercase",
                          color: T.textMid,
                          marginBottom: 4,
                        }}
                      >
                        Root cause
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: T.textMid,
                          lineHeight: 1.5,
                        }}
                      >
                        {r.rootCause}
                      </div>
                    </div>
                    <div
                      style={{
                        background: T.greenBg,
                        borderRadius: 6,
                        padding: "8px 10px",
                        border: `1px solid ${T.greenBd}`,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: M,
                          fontSize: 8,
                          letterSpacing: ".1em",
                          textTransform: "uppercase",
                          color: T.green,
                          marginBottom: 4,
                        }}
                      >
                        Action
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: T.textHi,
                          lineHeight: 1.5,
                        }}
                      >
                        {r.action}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
                    {r.interventionId && acceptedByAI.has(r.interventionId) ? (
                      <span style={{ fontFamily: M, fontSize: 9, color: T.green, display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ background: T.greenBg, border: `1px solid ${T.greenBd}`, borderRadius: 4, padding: "4px 10px" }}>✓ Applied to What-If</span>
                      </span>
                    ) : r.interventionId ? (
                      <button
                        style={{ ...S.btn("success"), fontSize: 9 }}
                        onClick={() => handleAccept(r.interventionId)}
                      >
                        Accept ↗
                      </button>
                    ) : (
                      <button style={{ ...S.btn(), fontSize: 9, opacity: 0.35, cursor: "default" }} disabled>
                        Accept ↗
                      </button>
                    )}
                    <button
                      style={{ ...S.btn(), fontSize: 9 }}
                      onClick={() => setLeftTab("whatif")}
                    >
                      Test in What-If →
                    </button>
                  </div>
                </div>
              ))}
              <div
                style={{
                  fontFamily: M,
                  fontSize: 9,
                  color: T.textMid,
                  marginTop: 16,
                  lineHeight: 1.7,
                  borderTop: `1px solid ${T.border}`,
                  paddingTop: 12,
                }}
              >
                <strong>Pipeline:</strong> OMS feed → sim engine (5-min cycle) →
                threshold detector → GenAI agent → panel
                <br />
                <strong>Formula:</strong> stress = max(base, sla×W, age×W) —
                tune in Params tab
              </div>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}} select option{background:${T.surface};color:${T.textHi};}`}</style>
    </div>
  );
}
