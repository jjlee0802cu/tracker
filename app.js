const OWNER = "jjlee0802cu";
const REPO = "tracker";
const BRANCH = "main";
const TZ = "America/New_York";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
const INDEX = "data/trackers.json";

const state = { trackers: [], data: {} };
const shas = {};
let queue = Promise.resolve();

const token = () => localStorage.getItem("gh_token");
const headers = () => ({ Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json" });

// --- dates (YYYY-MM-DD strings, "today" in New York time) ---
const todayStr = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const asDate = (s) => new Date(s + "T00:00:00Z");
const weekday = (s) => asDate(s).getUTCDay();
function addDays(s, n) {
  const d = asDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --- GitHub storage ---
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64encode(str) {
  let bin = "";
  new TextEncoder().encode(str).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function readJson(path) {
  // Logged in: read via the API so edits show up before Pages redeploys.
  if (token()) {
    const res = await fetch(`${API}${path}?ref=${BRANCH}`, { headers: headers(), cache: "no-store" });
    if (res.status === 401) {
      localStorage.removeItem("gh_token");
      throw new Error("GitHub rejected the token. Log in again.");
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
    const file = await res.json();
    shas[path] = file.sha;
    return JSON.parse(b64decode(file.content));
  }
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function writeJson(path, data, message) {
  const body = { message, branch: BRANCH, content: b64encode(JSON.stringify(data, null, 2) + "\n") };
  if (shas[path]) body.sha = shas[path];
  const res = await fetch(API + path, { method: "PUT", headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  shas[path] = (await res.json()).content.sha;
}

// Serialize writes so each one uses the sha returned by the previous one.
function save(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  p.catch((err) => {
    alert(`Save failed: ${err.message}`);
    load();
  });
}

// --- actions ---
function setScale(id, date) {
  const days = state.data[id];
  const input = prompt(`Scale for ${date} (0 to clear)`, days[date] || "");
  if (input === null) return;
  const n = Math.max(0, Math.floor(Number(input)));
  if (!Number.isFinite(n)) return alert("Enter a number.");
  if (n === (days[date] || 0)) return;
  if (n) days[date] = n;
  else delete days[date];
  render();
  const sorted = Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)));
  const name = state.trackers.find((t) => t.id === id).name;
  save(() => writeJson(`data/${id}.json`, sorted, `${name}: ${date} scale ${n}`));
}

function newTracker() {
  const name = (prompt("Tracker name (e.g. Reading)") || "").trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id || state.trackers.some((t) => t.id === id)) return alert("That name is empty or already used.");
  state.trackers.push({ id, name });
  state.data[id] = {};
  render();
  const trackers = [...state.trackers];
  save(async () => {
    await writeJson(`data/${id}.json`, {}, `Create tracker ${name}`);
    await writeJson(INDEX, trackers, `Add tracker ${name}`);
  });
}

function logIn() {
  const t = (prompt("Paste a fine-grained GitHub token (Contents: read and write on this repo)") || "").trim();
  if (!t) return;
  localStorage.setItem("gh_token", t);
  load();
}

function logOut() {
  localStorage.removeItem("gh_token");
  load();
}

// --- rendering ---
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(text, onClick) {
  const b = el("button", null, text);
  b.onclick = onClick;
  return b;
}

function yearRange(year, today) {
  const first = `${year}-01-01`;
  const start = addDays(first, -weekday(first));
  const weeksTo = (d) => Math.floor((asDate(d) - asDate(start)) / 864e5 / 7) + 1;
  return { first, start, weeks: weeksTo(today), yearWeeks: weeksTo(`${year}-12-31`) };
}

// GitHub-style shading: four equal bands from 0 up to the busiest day shown, ignoring outliers
// (Tukey fence, k=3) so one huge day doesn't wash out the rest.
function shadeCap(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const i = (v.length - 1) * p;
    return v[Math.floor(i)] + (v[Math.ceil(i)] - v[Math.floor(i)]) * (i % 1);
  };
  const fence = v.length >= 4 ? q(0.75) + 3 * (q(0.75) - q(0.25)) : Infinity;
  return Math.max(...v.filter((x) => x <= fence));
}

function level(v, cap) {
  return v ? Math.min(4, Math.ceil((4 * v) / cap)) : 0;
}

function cellGrid(t, today, first, start, onClick) {
  const days = state.data[t.id];
  const cap = shadeCap(Object.entries(days).filter(([d]) => d >= first && d <= today).map(([, v]) => v));
  const cells = el("div", "cells");
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (d < first) {
      cells.append(el("div", "cell pad"));
      continue;
    }
    const v = days[d] || 0;
    const c = el("div", `cell l${level(v, cap)}` + (d === today ? " today" : ""));
    c.title = `${d}${v ? ` - scale ${v}` : ""}`;
    if (onClick) {
      const date = d;
      c.onclick = () => onClick(date);
    }
    cells.append(c);
  }
  return cells;
}

function chart(t, today, year, editable) {
  const { first, start, weeks } = yearRange(year, today);
  const root = el("div", "chart" + (editable ? " editable" : ""));

  // Month labels at the week holding each month's 1st, dropped if the next one is too close to fit.
  const months = el("div", "months");
  const marks = [];
  const monthOfWeek = (w) => {
    const sat = addDays(start, w * 7 + 6);
    return asDate(sat > today ? today : sat).getUTCMonth();
  };
  for (let w = 0; w < weeks; w++) {
    if (w === 0 || monthOfWeek(w) !== monthOfWeek(w - 1)) marks.push([w, monthOfWeek(w)]);
  }
  marks.forEach(([w, m], i) => {
    if (marks[i + 1] && marks[i + 1][0] - w < 3) return;
    const s = el("span", null, new Date(Date.UTC(2000, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }));
    s.style.gridColumn = w + 1;
    months.append(s);
  });

  const days = el("div", "days");
  ["", "Mon", "", "Wed", "", "Fri", ""].forEach((d) => days.append(el("span", null, d)));

  const cells = cellGrid(t, today, first, start, editable ? (date) => setScale(t.id, date) : null);
  root.append(el("div"), months, days, cells);
  const scroll = el("div", "scroll");
  scroll.append(root);
  return scroll;
}

// Read-only thumbnail of the year that fits the width; space is reserved for the rest of the year.
function overview(t, today, year) {
  const { first, start, yearWeeks } = yearRange(year, today);
  const cells = cellGrid(t, today, first, start, null);
  cells.className = "mini";
  cells.style.gridTemplateColumns = `repeat(${yearWeeks}, minmax(0, 1fr))`;
  return cells;
}

function legend() {
  const l = el("div", "legend");
  l.append(el("span", null, "Less"));
  for (let i = 0; i <= 4; i++) l.append(el("div", `cell l${i}`));
  l.append(el("span", null, "More"));
  return l;
}

function render() {
  const editable = !!token();
  const today = todayStr();
  const year = today.slice(0, 4);

  const auth = document.getElementById("auth");
  auth.replaceChildren(...(editable ? [button("New tracker", newTracker), button("Log out", logOut)] : [button("Log in", logIn)]));

  const main = document.getElementById("trackers");
  main.replaceChildren();
  if (!state.trackers.length) main.append(el("p", "muted", "No trackers yet."));

  for (const t of state.trackers) {
    const days = state.data[t.id];
    const count = Object.keys(days).filter((d) => d.startsWith(year)).length;
    const card = el("section", "card");
    const head = el("div", "card-head");
    const title = el("div");
    title.append(el("h2", null, t.name), el("div", "count", `${count} day${count === 1 ? "" : "s"} in ${year}`));
    head.append(title);
    if (editable) head.append(button(days[today] ? `Today: ${days[today]}` : "Log today", () => setScale(t.id, today)));
    const foot = el("div", "card-foot");
    foot.append(overview(t, today, year), legend());
    card.append(head, chart(t, today, year, editable), foot);
    main.append(card);
  }
  // Start the scrollable chart at today, after layout settles.
  requestAnimationFrame(() =>
    document.querySelectorAll(".scroll").forEach((s) => {
      const c = s.querySelector(".today");
      if (c) s.scrollLeft = c.offsetLeft - s.clientWidth / 2;
    })
  );
}

async function load() {
  const hadToken = !!token();
  try {
    state.trackers = (await readJson(INDEX)) || [];
    const lists = await Promise.all(state.trackers.map((t) => readJson(`data/${t.id}.json`)));
    // Older files are a plain list of dates; treat each as scale 1.
    state.trackers.forEach((t, i) => {
      const raw = lists[i] || {};
      state.data[t.id] = Array.isArray(raw) ? Object.fromEntries(raw.map((d) => [d, 1])) : raw;
    });
  } catch (err) {
    alert(err.message);
    // A rejected token was cleared; reload read-only.
    if (hadToken && !token()) return load();
    return;
  }
  render();
}

load();
