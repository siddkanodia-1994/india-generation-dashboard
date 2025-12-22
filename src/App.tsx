import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * India Electricity Generation Tracker (single-file React app)
 *
 * What it does
 * - Store daily all-India generation values locally (browser localStorage)
 * - Accept manual entry + CSV import
 * - Top chart: date slicer + frequency aggregation + series toggles
 * - Monthly totals + MoM/YoY growth (with partial-period windowing)
 *
 * CSV format (header optional)
 * - date,generation_gwh
 * - Date format: DD-MM-YYYY
 *
 * Note on units
 * - If you enter “units” as MU (million units), the number is the same as GWh (1 MU = 1 GWh).
 */

const STORAGE_KEY = "tusk_india_generation_v1";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// ----------------------
// Date helpers
// ----------------------

// Validate internal ISO date key (YYYY-MM-DD)
function parseISOKey(s: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

// Parse DD-MM-YYYY (preferred) -> ISO, also accept ISO for backward compatibility
function parseInputDate(s: unknown) {
  if (typeof s !== "string") return null;
  const t = s.trim();

  if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {
    const [dd, mm, yyyy] = t.split("-").map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (Number.isNaN(d.getTime())) return null;
    // Guard against invalid dates like 31-02-2025
    if (
      d.getUTCFullYear() !== yyyy ||
      d.getUTCMonth() !== mm - 1 ||
      d.getUTCDate() !== dd
    )
      return null;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseISOKey(t);

  return null;
}

function formatDDMMYYYY(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function isoMinusDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoPlusDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Week starts on Monday
function startOfWeekISO(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun,1=Mon,...
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMon);
  return d.toISOString().slice(0, 10);
}

// ----------------------
// Number formatting
// ----------------------

function fmtNum(x: number | null | undefined, digits = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(x);
}

function fmtPct(x: number | null | undefined, digits = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : "";
  return `${sign}${fmtNum(x, digits)}%`;
}

// Ensure tooltip values are always rendered with 2 decimals.
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ----------------------
// Aggregation + growth
// ----------------------

function monthKey(isoDate: string) {
  return isoDate.slice(0, 7); // YYYY-MM
}

function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getYear(ym: string) {
  return Number(ym.slice(0, 4));
}

function getMonth(ym: string) {
  return Number(ym.slice(5, 7));
}

function safeDiv(n: number, d: number | null | undefined) {
  if (d == null || d === 0) return null;
  return n / d;
}

function growthPct(curr: number, prev: number) {
  const r = safeDiv(curr - prev, prev);
  return r == null ? null : r * 100;
}

function sortISO(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mergeRecords(
  existingMap: Map<string, number>,
  incoming: Array<{ date: string; generation_gwh: number }>
) {
  const next = new Map(existingMap);
  for (const r of incoming) next.set(r.date, r.generation_gwh);
  return next;
}

function downloadCSV(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ----------------------
// Data types
// ----------------------

type DailyPoint = { date: string; generation_gwh: number };

type DailyChartPoint = {
  label: string;
  units: number;
  prev_year_units: number | null;
  yoy_pct: number | null;
  mom_pct: number | null; // weekly: WoW%, monthly: MoM%
};

// ----------------------
// KPI + monthly computation
// ----------------------

function computeKPIs(sortedDaily: DailyPoint[]) {
  // KPI definitions used in the Quick Stats panel.
  // YoY for a window compares the same *calendar window* shifted back 1 year.
  // If some days are missing, averages are computed over available datapoints in that window.

  if (sortedDaily.length === 0) {
    return {
      latest: null as DailyPoint | null,
      latestYoY: null as number | null,

      avg7: null as number | null,
      avg7YoY: null as number | null,

      avg30: null as number | null,
      avg30YoY: null as number | null,

      ytdTotal: null as number | null,
      ytdYoY: null as number | null,

      mtdAvg: null as number | null,
      mtdYoY: null as number | null,
    };
  }

  // Build a lookup for fast point/range math.
  const dailyLookup = new Map(sortedDaily.map((d) => [d.date, d.generation_gwh] as const));

  const latest = sortedDaily[sortedDaily.length - 1];

  // Shift ISO date by N years while preserving month/day when possible (handles leap years).
  const isoAddYears = (iso: string, deltaYears: number) => {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));

    const tryDt = new Date(Date.UTC(y + deltaYears, m - 1, d));
    if (
      tryDt.getUTCFullYear() === y + deltaYears &&
      tryDt.getUTCMonth() === m - 1 &&
      tryDt.getUTCDate() === d
    ) {
      return tryDt.toISOString().slice(0, 10);
    }

    // Fallback to the last valid day of that month.
    const lastDay = new Date(Date.UTC(y + deltaYears, m, 0));
    return lastDay.toISOString().slice(0, 10);
  };

  // Sum and count available datapoints for an inclusive ISO range [start, end].
  const sumAndCountInclusive = (startIso: string, endIso: string) => {
    if (startIso > endIso) return { sum: null as number | null, count: 0 };

    let sum = 0;
    let count = 0;
    let cur = startIso;

    while (cur <= endIso) {
      const v = dailyLookup.get(cur);
      if (v != null) {
        sum += v;
        count += 1;
      }
      cur = isoPlusDays(cur, 1);
    }

    return { sum: count ? sum : null, count };
  };

  const avgForLastNDaysEnding = (endIso: string, nDays: number) => {
    const startIso = isoMinusDays(endIso, nDays - 1);
    const { sum, count } = sumAndCountInclusive(startIso, endIso);
    return { startIso, endIso, avg: sum != null && count ? sum / count : null };
  };

  // Latest day YoY.
  const prevYearDate = isoAddYears(latest.date, -1);
  const prevYearVal = dailyLookup.get(prevYearDate) ?? null;
  const latestYoY = prevYearVal != null ? growthPct(latest.generation_gwh, prevYearVal) : null;

  // 7D average + YoY vs same 7D window last year.
  const last7 = avgForLastNDaysEnding(latest.date, 7);
  const py7 = sumAndCountInclusive(isoAddYears(last7.startIso, -1), isoAddYears(last7.endIso, -1));
  const avg7 = last7.avg;
  const avg7PY = py7.sum != null && py7.count ? py7.sum / py7.count : null;
  const avg7YoY = avg7 != null && avg7PY != null ? growthPct(avg7, avg7PY) : null;

  // 30D average + YoY vs same 30D window last year.
  const last30 = avgForLastNDaysEnding(latest.date, 30);
  const py30 = sumAndCountInclusive(isoAddYears(last30.startIso, -1), isoAddYears(last30.endIso, -1));
  const avg30 = last30.avg;
  const avg30PY = py30.sum != null && py30.count ? py30.sum / py30.count : null;
  const avg30YoY = avg30 != null && avg30PY != null ? growthPct(avg30, avg30PY) : null;

  // YTD is FYTD: 1 April of current FY to latest date.
  const latestY = Number(latest.date.slice(0, 4));
  const latestM = Number(latest.date.slice(5, 7));
  const fyStartYear = latestM >= 4 ? latestY : latestY - 1;
  const ytdStart = `${fyStartYear}-04-01`;

  const ytd = sumAndCountInclusive(ytdStart, latest.date);
  const ytdTotal = ytd.sum;

  const ytdPYStart = `${fyStartYear - 1}-04-01`;
  const ytdPYEnd = isoAddYears(latest.date, -1);
  const ytdPY = sumAndCountInclusive(ytdPYStart, ytdPYEnd);
  const ytdTotalPY = ytdPY.sum;
  const ytdYoY = ytdTotal != null && ytdTotalPY != null ? growthPct(ytdTotal, ytdTotalPY) : null;

  // MTD average (calendar month start to latest date) + YoY vs same MTD window last year.
  const thisMonthStart = `${latest.date.slice(0, 7)}-01`;
  const mtd = sumAndCountInclusive(thisMonthStart, latest.date);
  const mtdAvg = mtd.sum != null && mtd.count ? mtd.sum / mtd.count : null;

  const mtdPY = sumAndCountInclusive(isoAddYears(thisMonthStart, -1), isoAddYears(latest.date, -1));
  const mtdAvgPY = mtdPY.sum != null && mtdPY.count ? mtdPY.sum / mtdPY.count : null;
  const mtdYoY = mtdAvg != null && mtdAvgPY != null ? growthPct(mtdAvg, mtdAvgPY) : null;

  return {
    latest,
    latestYoY,
    avg7,
    avg7YoY,
    avg30,
    avg30YoY,
    ytdTotal,
    ytdYoY,
    mtdAvg,
    mtdYoY,
  };
}

function buildMonthDayMap(sortedDaily: DailyPoint[]) {
  const map = new Map<string, { total: number; maxDay: number; byDay: Map<number, number> }>();

  for (const d of sortedDaily) {
    const m = monthKey(d.date);
    const day = Number(d.date.slice(8, 10));

    if (!map.has(m)) map.set(m, { total: 0, maxDay: 0, byDay: new Map() });

    const rec = map.get(m)!;
    rec.total += d.generation_gwh;
    rec.maxDay = Math.max(rec.maxDay, day);
    rec.byDay.set(day, (rec.byDay.get(day) || 0) + d.generation_gwh);
  }

  return map;
}

function sumMonthUpToDay(monthRec: { byDay: Map<number, number> } | undefined, dayLimit: number) {
  if (!monthRec) return null;
  let s = 0;
  let hasAny = false;
  for (let day = 1; day <= dayLimit; day++) {
    const v = monthRec.byDay.get(day);
    if (v != null) {
      s += v;
      hasAny = true;
    }
  }
  return hasAny ? s : null;
}

function toMonthly(sortedDaily: DailyPoint[]) {
  // Monthly totals + MoM% and YoY% using equivalent date range for incomplete months.
  const monthMap = buildMonthDayMap(sortedDaily);
  const months = Array.from(monthMap.keys()).sort(sortISO);

  const out = months.map((m) => ({
    month: m,
    total_gwh: monthMap.get(m)!.total,
    max_day: monthMap.get(m)!.maxDay,
    yoy_pct: null as number | null,
    mom_pct: null as number | null,
  }));

  for (const r of out) {
    const prevMonth = addMonths(r.month, -1);
    const prevMonthRec = monthMap.get(prevMonth);
    const prevComparableMoM = sumMonthUpToDay(prevMonthRec, r.max_day);
    r.mom_pct = prevComparableMoM != null ? growthPct(r.total_gwh, prevComparableMoM) : null;

    const prevYearMonth = `${getYear(r.month) - 1}-${String(getMonth(r.month)).padStart(2, "0")}`;
    const prevYearRec = monthMap.get(prevYearMonth);
    const prevComparableYoY = sumMonthUpToDay(prevYearRec, r.max_day);
    r.yoy_pct = prevComparableYoY != null ? growthPct(r.total_gwh, prevComparableYoY) : null;
  }

  return out;
}

// ----------------------
// CSV helpers
// ----------------------

function csvParse(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: string[][] = [];
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length >= 2) rows.push(cols);
  }

  if (rows.length) {
    const h0 = rows[0][0].toLowerCase();
    const h1 = rows[0][1].toLowerCase();
    if (h0.includes("date") && (h1.includes("gen") || h1.includes("gwh"))) rows.shift();
  }

  const parsed: Array<{ date: string; generation_gwh: number }> = [];
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const [dRaw, gRaw] = rows[i];
    const date = parseInputDate(dRaw);
    const g = Number(String(gRaw).replace(/,/g, ""));

    if (!date) {
      errors.push(`Row ${i + 1}: invalid date '${dRaw}' (expected DD-MM-YYYY)`);
      continue;
    }

    if (!Number.isFinite(g) || g < 0) {
      errors.push(`Row ${i + 1}: invalid generation '${gRaw}' (expected non-negative number)`);
      continue;
    }

    parsed.push({ date, generation_gwh: g });
  }

  return { parsed, errors };
}

function sampleCSV() {
  return [
    "date,generation_gwh",
    "18-12-2025,4140",
    "19-12-2025,4215",
    "20-12-2025,4198",
  ].join("\n");
}

// ----------------------
// Minimal self-tests (runs in dev only)
// ----------------------

function runDevSelfTests() {
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production") return;

  console.assert(parseInputDate("01-04-2025") === "2025-04-01", "parseInputDate DD-MM-YYYY failed");
  console.assert(parseInputDate("2025-04-01") === "2025-04-01", "parseInputDate ISO passthrough failed");
  console.assert(parseInputDate("31-02-2025") === null, "parseInputDate invalid date should be null");
  console.assert(formatDDMMYYYY("2025-04-01") === "01-04-2025", "formatDDMMYYYY failed");
  console.assert(startOfWeekISO("2025-12-22") <= "2025-12-22", "startOfWeekISO ordering failed");

  // Partial-month windowing tests
  const sd: DailyPoint[] = [
    { date: "2024-10-01", generation_gwh: 10 },
    { date: "2024-10-15", generation_gwh: 20 },
    { date: "2024-10-20", generation_gwh: 999 },
    { date: "2025-09-01", generation_gwh: 30 },
    { date: "2025-09-15", generation_gwh: 30 },
    { date: "2025-09-16", generation_gwh: 999 },
    { date: "2025-10-01", generation_gwh: 20 },
    { date: "2025-10-15", generation_gwh: 40 },
  ];
  const m = toMonthly(sd);
  const oct2025 = m.find((r) => r.month === "2025-10");
  console.assert(oct2025 && Math.round(oct2025.yoy_pct || 0) === 100, "partial-month YoY windowing failed");
  console.assert(oct2025 && Math.round(oct2025.mom_pct || 0) === 0, "partial-month MoM windowing failed");

  // Rolling 30D window math (inclusive 30 days)
  const base: DailyPoint[] = [];
  let d = "2025-12-01";
  for (let i = 0; i < 60; i++) {
    base.push({ date: d, generation_gwh: 1 });
    d = isoPlusDays(d, 1);
  }
  const end = "2025-12-30";
  const start = isoMinusDays(end, 29);
  const lookup = new Map(base.map((x) => [x.date, x.generation_gwh] as const));
  let s = 0;
  let cur = start;
  while (cur <= end) {
    s += lookup.get(cur) || 0;
    cur = isoPlusDays(cur, 1);
  }
  console.assert(s === 30, "rolling30 sum should equal 30");

  // FY-YTD definition test (Apr 1 to latest)
  const fy: DailyPoint[] = [
    { date: "2025-03-31", generation_gwh: 100 },
    { date: "2025-04-01", generation_gwh: 10 },
    { date: "2025-04-02", generation_gwh: 20 },
    { date: "2026-04-02", generation_gwh: 999 },
  ];
  const k = computeKPIs(fy);
  console.assert(k.ytdTotal === 30, "FY-YTD should sum from Apr 1 of FY");
}

// ----------------------
// Small UI components
// ----------------------

function Card({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        {right ? <div className="text-sm text-slate-600">{right}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string | null;
  accent?: "ytd" | null;
}) {
  // Optional accent lets us emphasize certain KPIs (e.g., FY-YTD Total).
  const valueClass =
    accent === "ytd"
      ? "mt-1 text-2xl font-semibold text-rose-700"
      : "mt-1 text-2xl font-semibold text-slate-900";

  return (
    <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={valueClass}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function EmptyState({ onLoadSample }: { onLoadSample: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <div className="mx-auto max-w-xl">
        <div className="text-lg font-semibold text-slate-900">No data yet</div>
        <div className="mt-2 text-sm text-slate-600">
          Add your first daily datapoint (units/MU) or import a CSV. The dashboard will compute monthly totals, YoY%, and
          MoM%.
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <button
            onClick={onLoadSample}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Load sample data
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------
// App
// ----------------------

export default function App() {
  runDevSelfTests();

  const [dataMap, setDataMap] = useState<Map<string, number>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      const entries = Object.entries(obj || {});
      const m = new Map<string, number>();
      for (const [k, v] of entries) {
        const d = parseISOKey(k);
        const g = Number(v);
        if (d && Number.isFinite(g) && g >= 0) m.set(d, g);
      }
      return m;
    } catch {
      return new Map();
    }
  });

  const [date, setDate] = useState(() => {
    const t = new Date();
    const dd = String(t.getDate()).padStart(2, "0");
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const yyyy = t.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  });

  const [gwh, setGwh] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [rangeDays, setRangeDays] = useState(120);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);

  // Slicer controls for the top chart
  // ISO because <input type="date"> expects YYYY-MM-DD
  const [fromIso, setFromIso] = useState("");
  const [toIso, setToIso] = useState("");
  const [aggFreq, setAggFreq] = useState<"daily" | "weekly" | "monthly" | "rolling30">("daily");

  // Series toggles for the top chart
  const [showUnitsSeries, setShowUnitsSeries] = useState(true); // Total Current
  const [showPrevYearSeries, setShowPrevYearSeries] = useState(true); // Total (previous year)
  const [showYoYSeries, setShowYoYSeries] = useState(true); // YoY %
  const [showMoMSeries, setShowMoMSeries] = useState(true); // MoM % (or WoW % in weekly view)

  // Statistical control lines (Mean ± 1σ/2σ) for the currently-visible left-axis totals
  const [showControlLines, setShowControlLines] = useState(false);

  // FIX: removed stray extra generic initializer that caused SyntaxError
  const fileRef = useRef<HTMLInputElement | null>(null);

  const sortedDaily = useMemo<DailyPoint[]>(() => {
    return Array.from(dataMap.entries())
      .map(([d, g]) => ({ date: d, generation_gwh: g }))
      .sort((a, b) => sortISO(a.date, b.date));
  }, [dataMap]);

  useEffect(() => {
    const obj = Object.fromEntries(dataMap.entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }, [dataMap]);

  // Initialize slicer (and keep it sensible when the dataset grows)
  useEffect(() => {
    if (!sortedDaily.length) return;
    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    if (!toIso) setToIso(lastIso);
    if (!fromIso) setFromIso(isoMinusDays(lastIso, clamp(rangeDays, 7, 3650)));
  }, [sortedDaily, toIso, fromIso, rangeDays]);

  const anyTotalsShown = showUnitsSeries || showPrevYearSeries;
  const anyTotalsForStats = showUnitsSeries || showPrevYearSeries;
  const anyPctShown = showYoYSeries || showMoMSeries;

  // Build top chart data for selected range
  const dailyForChart = useMemo<DailyChartPoint[]>(() => {
    if (!sortedDaily.length) return [];

    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    const effectiveTo = toIso || lastIso;
    const effectiveFrom = fromIso || isoMinusDays(lastIso, clamp(rangeDays, 7, 3650));

    const f = effectiveFrom <= effectiveTo ? effectiveFrom : effectiveTo;
    const t = effectiveFrom <= effectiveTo ? effectiveTo : effectiveFrom;

    const filtered = sortedDaily.filter((d) => d.date >= f && d.date <= t);

    // Lookup daily values across the full dataset for comparisons
    const dailyLookup = new Map(sortedDaily.map((d) => [d.date, d.generation_gwh]));

    // Sum daily values for an inclusive ISO range [start, end]
    const sumRangeInclusive = (startIso: string, endIso: string) => {
      if (startIso > endIso) return null;
      let s = 0;
      let hasAny = false;
      let cur = startIso;
      while (cur <= endIso) {
        const v = dailyLookup.get(cur);
        if (v != null) {
          s += v;
          hasAny = true;
        }
        cur = isoPlusDays(cur, 1);
      }
      return hasAny ? s : null;
    };

    if (aggFreq === "daily") {
      const sameDayPrevYear = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
      const sameDayPrevMonth = (iso: string) => {
        const y = Number(iso.slice(0, 4));
        const m = Number(iso.slice(5, 7));
        const d = Number(iso.slice(8, 10));
        const dt = new Date(Date.UTC(y, m - 2, d));
        const iso2 = dt.toISOString().slice(0, 10);
        return Number(iso2.slice(8, 10)) === d ? iso2 : null;
      };

      return filtered.map((d) => {
        const pyDate = sameDayPrevYear(d.date);
        const pmDate = sameDayPrevMonth(d.date);
        const py = dailyLookup.get(pyDate) ?? null;
        const pm = pmDate ? dailyLookup.get(pmDate) ?? null : null;

        return {
          label: formatDDMMYYYY(d.date),
          units: d.generation_gwh,
          prev_year_units: py,
          yoy_pct: py != null ? growthPct(d.generation_gwh, py) : null,
          mom_pct: pm != null ? growthPct(d.generation_gwh, pm) : null,
        };
      });
    }

    if (aggFreq === "rolling30") {
      const points: DailyChartPoint[] = [];
      let cur = f;
      while (cur <= t) {
        const start = isoMinusDays(cur, 29);
        const currSum = sumRangeInclusive(start, cur);

        // NOTE: for simplicity we use 365-day shift; if you prefer strict calendar-year alignment,
        // we can implement an exact "same end-date previous year" mapping.
        const curPrevYear = isoMinusDays(cur, 365);
        const startPrevYear = isoMinusDays(curPrevYear, 29);
        const prevSum = sumRangeInclusive(startPrevYear, curPrevYear);

        points.push({
          label: formatDDMMYYYY(cur),
          units: currSum ?? 0,
          prev_year_units: prevSum,
          yoy_pct: currSum != null && prevSum != null ? growthPct(currSum, prevSum) : null,
          mom_pct: null,
        });

        cur = isoPlusDays(cur, 1);
      }
      return points;
    }

    if (aggFreq === "weekly") {
      const weekMap = new Map<string, number>();
      const weekOffsets = new Map<string, Set<number>>();

      for (const d of filtered) {
        const wk = startOfWeekISO(d.date);
        weekMap.set(wk, (weekMap.get(wk) || 0) + d.generation_gwh);

        const off = Math.floor(
          (new Date(d.date + "T00:00:00Z").getTime() - new Date(wk + "T00:00:00Z").getTime()) / 86400000
        );
        if (!weekOffsets.has(wk)) weekOffsets.set(wk, new Set());
        weekOffsets.get(wk)!.add(off);
      }

      const weeks = Array.from(weekMap.keys()).sort(sortISO);

      // Compare partial weeks by using the same day-offset set from the current week
      const sumWeekByOffsets = (weekStartIso: string, offsetsSet: Set<number>) => {
        let s = 0;
        let hasAny = false;
        for (const off of offsetsSet) {
          const key = isoPlusDays(weekStartIso, off);
          const v = dailyLookup.get(key);
          if (v != null) {
            s += v;
            hasAny = true;
          }
        }
        return hasAny ? s : null;
      };

      return weeks.map((wk) => {
        const curr = weekMap.get(wk)!;
        const offs = weekOffsets.get(wk) || new Set<number>();

        const prevWkYoY = isoMinusDays(wk, 364);
        const prevYoY = sumWeekByOffsets(prevWkYoY, offs);

        const prevWkWoW = isoMinusDays(wk, 7);
        const prevWoW = sumWeekByOffsets(prevWkWoW, offs);

        return {
          label: `Wk of ${formatDDMMYYYY(wk)}`,
          units: curr,
          prev_year_units: prevYoY,
          yoy_pct: prevYoY != null ? growthPct(curr, prevYoY) : null,
          mom_pct: prevWoW != null ? growthPct(curr, prevWoW) : null,
        };
      });
    }

    // monthly
    const mMap = new Map<string, number>();
    const monthDays = new Map<string, Set<number>>();

    for (const d of filtered) {
      const mk = monthKey(d.date);
      mMap.set(mk, (mMap.get(mk) || 0) + d.generation_gwh);

      const day = Number(d.date.slice(8, 10));
      if (!monthDays.has(mk)) monthDays.set(mk, new Set());
      monthDays.get(mk)!.add(day);
    }

    const months = Array.from(mMap.keys()).sort(sortISO);

    const sumMonthByDaySet = (ym: string, daySet: Set<number>) => {
      const y = ym.slice(0, 4);
      const m = ym.slice(5, 7);
      let s = 0;
      let hasAny = false;
      for (const day of daySet) {
        const key = `${y}-${m}-${String(day).padStart(2, "0")}`;
        const v = dailyLookup.get(key);
        if (v != null) {
          s += v;
          hasAny = true;
        }
      }
      return hasAny ? s : null;
    };

    return months.map((m) => {
      const curr = mMap.get(m)!;
      const days = monthDays.get(m) || new Set<number>();

      const prevYearMonth = `${getYear(m) - 1}-${String(getMonth(m)).padStart(2, "0")}`;
      const prevYoY = sumMonthByDaySet(prevYearMonth, days);

      const prevMonth = addMonths(m, -1);
      const prevMoM = sumMonthByDaySet(prevMonth, days);

      return {
        label: m,
        units: curr,
        prev_year_units: prevYoY,
        yoy_pct: prevYoY != null ? growthPct(curr, prevYoY) : null,
        mom_pct: prevMoM != null ? growthPct(curr, prevMoM) : null,
      };
    });
  }, [sortedDaily, rangeDays, fromIso, toIso, aggFreq]);

  // Compute statistical control lines for the currently visible series.
// - Left axis: totals (Total Current if visible, else Total Previous Year)
// - Right axis: YoY% (only when YoY% is visible)
//
// We keep these separate because they live on different Y-axes and use different units.
const controlStatsLeft = useMemo(() => {
  if (!showControlLines) return null;
  if (!dailyForChart.length) return null;

  const values: number[] = [];

  // Prefer Total Current, else Total Previous Year.
  if (showUnitsSeries) {
    for (const p of dailyForChart) {
      const n = asFiniteNumber((p as any).units);
      if (n != null) values.push(n);
    }
  } else if (showPrevYearSeries) {
    for (const p of dailyForChart) {
      const n = asFiniteNumber((p as any).prev_year_units);
      if (n != null) values.push(n);
    }
  } else {
    // No totals visible => no left-axis control lines.
    return null;
  }

  if (values.length < 2) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  const sd = Math.sqrt(variance);

  return {
    mean,
    sd,
    p1: mean + sd,
    p2: mean + 2 * sd,
    m1: mean - sd,
    m2: mean - 2 * sd,
  };
}, [showControlLines, dailyForChart, showUnitsSeries, showPrevYearSeries]);

const controlStatsYoY = useMemo(() => {
  if (!showControlLines) return null;
  if (!dailyForChart.length) return null;

  // Only compute % control lines when YoY% is actually visible.
  if (!showYoYSeries) return null;

  const values: number[] = [];
  for (const p of dailyForChart) {
    const n = asFiniteNumber((p as any).yoy_pct);
    if (n != null) values.push(n);
  }

  if (values.length < 2) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  const sd = Math.sqrt(variance);

  return {
    mean,
    sd,
    p1: mean + sd,
    p2: mean + 2 * sd,
    m1: mean - sd,
    m2: mean - 2 * sd,
  };
}, [showControlLines, dailyForChart, showYoYSeries]);

  // Recharts draws horizontal reference lines easiest when values exist on every row.
// We attach constant fields to each row so we can render them as (flat) Line series.
const dailyForChartWithControl = useMemo(() => {
  if (!controlStatsLeft && !controlStatsYoY) return dailyForChart as any;

  return dailyForChart.map((p) => ({
    ...p,

    // VISUAL-ONLY rounding for chart rendering (does NOT affect raw calculations)
    units: p.units != null ? Number(p.units.toFixed(2)) : p.units,
    prev_year_units:
      p.prev_year_units != null ? Number(p.prev_year_units.toFixed(2)) : p.prev_year_units,
    yoy_pct: p.yoy_pct != null ? Number(p.yoy_pct.toFixed(2)) : p.yoy_pct,
    mom_pct: p.mom_pct != null ? Number(p.mom_pct.toFixed(2)) : p.mom_pct,

    // Left-axis (units) control lines
    __mean_units: controlStatsLeft ? Number(controlStatsLeft.mean.toFixed(2)) : null,
    __p1_units: controlStatsLeft ? Number(controlStatsLeft.p1.toFixed(2)) : null,
    __p2_units: controlStatsLeft ? Number(controlStatsLeft.p2.toFixed(2)) : null,
    __m1_units: controlStatsLeft ? Number(controlStatsLeft.m1.toFixed(2)) : null,
    __m2_units: controlStatsLeft ? Number(controlStatsLeft.m2.toFixed(2)) : null,

    // Right-axis (YoY%) control lines
    __mean_yoy: controlStatsYoY ? Number(controlStatsYoY.mean.toFixed(2)) : null,
    __p1_yoy: controlStatsYoY ? Number(controlStatsYoY.p1.toFixed(2)) : null,
    __p2_yoy: controlStatsYoY ? Number(controlStatsYoY.p2.toFixed(2)) : null,
    __m1_yoy: controlStatsYoY ? Number(controlStatsYoY.m1.toFixed(2)) : null,
    __m2_yoy: controlStatsYoY ? Number(controlStatsYoY.m2.toFixed(2)) : null,
  }));
}, [dailyForChart, controlStatsLeft, controlStatsYoY]);

  const monthly = useMemo(() => toMonthly(sortedDaily), [sortedDaily]);

  const monthlyForChart = useMemo(() => {
    if (!monthly.length) return [];
    return monthly.slice(Math.max(0, monthly.length - 24)).map((m) => ({
      month: m.month,
      total_units: m.total_gwh,
      yoy_pct: m.yoy_pct,
      mom_pct: m.mom_pct,
    }));
  }, [monthly]);

  const kpis = useMemo(() => computeKPIs(sortedDaily), [sortedDaily]);

  function upsertOne() {
    setMsg(null);
    setErrors([]);

    const iso = parseInputDate(date);
    if (!iso) {
      setErrors(["Please enter a valid date (DD-MM-YYYY)."]);
      return;
    }

    const v = Number(String(gwh).replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 0) {
      setErrors(["Please enter a valid non-negative number for generation."]);
      return;
    }

    setDataMap((prev) => {
      const next = new Map(prev);
      next.set(iso, v);
      return next;
    });

    setMsg(`Saved ${formatDDMMYYYY(iso)}: ${fmtNum(v)} units`);
    setGwh("");
  }

  function removeDate(isoDate: string) {
    setDataMap((prev) => {
      const next = new Map(prev);
      next.delete(isoDate);
      return next;
    });
  }

  function clearAll() {
    if (!confirm("Clear all stored data from this browser?")) return;
    setDataMap(new Map());
    setMsg("Cleared all data.");
  }

  async function importCSV(file?: File) {
    setMsg(null);
    setErrors([]);
    if (!file) return;

    try {
      const text = await file.text();
      const { parsed, errors: errs } = csvParse(text);

      if (errs.length) setErrors(errs.slice(0, 12));

      if (!parsed.length) {
        setErrors((e) => (e.length ? e : ["No valid rows found in CSV."]));
        return;
      }

      setDataMap((prev) => mergeRecords(prev, parsed));
      setMsg(`Imported ${parsed.length} rows${errs.length ? ` (with ${errs.length} issues)` : ""}.`);
    } catch {
      setErrors(["Could not read CSV."]);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function exportCSV() {
    const header = "date,generation_gwh";
    const lines = sortedDaily.map((d) => `${formatDDMMYYYY(d.date)},${d.generation_gwh}`);
    downloadCSV(
      `india_generation_${new Date().toISOString().slice(0, 10)}.csv`,
      [header, ...lines].join("\n")
    );
  }

  function loadSample() {
    const { parsed } = csvParse(sampleCSV());
    setDataMap((prev) => mergeRecords(prev, parsed));
    setMsg("Loaded sample data.");
  }

  // Auto-fetch via a backend proxy.
  // UI calls: /api/cea/daily?date=DD-MM-YYYY
  // Expected JSON: { date: "DD-MM-YYYY", total_mu: number }
  async function fetchLatestFromCEA() {
    setFetchStatus(null);

    const t = new Date();
    const dd = String(t.getDate()).padStart(2, "0");
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const yyyy = t.getFullYear();
    const ddmmyyyy = `${dd}-${mm}-${yyyy}`;

    setFetchStatus(`Fetching for ${ddmmyyyy}...`);

    try {
      const res = await fetch(`/api/cea/daily?date=${encodeURIComponent(ddmmyyyy)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();

      const iso = parseInputDate(j?.date);
      const total = Number(j?.total_mu);
      if (!iso) throw new Error("Bad date");
      if (!Number.isFinite(total) || total < 0) throw new Error("Bad total_mu");

      setDataMap((prev) => {
        const next = new Map(prev);
        next.set(iso, total);
        return next;
      });

      setFetchStatus(`Fetched & saved ${j.date}: ${fmtNum(total)} units (incl. RE)`);
    } catch {
      setFetchStatus("Auto-fetch failed (backend not deployed / source changed).");
    }
  }

  const hasData = sortedDaily.length > 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-2xl font-semibold text-slate-900">India Electricity Generation Dashboard</div>
            <div className="mt-1 text-sm text-slate-600">
              Track daily all-India generation (units/MU) and view monthly totals, YoY% and MoM% growth.
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => downloadCSV("sample_generation.csv", sampleCSV())}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Download sample CSV
            </button>
            <button
              onClick={fetchLatestFromCEA}
              className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Auto-fetch latest (incl. RE)
            </button>
            <button
              onClick={exportCSV}
              disabled={!hasData}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              onClick={clearAll}
              disabled={!hasData}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Clear data
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Add / Update a day">
            <div className="grid grid-cols-1 gap-3">
              <label className="text-xs font-medium text-slate-600">Date (DD-MM-YYYY)</label>
              <input
                type="text"
                placeholder="DD-MM-YYYY"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
              />

              <label className="mt-1 text-xs font-medium text-slate-600">Generation (units / MU)</label>
              <input
                inputMode="decimal"
                placeholder="e.g., 4200"
                value={gwh}
                onChange={(e) => setGwh(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
              />

              <button
                onClick={upsertOne}
                className="mt-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Save day
              </button>

              <div className="mt-2">
                <div className="text-xs font-medium text-slate-600">Import CSV</div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => importCSV(e.target.files?.[0])}
                    className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                  />
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Supported: <span className="font-mono">date,generation_gwh</span> (DD-MM-YYYY, number)
                </div>
              </div>

              {msg ? (
                <div className="mt-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
                  {msg}
                </div>
              ) : null}

              {fetchStatus ? (
                <div className="mt-2 rounded-xl bg-slate-900/5 p-3 text-sm text-slate-800 ring-1 ring-slate-200">
                  {fetchStatus}
                </div>
              ) : null}

              {errors.length ? (
                <div className="mt-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">
                  <div className="font-semibold">Import / input issues</div>
                  <ul className="mt-1 list-disc pl-5">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Quick stats" right={hasData ? `Records: ${sortedDaily.length}` : null}>
            {!hasData ? (
              <EmptyState onLoadSample={loadSample} />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat
                  label="Latest day"
                  value={kpis.latest ? formatDDMMYYYY(kpis.latest.date) : "—"}
                  sub={kpis.latest ? `${fmtNum(kpis.latest.generation_gwh)} units` : null}
                />

                <Stat label="Latest YoY (same day)" value={fmtPct(kpis.latestYoY, 2)} sub="vs same date last year (if available)" />

                <Stat
                  label="Current 7-Day Average Units"
                  value={kpis.avg7 != null ? `${fmtNum(kpis.avg7)} units` : "—"}
                  sub={kpis.avg7YoY != null ? `${fmtPct(kpis.avg7YoY, 2)} YoY` : "YoY: —"}
                />

                <Stat
                  label="Current 30-Day Average Units"
                  value={kpis.avg30 != null ? `${fmtNum(kpis.avg30)} units` : "—"}
                  sub={kpis.avg30YoY != null ? `${fmtPct(kpis.avg30YoY, 2)} YoY` : "YoY: —"}
                />

                <Stat
                  label="YTD Total Units (from 1 Apr)"
                  value={kpis.ytdTotal != null ? `${fmtNum(kpis.ytdTotal)} units` : "—"}
                  sub={kpis.ytdYoY != null ? `${fmtPct(kpis.ytdYoY, 2)} YoY` : "YoY: —"}
                  accent="ytd"
                />

                <Stat
                  label="MTD Average Units"
                  value={kpis.mtdAvg != null ? `${fmtNum(kpis.mtdAvg)} units` : "—"}
                  sub={kpis.mtdYoY != null ? `${fmtPct(kpis.mtdYoY, 2)} YoY` : "YoY: —"}
                />
              </div>
            )}
          </Card>

          <Card title="Recent entries">
            {!hasData ? (
              <div className="text-sm text-slate-600">Once you add data, the most recent entries will appear here.</div>
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-xl ring-1 ring-slate-200">
                <table className="w-full border-collapse bg-white text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">Date</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">Generation (units)</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDaily
                      .slice(-25)
                      .reverse()
                      .map((r) => (
                        <tr key={r.date} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium text-slate-900">{formatDDMMYYYY(r.date)}</td>
                          <td className="px-3 py-2 text-slate-700">{fmtNum(r.generation_gwh)}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => removeDate(r.date)}
                              className="rounded-lg px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card
            title="Daily generation"
            right={
              hasData ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Range</span>
                  <select
                    value={rangeDays}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRangeDays(v);
                      if (sortedDaily.length) {
                        const lastIso = sortedDaily[sortedDaily.length - 1].date;
                        setToIso(lastIso);
                        setFromIso(isoMinusDays(lastIso, clamp(v, 7, 3650)));
                      }
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                  >
                    <option value={60}>Last 60 days</option>
                    <option value={120}>Last 120 days</option>
                    <option value={365}>Last 12 months</option>
                    <option value={730}>Last 24 months</option>
                    <option value={1825}>Last 5 years</option>
                    <option value={3650}>Last 10 years</option>
                  </select>
                </div>
              ) : null
            }
          >
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see the daily chart.</div>
            ) : (
              <>
                <div className="mb-3 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
                    <div>
                      <div className="text-xs font-medium text-slate-600">From</div>
                      <input
                        type="date"
                        value={fromIso}
                        onChange={(e) => setFromIso(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
                      />
                      <div className="mt-1 text-[11px] text-slate-500">{fromIso ? formatDDMMYYYY(fromIso) : ""}</div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-slate-600">To</div>
                      <input
                        type="date"
                        value={toIso}
                        onChange={(e) => setToIso(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
                      />
                      <div className="mt-1 text-[11px] text-slate-500">{toIso ? formatDDMMYYYY(toIso) : ""}</div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-slate-600">View as</div>
                      <select
                        value={aggFreq}
                        onChange={(e) => setAggFreq(e.target.value as any)}
                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly (sum)</option>
                        <option value="monthly">Monthly (sum)</option>
                        <option value="rolling30">Last 30 Days Rolling Sum (YoY Demand Growth)</option>
                      </select>

                      <div className="mt-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-slate-700">Series toggles</div>
                          <label className="flex items-center gap-2 text-[12px] text-slate-700">
                            <input
                              type="checkbox"
                              checked={showControlLines}
                              onChange={(e) => setShowControlLines(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Show Control Lines</span>
                          </label>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-slate-700">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showUnitsSeries}
                              onChange={(e) => setShowUnitsSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Total Current</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showPrevYearSeries}
                              onChange={(e) => setShowPrevYearSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Total (previous year)</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showYoYSeries}
                              onChange={(e) => setShowYoYSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">YoY %</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showMoMSeries}
                              onChange={(e) => setShowMoMSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">MoM %</span>
                          </label>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setShowUnitsSeries(false);
                              setShowPrevYearSeries(false);
                              setShowMoMSeries(false);
                              setShowYoYSeries(true);
                            }}
                            className="rounded-lg bg-slate-900 px-2 py-1 text-[12px] font-semibold text-white hover:bg-slate-800"
                          >
                            YoY% only
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowUnitsSeries(true);
                              setShowPrevYearSeries(true);
                              setShowMoMSeries(false);
                              setShowYoYSeries(false);
                            }}
                            className="rounded-lg bg-white px-2 py-1 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                          >
                            Totals only
                          </button>
                        </div>
                      </div>

                      <div className="mt-1 text-[11px] text-slate-500">
                        Weekly/Monthly uses the same day-window for YoY and prior-period % (prevents partial-period
                        distortion).
                      </div>
                    </div>
                  </div>
                </div>

                <div className="h-[340px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={dailyForChartWithControl} margin={{ top: 10, right: 18, bottom: 10, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />

                      {anyTotalsShown ? (
                        <YAxis
                          yAxisId="left"
                          tick={{ fontSize: 12 }}
                          tickFormatter={(v) => fmtNum(asFiniteNumber(v) ?? null, 2)}
                        />
                      ) : null}
                      {anyPctShown ? (
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          tick={{ fontSize: 12 }}
                          tickFormatter={(v) => fmtPct(asFiniteNumber(v) ?? null, 2)}
                        />
                      ) : null}

                      <Tooltip
                        formatter={(v: any, name: any, item: any) => {
                          // In Recharts, the 2nd arg can be the *display name* (e.g., "YoY %"),
                          // not the underlying dataKey (e.g., "yoy_pct").
                          // So we prefer item.dataKey when available.
                          const key = (item && (item.dataKey as string)) || (name as string);
                          const num = asFiniteNumber(v);

                          // Totals
                          if (key === "units") {
                            return [
                              `${fmtNum(num ?? null, 2)} units`,
                              aggFreq === "daily" ? "Generation" : "Total (current)",
                            ];
                          }
                          if (key === "prev_year_units") {
                            return [`${fmtNum(num ?? null, 2)} units`, "Total (previous year)"];
                          }

                          // % series
                          if (key === "yoy_pct") return [fmtPct(num ?? null, 2), "YoY %"];
                          if (key === "mom_pct") return [fmtPct(num ?? null, 2), aggFreq === "weekly" ? "WoW %" : "MoM %"];

                          // Control lines (units)
                          if (key === "__mean_units") return [`${fmtNum(num ?? null, 2)} units`, "Mean (units)"];
                          if (key === "__p1_units") return [`${fmtNum(num ?? null, 2)} units`, "+1σ (units)"];
                          if (key === "__p2_units") return [`${fmtNum(num ?? null, 2)} units`, "+2σ (units)"];
                          if (key === "__m1_units") return [`${fmtNum(num ?? null, 2)} units`, "-1σ (units)"];
                          if (key === "__m2_units") return [`${fmtNum(num ?? null, 2)} units`, "-2σ (units)"];

                          // Control lines (YoY%)
                          if (key === "__mean_yoy") return [fmtPct(num ?? null, 2), "Mean (YoY%)"];
                          if (key === "__p1_yoy") return [fmtPct(num ?? null, 2), "+1σ (YoY%)"];
                          if (key === "__p2_yoy") return [fmtPct(num ?? null, 2), "+2σ (YoY%)"];
                          if (key === "__m1_yoy") return [fmtPct(num ?? null, 2), "-1σ (YoY%)"];
                          if (key === "__m2_yoy") return [fmtPct(num ?? null, 2), "-2σ (YoY%)"];

                          // Fallback: keep it readable (2 dp) for any unexpected numeric series.
                          if (num != null) return [fmtNum(num, 2), String(name)];
                          return [v, String(name)];
                        }}
                        labelFormatter={(l: any) =>
                          `${aggFreq === "daily" ? "Date" : aggFreq === "weekly" ? "Week" : aggFreq === "monthly" ? "Month" : "Date"}: ${l}`
                        }
                      />
                      <Legend />

                      {/* Statistical control lines (computed from the currently visible series) */}
                      {/* Units control lines (left axis) */}
                      {showControlLines && controlStatsLeft && anyTotalsForStats ? (
                        <>
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__mean_units"
                            name="Mean (units)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#7c3aed"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__p1_units"
                            name="+1σ (units)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#7c3aed"
                            strokeDasharray="6 4"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__p2_units"
                            name="+2σ (units)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#7c3aed"
                            strokeDasharray="2 6"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__m1_units"
                            name="-1σ (units)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#7c3aed"
                            strokeDasharray="6 4"
                          />
                          <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey="__m2_units"
                            name="-2σ (units)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#7c3aed"
                            strokeDasharray="2 6"
                          />
                        </>
                      ) : null}

                      {/* YoY% control lines (right axis) */}
                      {showControlLines && controlStatsYoY && showYoYSeries ? (
                        <>
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__mean_yoy"
                            name="Mean (YoY%)"
                            dot={false}
                            strokeWidth={2}
                            stroke="#0f766e"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__p1_yoy"
                            name="+1σ (YoY%)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#0f766e"
                            strokeDasharray="6 4"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__p2_yoy"
                            name="+2σ (YoY%)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#0f766e"
                            strokeDasharray="2 6"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__m1_yoy"
                            name="-1σ (YoY%)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#0f766e"
                            strokeDasharray="6 4"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="__m2_yoy"
                            name="-2σ (YoY%)"
                            dot={false}
                            strokeWidth={1.5}
                            stroke="#0f766e"
                            strokeDasharray="2 6"
                          />
                        </>
                      ) : null}

                      {showUnitsSeries ? (
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="units"
                          name={
                            aggFreq === "daily"
                              ? "Total Current"
                              : aggFreq === "rolling30"
                              ? "30D Rolling Sum (current)"
                              : "Total Current"
                          }
                          dot={false}
                          strokeWidth={2}
                          stroke="#dc2626"
                        />
                      ) : null}

                      {showPrevYearSeries ? (
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="prev_year_units"
                          name={aggFreq === "rolling30" ? "30D Rolling Sum (prev year)" : "Total (previous year)"}
                          dot={false}
                          strokeWidth={2}
                          stroke="#64748b"
                        />
                      ) : null}

                      {showYoYSeries ? (
                        <Line yAxisId="right" type="monotone" dataKey="yoy_pct" name="YoY %" dot={false} strokeWidth={2} stroke="#16a34a" />
                      ) : null}

                      {showMoMSeries ? (
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="mom_pct"
                          name={aggFreq === "weekly" ? "WoW %" : "MoM %"}
                          dot={false}
                          strokeWidth={2}
                          stroke="#dc2626"
                        />
                      ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Card>

          <Card title="Monthly totals + growth">
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see monthly totals and growth.</div>
            ) : (
              <div className="space-y-4">
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => fmtNum(asFiniteNumber(v) ?? null, 2)} />
                      <Tooltip
                        formatter={(v: any, n: any) => {
                          const num = asFiniteNumber(v);
                          if (n === "total_units") return [`${fmtNum(num ?? null, 2)} units`, "Monthly total"];
                          if (n === "yoy_pct") return [fmtPct(num ?? null, 2), "YoY"];
                          if (n === "mom_pct") return [fmtPct(num ?? null, 2), "MoM"];
                          return [v, n];
                        }}
                      />
                      <Legend />
                      <Bar dataKey="total_units" name="Monthly total (units)" fill="#dc2626" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => fmtPct(asFiniteNumber(v) ?? null, 2)} />
                      <Tooltip
                        formatter={(v: any, n: any) => {
                          const num = asFiniteNumber(v);
                          if (n === "yoy_pct") return [fmtPct(num ?? null, 2), "YoY"];
                          if (n === "mom_pct") return [fmtPct(num ?? null, 2), "MoM"];
                          return [v, n];
                        }}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="yoy_pct" name="YoY %" dot={false} strokeWidth={2} stroke="#16a34a" />
                      <Line type="monotone" dataKey="mom_pct" name="MoM %" dot={false} strokeWidth={2} stroke="#dc2626" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-semibold text-slate-700">How growth is calculated</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
                    <li>
                      <span className="font-medium">MoM%</span> compares the same day-range (e.g., 1st–15th vs 1st–15th of
                      prior month if current month is incomplete).
                    </li>
                    <li>
                      <span className="font-medium">YoY%</span> compares the same day-range (e.g., 1st–15th vs 1st–15th last
                      year if current month is incomplete).
                    </li>
                    <li>
                      Latest <span className="font-medium">MoM (MTD avg)</span> compares month-to-date average vs prior month
                      month-to-date average (same day-of-month window).
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="mt-6">
          <Card title="Monthly table (last 24 months)">
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see the monthly table.</div>
            ) : (
              <div className="overflow-auto rounded-xl ring-1 ring-slate-200">
                <table className="w-full border-collapse bg-white text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">Month</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">Total (units)</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">MoM%</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyForChart
                      .slice()
                      .reverse()
                      .map((m) => (
                        <tr key={m.month} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium text-slate-900">{m.month}</td>
                          <td className="px-3 py-2 text-slate-700">{fmtNum(m.total_units, 2)}</td>
                          <td className="px-3 py-2 text-slate-700">{fmtPct(m.mom_pct, 2)}</td>
                          <td className="px-3 py-2 text-slate-700">{fmtPct(m.yoy_pct, 2)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="mt-6 text-xs text-slate-500">
          Tip: Auto-fetch needs a small backend proxy because CEA/NPP downloads often block browser-to-site requests (CORS).
          This UI expects an endpoint at /api/cea/daily that returns Total generation incl. RE.
        </div>
      </div>
    </div>
  );
}

