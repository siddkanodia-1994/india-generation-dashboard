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
 * India Electricity Generation Dashboard
 * Single-file React app (Vite + Recharts)
 * Safe for Vercel deployment
 */

const STORAGE_KEY = "tusk_india_generation_v1";

/* =========================
   Utilities
========================= */

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function parseISOKey(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

function parseInputDate(s: unknown) {
  if (typeof s !== "string") return null;
  const t = s.trim();

  if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {
    const [dd, mm, yyyy] = t.split("-").map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      Number.isNaN(d.getTime()) ||
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
  if (!iso) return "—";
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

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function growthPct(curr: number, prev: number) {
  if (!prev) return null;
  return ((curr - prev) / prev) * 100;
}

/* =========================
   Types
========================= */

type DailyPoint = {
  date: string;
  generation_gwh: number;
};

type ChartPoint = {
  label: string;
  units: number | null;
  prev_year_units: number | null;
  yoy_pct: number | null;
  mom_pct: number | null;
};

/* =========================
   App
========================= */

export default function App() {
  /* ---------- State ---------- */

  const [dataMap, setDataMap] = useState<Map<string, number>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj).map(([k, v]) => [k, Number(v)]));
    } catch {
      return new Map();
    }
  });

  const [date, setDate] = useState("");
  const [gwh, setGwh] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const [fromIso, setFromIso] = useState("");
  const [toIso, setToIso] = useState("");
  const [rangeDays, setRangeDays] = useState(120);
  const [aggFreq, setAggFreq] = useState<"daily" | "rolling30">("daily");

  const [showUnitsSeries, setShowUnitsSeries] = useState(true);
  const [showPrevYearSeries, setShowPrevYearSeries] = useState(true);
  const [showYoYSeries, setShowYoYSeries] = useState(true);
  const [showMoMSeries, setShowMoMSeries] = useState(true);
  const [showControlLines, setShowControlLines] = useState(false);

  /* ✅ FIXED */
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* ---------- Derived ---------- */

  const sortedDaily = useMemo<DailyPoint[]>(() => {
    return Array.from(dataMap.entries())
      .map(([date, generation_gwh]) => ({ date, generation_gwh }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [dataMap]);

  useEffect(() => {
    const obj = Object.fromEntries(dataMap.entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }, [dataMap]);

  useEffect(() => {
    if (!sortedDaily.length) return;
    const last = sortedDaily.at(-1)!.date;
    if (!toIso) setToIso(last);
    if (!fromIso) setFromIso(isoMinusDays(last, clamp(rangeDays, 7, 3650)));
  }, [sortedDaily, toIso, fromIso, rangeDays]);

  /* ---------- Chart Data ---------- */

  const dailyForChart = useMemo<ChartPoint[]>(() => {
    if (!sortedDaily.length) return [];

    const f = fromIso;
    const t = toIso;
    const lookup = new Map(sortedDaily.map((d) => [d.date, d.generation_gwh]));

    if (aggFreq === "daily") {
      return sortedDaily
        .filter((d) => d.date >= f && d.date <= t)
        .map((d) => {
          const pyDate = `${Number(d.date.slice(0, 4)) - 1}${d.date.slice(4)}`;
          const py = lookup.get(pyDate) ?? null;

          return {
            label: formatDDMMYYYY(d.date),
            units: Number(d.generation_gwh.toFixed(2)),
            prev_year_units: py != null ? Number(py.toFixed(2)) : null,
            yoy_pct: py != null ? Number(growthPct(d.generation_gwh, py)?.toFixed(2)) : null,
            mom_pct: null,
          };
        });
    }

    /* rolling30 */
    const out: ChartPoint[] = [];
    let cur = f;
    while (cur <= t) {
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < 30; i++) {
        const d = isoMinusDays(cur, i);
        if (lookup.has(d)) {
          sum += lookup.get(d)!;
          cnt++;
        }
      }

      const prevEnd = isoMinusDays(cur, 365);
      let prevSum = 0;
      let prevCnt = 0;
      for (let i = 0; i < 30; i++) {
        const d = isoMinusDays(prevEnd, i);
        if (lookup.has(d)) {
          prevSum += lookup.get(d)!;
          prevCnt++;
        }
      }

      out.push({
        label: formatDDMMYYYY(cur),
        units: cnt ? Number(sum.toFixed(2)) : null,
        prev_year_units: prevCnt ? Number(prevSum.toFixed(2)) : null,
        yoy_pct: cnt && prevCnt ? Number(growthPct(sum, prevSum)?.toFixed(2)) : null,
        mom_pct: null,
      });

      cur = isoPlusDays(cur, 1);
    }

    return out;
  }, [sortedDaily, fromIso, toIso, aggFreq]);

  const hasData = sortedDaily.length > 0;

  /* ---------- Actions ---------- */

  function saveDay() {
    setErrors([]);
    const iso = parseInputDate(date);
    if (!iso) return setErrors(["Invalid date (DD-MM-YYYY)"]);
    const val = Number(gwh);
    if (!Number.isFinite(val) || val < 0) return setErrors(["Invalid units"]);
    setDataMap((p) => new Map(p).set(iso, val));
    setMsg(`Saved ${formatDDMMYYYY(iso)}`);
    setGwh("");
  }

  async function importCSV(file?: File) {
    if (!file) return;
    const text = await file.text();
    const rows = text.split(/\r?\n/).slice(1);
    setDataMap((prev) => {
      const next = new Map(prev);
      rows.forEach((r) => {
        const [d, v] = r.split(",");
        const iso = parseInputDate(d);
        const num = Number(v);
        if (iso && Number.isFinite(num)) next.set(iso, num);
      });
      return next;
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  /* ---------- UI ---------- */

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <h1 className="text-2xl font-semibold mb-4">India Electricity Generation Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded-xl shadow">
          <div className="text-sm font-medium mb-2">Add / Update Day</div>
          <input
            className="w-full border p-2 mb-2"
            placeholder="DD-MM-YYYY"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <input
            className="w-full border p-2 mb-2"
            placeholder="Units"
            value={gwh}
            onChange={(e) => setGwh(e.target.value)}
          />
          <button className="bg-black text-white px-3 py-2 rounded" onClick={saveDay}>
            Save
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="mt-3"
            onChange={(e) => importCSV(e.target.files?.[0])}
          />

          {msg && <div className="text-green-600 mt-2">{msg}</div>}
          {errors.map((e, i) => (
            <div key={i} className="text-red-600 text-sm">
              {e}
            </div>
          ))}
        </div>
      </div>

      {hasData && (
        <div className="bg-white p-4 rounded-xl shadow h-[400px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={dailyForChart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis />
              <Tooltip />
              <Legend />

              {showUnitsSeries && <Line dataKey="units" name="Total Current" stroke="#dc2626" dot={false} />}
              {showPrevYearSeries && (
                <Line dataKey="prev_year_units" name="Previous Year" stroke="#64748b" dot={false} />
              )}
              {showYoYSeries && <Line dataKey="yoy_pct" name="YoY %" stroke="#16a34a" dot={false} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
