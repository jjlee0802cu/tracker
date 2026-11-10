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
function toggle(id, date) {
  const set = state.data[id];
  const had = set.has(date);
  if (date !== todayStr() && !confirm(`${had ? "Unmark" : "Mark"} ${date}?`)) return;
  had ? set.delete(date) : set.add(date);
  render();
  const dates = [...set].sort();
  const name = state.trackers.find((t) => t.id === id).name;
  save(() => writeJson(`data/${id}.json`, dates, `${name}: ${had ? "unmark" : "mark"} ${date}`));
}

function newTracker() {
  const name = (prompt("Tracker name (e.g. Reading)") || "").trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id || state.trackers.some((t) => t.id === id)) return alert("That name is empty or already used.");
  state.trackers.push({ id, name });
  state.data[id] = new Set();
  render();
  const trackers = [...state.trackers];
  save(async () => {
    await writeJson(`data/${id}.json`, [], `Create tracker ${name}`);
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

function chart(t, today, start, editable) {
  const set = state.data[t.id];
  const root = el("div", "chart" + (editable ? " editable" : ""));
  const weeks = Math.floor((asDate(today) - asDate(start)) / 864e5 / 7) + 1;

  // Month labels: one per month change, dropped if the next one is too close to fit.
  const months = el("div", "months");
  const marks = [];
  for (let w = 0; w < weeks; w++) {
    const m = asDate(addDays(start, w * 7)).getUTCMonth();
    if (w === 0 || m !== asDate(addDays(start, (w - 1) * 7)).getUTCMonth()) marks.push([w, m]);
  }
  marks.forEach(([w, m], i) => {
    if (marks[i + 1] && marks[i + 1][0] - w < 3) return;
    const s = el("span", null, new Date(Date.UTC(2000, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }));
    s.style.gridColumn = w + 1;
    months.append(s);
  });

  const days = el("div", "days");
  ["", "Mon", "", "Wed", "", "Fri", ""].forEach((d) => days.append(el("span", null, d)));

  const cells = el("div", "cells");
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const on = set.has(d);
    const c = el("div", "cell" + (on ? " on" : "") + (d === today ? " today" : ""));
    c.title = `${d}${on ? " - done" : ""}`;
    c.setAttribute("aria-label", c.title);
    if (editable) {
      const date = d;
      c.onclick = () => toggle(t.id, date);
    }
    cells.append(c);
  }

  root.append(el("div"), months, days, cells);
  return root;
}

function render() {
  const editable = !!token();
  const today = todayStr();
  const start = addDays(today, -(52 * 7 + weekday(today)));

  const auth = document.getElementById("auth");
  auth.replaceChildren(...(editable ? [button("New tracker", newTracker), button("Log out", logOut)] : [button("Log in", logIn)]));

  const main = document.getElementById("trackers");
  main.replaceChildren();
  if (!state.trackers.length) main.append(el("p", "muted", "No trackers yet."));

  for (const t of state.trackers) {
    const set = state.data[t.id];
    const count = [...set].filter((d) => d >= start && d <= today).length;
    const card = el("section", "card");
    const head = el("div", "card-head");
    const title = el("div");
    title.append(el("h2", null, t.name), el("div", "count", `${count} day${count === 1 ? "" : "s"} in the last year`));
    head.append(title);
    if (editable) head.append(button(set.has(today) ? "Undo today" : "Done today", () => toggle(t.id, today)));
    const scroll = el("div", "scroll");
    scroll.append(chart(t, today, start, editable));
    card.append(head, scroll);
    main.append(card);
  }
  document.querySelectorAll(".scroll").forEach((s) => (s.scrollLeft = s.scrollWidth));
}

async function load() {
  const hadToken = !!token();
  try {
    state.trackers = (await readJson(INDEX)) || [];
    const lists = await Promise.all(state.trackers.map((t) => readJson(`data/${t.id}.json`)));
    state.trackers.forEach((t, i) => (state.data[t.id] = new Set(lists[i] || [])));
  } catch (err) {
    alert(err.message);
    // A rejected token was cleared; reload read-only.
    if (hadToken && !token()) return load();
    return;
  }
  render();
}

load();
