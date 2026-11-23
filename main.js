"use strict";
/*
 * Home Project Manager: a home dashboard, project pages, session notes and an
 * agent-friendly update log for Obsidian. File formats: see README.md.
 *   ```home-panel```       full dashboard (options: "name: Alex", "feed: 25")
 *   ```project-updates```  timeline for the project whose hub note contains the block
 *   ```project-done```     in a session note: tasks checked off between the previous session and this one
 *   ```project-tasks```    in a session note: open tasks carried in (project from the note's frontmatter)
 */
const {
  Plugin, PluginSettingTab, Modal, Notice, Setting, Menu, Component, MarkdownRenderer, MarkdownRenderChild,
  setIcon, normalizePath, moment,
} = require("obsidian");

const SPARK_WEEKS = 8;

// Everything below that depends on the user's vault is filled from settings by applyConfig().
let STALE_DAYS = 14;
let DUE_SOON_DAYS = 14;
let OLD_TASK_DAYS = 60;
let PROJECTS_ROOT = "Projects";
let ARCHIVE_ROOT = "Archive/Projects";
let IGNORED = [];
let MEETINGS_DIR = "Meetings";
let UPDATES_DIR = "Updates";
let SESSION_TEMPLATE = "";
let TERMS = [];
let GROUPING = "auto";
const OTHER_AREA = { label: "Other", color: "#94a3b8", icon: "folder", folder: "Other" };
let AREAS = { other: OTHER_AREA };
const userAreas = () => Object.keys(AREAS).filter(a => a !== "other");
const KINDS = {
  progress: { label: "Progress", icon: "trending-up", color: "#2dd4bf" },
  milestone: { label: "Milestone", icon: "flag", color: "#fbbf24" },
  blocker: { label: "Blocker", icon: "octagon-alert", color: "#f87171" },
  decision: { label: "Decision", icon: "git-branch", color: "#a78bfa" },
  note: { label: "Note", icon: "sticky-note", color: "#94a3b8" },
  meeting: { label: "Meeting", icon: "users", color: "#38bdf8" },
  done: { label: "Tasks done", icon: "check-check", color: "#4ade80" },
};
const STATUSES = {
  active: { label: "Active", rank: 0 },
  "needs-review": { label: "Needs review", rank: 1 },
  paused: { label: "Paused", rank: 2 },
  done: { label: "Done", rank: 3 },
  archived: { label: "Archived", rank: 4 },
};
const HEALTH = {
  blocked: { label: "Blocked", icon: "octagon-alert", rank: 0 },
  "at-risk": { label: "At risk", icon: "triangle-alert", rank: 1 },
  "on-track": { label: "On track", icon: "circle-check", rank: 2 },
};
const AUTHOR_COLORS = { me: "var(--interactive-accent)", claude: "#d97757", codex: "#60a5fa" };
const CLOSED = new Set(["done", "archived"]);
const MEETING_NAME = /^(\d{4}-\d{2}-\d{2}) - (.+)$/;
let SEMESTER_DIR = /^\d{4}-(Spring|Summer|Fall|Winter)$/;
const DONE_SINCE = "Done since last time";

const DEFAULT_TEMPLATE = [
  `##### ${DONE_SINCE}`, "```project-done", "```", "",
  "##### Still open", "```project-tasks", "```", "",
  "##### Finished", "1. ", "",
  "##### Discuss", "1. ", "",
  "##### TODO", "1. ", "",
].join("\n");

const DEFAULT_SETTINGS = {
  // view state
  author: "me", area: "all", focus: null, showClosed: false, feedAuthor: "all", sortMode: "smart", order: [], logMode: "quick",
  // vault layout
  userName: "",
  homeNote: "Home.md",
  projectsRoot: "Projects",
  archiveRoot: "Archive/Projects",
  ignoredFolders: "Templates",
  meetingsFolder: "Meetings",
  updatesFolder: "Updates",
  areas: [
    { id: "work", label: "Work", color: "#22d3ee", icon: "briefcase", folder: "Work" },
    { id: "personal", label: "Personal", color: "#f472b6", icon: "heart", folder: "Personal" },
    { id: "learning", label: "Learning", color: "#a78bfa", icon: "graduation-cap", folder: "Learning" },
  ],
  // timing
  staleDays: 14,
  dueSoonDays: 14,
  oldTaskDays: 60,
  // meetings
  meetingGrouping: "auto", // auto | month | term
  terms: "Spring 01-07, Summer 05-11, Fall 08-15, Winter 12-10",
  sessionTemplate: DEFAULT_TEMPLATE,
};

const trimSlashes = v => String(v || "").trim().replace(/^\/+|\/+$/g, "");
const escRe = v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Spring 01-07, Fall 08-15" -> [{ name, md }] sorted by start; md = month (0-based) * 100 + day.
function parseTerms(src) {
  return String(src || "").split(",").map(x => x.trim().match(/^([A-Za-z][\w ]*?)\s+(\d{1,2})-(\d{1,2})$/))
    .filter(Boolean).map(m => ({ name: m[1].trim(), md: (Number(m[2]) - 1) * 100 + Number(m[3]) }))
    .sort((a, b) => a.md - b.md);
}

function applyConfig(st) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  STALE_DAYS = num(st.staleDays, 14);
  DUE_SOON_DAYS = num(st.dueSoonDays, 14);
  OLD_TASK_DAYS = num(st.oldTaskDays, 60);
  PROJECTS_ROOT = trimSlashes(st.projectsRoot) || "Projects";
  ARCHIVE_ROOT = trimSlashes(st.archiveRoot) || "Archive/Projects";
  IGNORED = String(st.ignoredFolders || "").split(/[,\n]/).map(trimSlashes).filter(Boolean);
  MEETINGS_DIR = trimSlashes(st.meetingsFolder) || "Meetings";
  UPDATES_DIR = trimSlashes(st.updatesFolder) || "Updates";
  SESSION_TEMPLATE = st.sessionTemplate && st.sessionTemplate.trim() ? st.sessionTemplate : DEFAULT_TEMPLATE;
  GROUPING = ["auto", "month", "term"].includes(st.meetingGrouping) ? st.meetingGrouping : "auto";
  TERMS = parseTerms(st.terms);
  SEMESTER_DIR = TERMS.length ? new RegExp(`^\\d{4}-(${TERMS.map(t => escRe(t.name)).join("|")})$`) : /^$^/;
  AREAS = {};
  for (const a of st.areas || []) {
    const id = lc(a.id);
    if (!id || id === "other" || AREAS[id]) continue;
    AREAS[id] = { label: a.label || id, color: a.color || "#94a3b8", icon: a.icon || "folder", folder: trimSlashes(a.folder) || a.label || id };
  }
  AREAS.other = OTHER_AREA;
}

// path -> [{ text, doneOn: "YYYY-MM-DD", line }] for checked-off tasks carrying a "✅ date".
// Kept by the plugin from file contents, so collect() can stay synchronous.
const DONE_INDEX = new Map();

// ---------- small helpers ----------

const lc = v => (v == null ? "" : String(v)).trim().toLowerCase();

function el(parent, tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function icon(parent, name, cls) {
  const s = el(parent, "span", "hp-icon" + (cls ? " " + cls : ""));
  setIcon(s, name);
  return s;
}

function btn(parent, label, iconName, cls, onClick) {
  const b = el(parent, "button", "hp-btn" + (cls ? " " + cls : ""));
  if (iconName) icon(b, iconName);
  if (label) el(b, "span", null, label);
  b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); onClick(e); });
  return b;
}

function linkTarget(v) {
  if (Array.isArray(v)) v = v[0];
  if (v == null) return "";
  const m = String(v).match(/\[\[([^\]|#]+)/);
  return (m ? m[1] : String(v)).trim();
}

function normTags(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(t => lc(t).replace(/^#/, "")).filter(Boolean);
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    // YAML turns a bare "2026-11-20" into midnight UTC; keep it on that calendar day locally.
    const u = moment.utc(v);
    const dateOnly = u.hours() === 0 && u.minutes() === 0 && u.seconds() === 0;
    return dateOnly ? { m: moment(u.format("YYYY-MM-DD"), "YYYY-MM-DD"), hasTime: false } : { m: moment(v), hasTime: true };
  }
  const s = String(v).trim();
  const m = moment(s, [moment.ISO_8601, "YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
  return m.isValid() ? { m, hasTime: /\d[T ]\d{1,2}:\d{2}/.test(s) } : null;
}

function authorColor(a) {
  if (AUTHOR_COLORS[a]) return AUTHOR_COLORS[a];
  let h = 0;
  for (const c of a) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 62%)`;
}

function relTime(e) {
  const now = moment();
  if (e.date.isAfter(now.clone().endOf("day"))) return `in ${plural(e.date.clone().startOf("day").diff(now.clone().startOf("day"), "days"), "day")}`;
  if (!e.hasTime) {
    const d = now.clone().startOf("day").diff(e.date.clone().startOf("day"), "days");
    return d === 0 ? "today" : d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : e.date.format("MMM D");
  }
  return now.diff(e.date, "days") < 7 ? e.date.fromNow() : e.date.format("MMM D, HH:mm");
}

function dayLabel(m) {
  const d = moment().startOf("day").diff(m.clone().startOf("day"), "days");
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  return m.format(d < 7 ? "dddd" : m.year() === moment().year() ? "ddd, MMM D" : "ddd, MMM D YYYY");
}

function openFile(app, file, evt) {
  app.workspace.openLinkText(file.path, "", !!(evt && (evt.metaKey || evt.ctrlKey)));
}

async function renderMd(app, md, container, sourcePath, component) {
  if (MarkdownRenderer.render) await MarkdownRenderer.render(app, md, container, sourcePath, component);
  else await MarkdownRenderer.renderMarkdown(md, container, sourcePath, component);
}

// ---------- data ----------

function collect(app) {
  const files = app.vault.getMarkdownFiles()
    .filter(f => f.path.startsWith(ARCHIVE_ROOT + "/") || !IGNORED.some(d => f.path.startsWith(d + "/")));
  const fmOf = f => (app.metadataCache.getFileCache(f) || {}).frontmatter || {};
  const projects = [];
  const byPath = new Map();
  const byName = new Map();

  for (const f of files) {
    const fm = fmOf(f);
    const t = lc(fm.type);
    if (t !== "project" && t !== "program") continue;
    const due = parseDate(fm.due);
    const p = {
      file: f, name: f.basename, folder: f.parent && f.parent.path !== "/" ? f.parent.path : "",
      program: t === "program", status: STATUSES[lc(fm.status)] ? lc(fm.status) : "active",
      area: AREAS[lc(fm.area)] ? lc(fm.area) : "other", due: due ? due.m : null,
      created: (parseDate(fm.created) || parseDate(fm.start) || {}).m || null,
      healthSet: HEALTH[lc(fm.health)] ? lc(fm.health) : "", next: fm.next_action ? String(fm.next_action) : "",
      parent: linkTarget(fm.parent), tags: normTags(fm.tags), entries: [],
      start: (parseDate(fm.start) || {}).m || null, end: (parseDate(fm.end) || {}).m || null,
      archived: f.path.startsWith(ARCHIVE_ROOT + "/"), archivedFrom: fm.archived_from ? String(fm.archived_from) : "",
    };
    // A project sitting in the archive is closed whatever its status says.
    if (p.archived && !CLOSED.has(p.status)) p.status = "archived";
    // Archiving moves the folder, so it must belong to this project alone.
    p.dedicated = !!p.folder && p.folder.split("/").pop() === p.name;
    projects.push(p);
    byPath.set(f.path, p);
    byName.set(f.basename.toLowerCase(), p);
  }

  const resolve = (link, from) => {
    const t = linkTarget(link);
    if (!t) return null;
    const dest = app.metadataCache.getFirstLinkpathDest(t, from.path);
    return (dest && byPath.get(dest.path)) || byName.get(t.split("/").pop().toLowerCase()) || null;
  };

  const entries = [];
  const attach = e => {
    // A program's entries also count toward its sub-projects.
    const all = new Set(e.primary);
    for (const p of e.primary) {
      if (p.program) projects.filter(c => c.parent.toLowerCase() === p.name.toLowerCase()).forEach(c => all.add(c));
    }
    e.projects = [...all];
    entries.push(e);
    for (const p of all) p.entries.push(e);
  };
  for (const f of files) {
    const fm = fmOf(f);
    const t = lc(fm.type);
    let targets = [], d, kind, author;
    if (t === "update") {
      targets = [resolve(fm.project, f)];
      d = parseDate(fm.date);
      kind = KINDS[lc(fm.kind)] ? lc(fm.kind) : "progress";
      author = lc(fm.author) || "me";
    } else {
      const nm = f.basename.match(MEETING_NAME);
      if (t !== "meeting" && !nm) continue;
      d = parseDate(fm.date) || (nm && parseDate(nm[1]));
      author = lc(fm.author) || "me";
      const x = nm ? nm[2].toLowerCase() : "";
      const named = nm && (byName.get(x) || projects.find(p => p.name.toLowerCase().startsWith(x + " ")));
      // "YYYY-MM-DD - <Project>" is a meeting; other dated notes linked to a project are notes.
      kind = t === "meeting" || (named && t !== "project-note") ? "meeting" : "note";
      const streams = normTags(fm.streams);
      if (streams.length) targets = projects.filter(p => !p.program && streams.some(s => p.tags.includes(s)));
      if (!targets.length && fm.project) targets = [resolve(fm.project, f)];
      if (!targets.length && named) targets = [named];
      // A dated filename alone only counts when it names a project.
      if (t !== "meeting" && !targets.some(Boolean)) continue;
    }
    if (!d) continue;
    const primary = [...new Set(targets.filter(Boolean))];
    attach({ file: f, date: d.m, hasTime: d.hasTime, kind, author, primary, isUpdate: t === "update",
      summary: fm.summary ? String(fm.summary).trim() : "" });
  }

  // Checked-off tasks count as activity: one "done" entry per project per day.
  const ownerOf = new Map(entries.map(e => [e.file.path, e.primary]));
  const inScope = new Set(files.map(f => f.path));
  const homes = projects.filter(p => p.dedicated).sort((a, b) => b.folder.length - a.folder.length);
  const groups = new Map();
  for (const [path, tasks] of DONE_INDEX) {
    if (!inScope.has(path)) continue;
    const f = app.vault.getAbstractFileByPath(path);
    if (!f) continue;
    let primary = ownerOf.get(path);
    if (!primary) {
      const home = byPath.get(path) || homes.find(p => inFolder(f, p.folder));
      primary = home ? [home] : [];
    }
    if (!primary.length) continue;
    for (const t of tasks) {
      const key = `${t.doneOn}|${primary.map(p => p.file.path).join("|")}`;
      if (!groups.has(key)) {
        groups.set(key, { file: f, date: moment(t.doneOn, "YYYY-MM-DD"), hasTime: false, kind: "done", author: "me",
          primary, isUpdate: false, tasks: [] });
      }
      groups.get(key).tasks.push({ ...t, file: f });
    }
  }
  groups.forEach(attach);

  // A program's timeline also includes everything logged on its sub-projects.
  for (const p of projects.filter(x => x.program)) {
    const own = new Set(p.entries);
    for (const c of projects) {
      if (c.parent.toLowerCase() === p.name.toLowerCase()) c.entries.forEach(e => own.add(e));
    }
    p.entries = [...own];
  }

  const byDate = (a, b) => b.date.valueOf() - a.date.valueOf();
  entries.sort(byDate);
  const today = moment().startOf("day");
  for (const p of projects) {
    p.entries.sort(byDate);
    // Last activity ignores notes dated in the future (a session note made ahead of the meeting).
    const endOfToday = moment().endOf("day");
    p.last = p.entries.find(e => !e.date.isAfter(endOfToday)) || null;
    const open = !CLOSED.has(p.status);
    p.overdue = open && p.due && p.due.isBefore(today);
    p.dueSoon = open && p.due && !p.overdue && p.due.diff(today, "days") <= DUE_SOON_DAYS;
    // Quiet = no update for STALE_DAYS; a project with no updates yet counts from its creation.
    const since = p.last ? p.last.date : p.created || p.start || moment(p.file.stat && p.file.stat.ctime);
    p.stale = p.status === "active" && moment().diff(since, "days") >= STALE_DAYS;
    p.health = p.healthSet
      || (p.last && p.last.kind === "blocker" ? "blocked" : p.status === "active" && (p.overdue || p.stale) ? "at-risk" : "on-track");
  }
  projects.sort((a, b) =>
    STATUSES[a.status].rank - STATUSES[b.status].rank
    || HEALTH[a.health].rank - HEALTH[b.health].rank
    || (a.due ? a.due.valueOf() : Infinity) - (b.due ? b.due.valueOf() : Infinity)
    || (b.last ? b.last.date.valueOf() : 0) - (a.last ? a.last.date.valueOf() : 0)
    || a.name.localeCompare(b.name));
  return { projects, entries };
}

async function readBody(app, file) {
  const raw = await app.vault.cachedRead(file);
  return raw.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/, "").trim();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Headline, one-line preview and expandable detail for any entry. Done entries need no file read.
async function entryText(app, e) {
  if (e.kind === "done") {
    return {
      headline: `Checked off ${plural(e.tasks.length, "task")}`,
      preview: e.tasks.map(t => t.text).join(" · "),
      rest: e.tasks.map(t => `- ${t.text} · [[${t.file.path.replace(/\.md$/, "")}|${t.file.basename}]]`).join("\n"),
    };
  }
  const body = await readBody(app, e.file);
  // A session note's done list is live, so count it from the data rather than the text.
  const live = e.primary[0] && body.includes("```project-done") ? sessionContext(e.primary[0], e.date).done.length : 0;
  return summarize(e, body, live);
}

function summarize(entry, body, liveDone = 0) {
  const lines = body.split(/\r?\n/);
  if (entry.isUpdate) {
    const i = lines.findIndex(l => l.trim());
    return { headline: i < 0 ? "(empty update)" : lines[i].trim(), rest: lines.slice(i + 1).join("\n").trim() };
  }
  // Meetings and notes: what was finished since last time, new tasks, then the first few items.
  let section = "", done = liveDone, tasks = 0;
  const items = [];
  for (const l of lines) {
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) { section = lc(h[1]); continue; }
    const top = l.match(/^(\d+\.|[-*])\s+(\[.\]\s*)?(.*)$/);
    if (section === lc(DONE_SINCE)) { if (top && top[3].trim()) done++; continue; }
    if (TASK_LINE.test(l) && cleanTask(l.replace(TASK_LINE, "$4"))) tasks++;
    if (top) {
      const text = top[3].replace(/[=*_`]/g, "").trim();
      if (text) items.push(text);
    }
  }
  const counts = [done && `${done} done since last time`, tasks && plural(tasks, "task")].filter(Boolean);
  return { headline: entry.summary || entry.file.basename, preview: [...counts, ...items.slice(0, 3)].join(" · "), rest: body };
}

// ---------- project page data ----------

const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s?)(.*)$/;
const OPEN_TASK = new Set([" ", "/"]);

const inFolder = (file, folder) => !!folder && file.path.startsWith(folder + "/");

const DATED = /^(\d{4}-\d{2}-\d{2})\b/;

function projectScope(app, p) {
  const all = app.vault.getMarkdownFiles();
  // Everything in the project folder except update notes and the hub itself.
  const inside = all.filter(f => f !== p.file && inFolder(f, p.folder) && !f.path.includes(`/${UPDATES_DIR}/`));
  // Meetings: dated notes attributed to the project (wherever they live) plus dated notes in its folder.
  const meetings = new Map();
  for (const e of p.entries) {
    if (e.kind === "meeting" || e.kind === "note") meetings.set(e.file.path, { file: e.file, date: e.date, entry: e });
  }
  for (const f of inside) {
    const m = f.basename.match(DATED);
    if (m && !meetings.has(f.path)) meetings.set(f.path, { file: f, date: moment(m[1], "YYYY-MM-DD"), entry: null });
  }
  // Notes: the rest of the folder, i.e. reference material.
  const notes = inside.filter(f => !meetings.has(f.path));
  // Tasks: the hub, the project folder, and every update or meeting attributed to the project.
  const taskFiles = [...new Set([p.file, ...all.filter(f => inFolder(f, p.folder)), ...p.entries.map(e => e.file)])];
  return { notes, taskFiles, meetings: [...meetings.values()].sort((a, b) => b.date.valueOf() - a.date.valueOf()) };
}

function countTasks(app, files) {
  let open = 0, done = 0;
  for (const f of files) {
    for (const li of (app.metadataCache.getFileCache(f) || {}).listItems || []) {
      if (li.task === undefined) continue;
      if (OPEN_TASK.has(li.task)) open++;
      else done++;
    }
  }
  return { open, done };
}

function cleanTask(t) {
  return t
    .replace(/[📅⏳🛫✅➕❌]️?\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁️?[^📅⏳🛫✅➕❌]*/gu, "")
    .replace(/[🔺⏫🔼🔽⏬]️?/gu, "")
    .trim();
}

async function loadTasks(app, files) {
  const out = [];
  for (const f of files) {
    const items = ((app.metadataCache.getFileCache(f) || {}).listItems || []).filter(li => li.task !== undefined);
    if (!items.length) continue;
    const lines = (await app.vault.cachedRead(f)).split("\n");
    for (const li of items) {
      const raw = (lines[li.position.start.line] || "").replace(/\r$/, "");
      const m = raw.match(TASK_LINE);
      if (!m) continue;
      const due = (m[4].match(/📅️?\s*(\d{4}-\d{2}-\d{2})/u) || [])[1];
      const doneOn = (m[4].match(/✅️?\s*(\d{4}-\d{2}-\d{2})/u) || [])[1];
      if (!cleanTask(m[4])) continue;
      out.push({
        file: f, line: li.position.start.line, raw, open: OPEN_TASK.has(m[2]),
        text: cleanTask(m[4]), due: due ? moment(due) : null, doneOn: doneOn ? moment(doneOn) : null,
      });
    }
  }
  return out;
}

// Toggle a task line in place, matching the Tasks plugin's "✅ YYYY-MM-DD" done date.
async function toggleTask(app, task) {
  let ok = false;
  await app.vault.process(task.file, data => {
    const lines = data.split("\n");
    const cur = lines[task.line];
    if (cur === undefined || cur.replace(/\r$/, "") !== task.raw) return data;
    const cr = cur.endsWith("\r") ? "\r" : "";
    lines[task.line] = task.raw.replace(TASK_LINE, (_, a, s, b, rest) => task.open
      ? `${a}x${b}${rest.trimEnd()} ✅ ${moment().format("YYYY-MM-DD")}`
      : `${a} ${b}${rest.replace(/\s*✅️?\s*\d{4}-\d{2}-\d{2}/u, "")}`) + cr;
    ok = true;
    return lines.join("\n");
  });
  if (!ok) new Notice("That task changed since the panel loaded; refreshed.");
}

const BAD_NAME = /[\\/:*?"<>|#^[\]]/;

// A plain note with a date in its name: "YYYY-MM-DD - Title". Shows in the feed and the Meetings tab as a note.
async function createDatedNote(app, p, { date, title, folder }) {
  if (BAD_NAME.test(title)) throw new Error("the title can't contain \\ / : * ? \" < > | # ^ [ ]");
  const path = normalizePath(`${folder}/${date.format("YYYY-MM-DD")} - ${title}.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) return { file: existing, existed: true };
  await ensureFolder(app, folder);
  const content = ["---", "type: project-note", `project: "[[${p.name}]]"`, `area: ${p.area}`,
    `date: ${date.format("YYYY-MM-DD")}`, "summary: ", "---", "", ""].join("\n");
  return { file: await app.vault.create(path, content), existed: false };
}

async function createNote(app, p, name) {
  if (BAD_NAME.test(name)) throw new Error("the name can't contain \\ / : * ? \" < > | # ^ [ ]");
  const path = normalizePath(`${p.folder}/${name}.md`);
  if (app.vault.getAbstractFileByPath(path)) throw new Error(`"${name}" already exists`);
  return app.vault.create(path, ["---", "type: project-note", `project: "[[${p.name}]]"`, `area: ${p.area}`,
    `created: ${moment().format("YYYY-MM-DD")}`, "---", "", `# ${name}`, "", ""].join("\n"));
}

// ---------- session notes ----------

// Term folders such as "2026-Fall": the latest term starting on or before the date.
// Dates before the year's first term belong to the previous year's last term (e.g. a December Winter).
function semesterOf(m) {
  if (!TERMS.length) return m.format("YYYY-MM");
  const md = m.month() * 100 + m.date();
  const cur = [...TERMS].reverse().find(t => t.md <= md);
  return cur ? `${m.year()}-${cur.name}` : `${m.year() - 1}-${TERMS[TERMS.length - 1].name}`;
}

// The nearest meetings folder at or above the project (stopping at the area folder),
// plus the term subfolder when that folder is organised by term (or grouping is set to "term").
function sessionFolder(app, p, date) {
  const stop = PROJECTS_ROOT.split("/").length + 1;
  let dir = p.folder;
  let meetings = null;
  while (dir && dir.split("/").length > stop) {
    if (app.vault.getAbstractFileByPath(`${dir}/${MEETINGS_DIR}`)) { meetings = `${dir}/${MEETINGS_DIR}`; break; }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  meetings = meetings || normalizePath(`${p.folder || PROJECTS_ROOT}/${MEETINGS_DIR}`);
  if (GROUPING === "month") return meetings;
  const f = app.vault.getAbstractFileByPath(meetings);
  const byTerm = GROUPING === "term" || (f && (f.children || []).some(c => c.children && SEMESTER_DIR.test(c.name)));
  return byTerm && TERMS.length ? `${meetings}/${semesterOf(date)}` : meetings;
}

// A session's window: the previous session, and tasks checked off from that day through this one.
// Done dates don't change, so once the session day has passed the list is effectively fixed.
function sessionContext(p, date) {
  const day = date.clone().startOf("day");
  const prev = p.entries.find(e => e.kind === "meeting" && e.date.isBefore(day));
  const since = prev ? prev.date.clone().startOf("day") : day.clone().subtract(STALE_DAYS, "days");
  const done = p.entries.filter(e => e.kind === "done" && !e.date.isBefore(since) && !e.date.isAfter(day))
    .flatMap(e => e.tasks).sort((a, b) => a.doneOn.localeCompare(b.doneOn));
  return { prev, since, done };
}

async function createSession(app, p, { date, folder }) {
  const name = `${date.format("YYYY-MM-DD")} - ${p.name}`;
  const path = normalizePath(`${folder}/${name}.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) return { file: existing, existed: true };
  const semester = folder.split("/").pop();
  const fm = ["---", "type: meeting", `project: "[[${p.name}]]"`, `area: ${p.area}`, `date: ${date.format("YYYY-MM-DD")}`];
  if (SEMESTER_DIR.test(semester)) fm.push(`semester: ${semester.toLowerCase()}`);
  fm.push("summary: ", "---");
  const body = ["", SESSION_TEMPLATE.replace(/\{\{date\}\}/g, date.format("YYYY-MM-DD")).replace(/\{\{project\}\}/g, p.name), ""];
  await ensureFolder(app, folder);
  return { file: await app.vault.create(path, fm.concat(body).join("\n")), existed: false };
}

// Checked-off tasks with a done date, read straight from file text.
function scanDone(text) {
  const out = [];
  text.split("\n").forEach((raw, line) => {
    const m = raw.replace(/\r$/, "").match(TASK_LINE);
    if (!m || OPEN_TASK.has(m[2])) return;
    const d = (m[4].match(/✅️?\s*(\d{4}-\d{2}-\d{2})/u) || [])[1];
    const text = cleanTask(m[4]);
    if (d && text) out.push({ text, doneOn: d, line });
  });
  return out;
}

// ---------- writes ----------

async function ensureFolder(app, path) {
  let cur = "";
  for (const part of path.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}

async function createUpdate(app, project, { kind, author, message }) {
  const dir = normalizePath(project.folder ? `${project.folder}/${UPDATES_DIR}` : UPDATES_DIR);
  await ensureFolder(app, dir);
  const now = moment();
  const base = `${dir}/${now.format("YYYY-MM-DD HHmm")} - ${author}`;
  let path = `${base}.md`;
  for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
  const content = ["---", "type: update", `project: "[[${project.name}]]"`, `date: ${now.format("YYYY-MM-DDTHH:mm")}`,
    `author: ${author}`, `kind: ${kind}`, "---", message.trim(), ""].join("\n");
  return app.vault.create(path, content);
}

async function setFields(app, file, fields) {
  await app.fileManager.processFrontMatter(file, fm => {
    for (const [k, v] of Object.entries(fields)) {
      if (v === "" || v == null) delete fm[k];
      else fm[k] = v;
    }
  });
}

async function createProject(app, { name, area, due, next, parent }) {
  const base = parent && parent.folder ? parent.folder : `${PROJECTS_ROOT}/${(AREAS[area] || OTHER_AREA).folder}`;
  const folder = normalizePath(`${base}/${name}`);
  if (app.vault.getAbstractFileByPath(folder)) throw new Error(`"${folder}" already exists`);
  await ensureFolder(app, folder);
  const fm = ["---", "type: project", "status: active", `area: ${area}`, `created: ${moment().format("YYYY-MM-DD")}`];
  if (due) fm.push(`due: ${due}`);
  fm.push("health: on-track");
  if (next) fm.push(`next_action: ${JSON.stringify(next)}`);
  if (parent) fm.push(`parent: "[[${parent.name}]]"`);
  fm.push("tags:", "  - project", "---");
  const body = [
    "", `# ${name}`, "", "```project-panel", "```", "", "## Outcome", "", "> [!goal] Definition of done",
    "> Describe the concrete result that will make this project complete.", "",
    "## Notes", "", "", "## Decisions", "", "",
  ];
  return app.vault.create(`${folder}/${name}.md`, fm.concat(body).join("\n"));
}

// ---------- archive ----------

function archiveTarget(app, p) {
  const base = `${ARCHIVE_ROOT}/${(AREAS[p.area] || OTHER_AREA).folder}/${p.name}`;
  let path = normalizePath(base);
  for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${base} ${n}`);
  return path;
}

const subProjectsInside = (projects, p) => projects.filter(c => c.file.path !== p.file.path && inFolder(c.file, p.folder));

async function archiveProject(app, p, children, { outcome, start, end, note }) {
  const folder = p.dedicated && app.vault.getAbstractFileByPath(p.folder);
  if (!folder) throw new Error(`"${p.name}" has no folder of its own; move it by hand`);
  const status = outcome === "completed" ? "done" : "archived";
  if (note.trim()) {
    await createUpdate(app, p, { kind: outcome === "completed" ? "milestone" : "note", author: "me", message: note });
  }
  for (const c of children) {
    const f = { health: "" };
    if (!CLOSED.has(c.status)) f.status = status;
    if (!c.end) f.end = end;
    await setFields(app, c.file, f);
  }
  await setFields(app, p.file, { status, start, end, archived_from: p.folder, health: "" });
  const dest = archiveTarget(app, p);
  await ensureFolder(app, dest.slice(0, dest.lastIndexOf("/")));
  await app.fileManager.renameFile(folder, dest);
  return dest;
}

async function restoreProject(app, p, children = []) {
  const folder = p.dedicated && app.vault.getAbstractFileByPath(p.folder);
  if (!folder) throw new Error(`"${p.name}" has no folder of its own; move it by hand`);
  const from = p.archivedFrom;
  const fromParent = from.slice(0, from.lastIndexOf("/"));
  // Go back where it came from if that spot is free and its parent folder still exists.
  const dest = from && !app.vault.getAbstractFileByPath(from) && app.vault.getAbstractFileByPath(fromParent)
    ? from : normalizePath(`${PROJECTS_ROOT}/${(AREAS[p.area] || OTHER_AREA).folder}/${p.name}`);
  if (app.vault.getAbstractFileByPath(dest)) throw new Error(`"${dest}" already exists`);
  await ensureFolder(app, dest.slice(0, dest.lastIndexOf("/")));
  // Reopen sub-projects that were closed by the same archive (same end date); leave earlier ones done.
  const end = p.end ? p.end.format("YYYY-MM-DD") : null;
  for (const c of children) {
    if (end && c.end && c.end.format("YYYY-MM-DD") === end) await setFields(app, c.file, { status: "active", end: "" });
  }
  await setFields(app, p.file, { status: "active", end: "", archived_from: "" });
  await app.fileManager.renameFile(folder, dest);
  return dest;
}

// ---------- modals ----------

function stacked(setting) {
  setting.settingEl.addClass("hp-setting-stacked");
  return setting;
}

// One "Log" button, two modes: a quick one-line update, or a dated session note
// (meeting or work session) that carries in what was checked off since last time.
class UpdateModal extends Modal {
  constructor(plugin, project, mode) {
    super(plugin.app);
    this.plugin = plugin;
    this.preset = project;
    this.mode = mode || plugin.settings.logMode || "quick";
  }

  onOpen() {
    this.modalEl.addClass("hp-modal");
    this.choices = collect(this.app).projects.filter(p => !CLOSED.has(p.status) || p === this.preset)
      .sort((a, b) => a.name.localeCompare(b.name));
    const preset = this.preset && this.choices.find(p => p.file.path === this.preset.file.path);
    this.state = {
      project: preset || this.choices[0], kind: "progress", author: this.plugin.settings.author || "me",
      message: "", next: "", health: "", date: moment().format("YYYY-MM-DD"), folder: "",
    };
    this.scope.register(["Mod"], "Enter", () => { this.submit(); return false; });
    this.draw();
  }

  draw() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText({ session: "New session note", note: "New dated note" }[this.mode] || "Log update");
    if (!this.choices.length) {
      contentEl.createEl("p", { text: "No projects yet. Create one first." });
      return;
    }
    const seg = el(contentEl, "div", "hp-seg hp-modal-seg");
    for (const [k, label, ic] of [
      ["quick", "Quick update", "message-square-plus"], ["session", "Session note", "notebook-pen"], ["note", "Dated note", "file-plus"],
    ]) {
      const b = el(seg, "button", "hp-seg-btn hp-seg-icon" + (this.mode === k ? " is-active" : ""));
      icon(b, ic);
      el(b, "span", null, label);
      b.addEventListener("click", () => {
        if (this.mode === k) return;
        this.mode = k;
        this.plugin.settings.logMode = k;
        this.plugin.saveSettings();
        this.draw();
      });
    }
    const s = this.state;
    new Setting(contentEl).setName("Project").addDropdown(d => {
      this.choices.forEach(p => d.addOption(p.file.path, p.program ? `${p.name} (program)` : p.name));
      d.setValue(s.project.file.path).onChange(v => {
        s.project = this.choices.find(p => p.file.path === v);
        if (this.mode !== "quick") this.draw();
      });
    });
    if (this.mode === "session") this.drawSession(contentEl);
    else if (this.mode === "note") this.drawNote(contentEl);
    else this.drawQuick(contentEl);
  }

  drawSession(contentEl) {
    const s = this.state;
    const date = moment(s.date, "YYYY-MM-DD");
    if (!s.folderEdited) s.folder = sessionFolder(this.app, s.project, date);
    new Setting(contentEl).setName("Date").addText(t => {
      t.inputEl.type = "date";
      t.setValue(s.date).onChange(v => {
        if (!moment(v, "YYYY-MM-DD", true).isValid()) return;
        s.date = v;
        this.draw();
      });
    });
    new Setting(contentEl).setName("Folder").setDesc("Next to the project's other meetings.")
      .addText(t => {
        t.inputEl.addClass("hp-wide-input");
        t.setValue(s.folder).onChange(v => { s.folder = v.trim().replace(/\/+$/, ""); s.folderEdited = true; });
      });
    const ctx = sessionContext(s.project, date);
    const info = el(contentEl, "div", "hp-session-info");
    const name = `${date.format("YYYY-MM-DD")} - ${s.project.name}`;
    const exists = this.app.vault.getAbstractFileByPath(normalizePath(`${s.folder}/${name}.md`));
    const line = (ic, text) => { const r = el(info, "div", "hp-session-line"); icon(r, ic); el(r, "span", null, text); };
    line("file-text", exists ? `${name} already exists; it will open.` : `${name}.md`);
    line("history", ctx.prev ? `Last session: ${ctx.prev.file.basename}` : `No earlier session; looking back to ${ctx.since.format("MMM D")}`);
    line("check-check", ctx.done.length
      ? `“${DONE_SINCE}” lists what you check off until the session day (${plural(ctx.done.length, "task")} so far)`
      : `“${DONE_SINCE}” lists what you check off until the session day`);
    line("list-todo", "Open tasks appear live under “Still open”; write new ones as 1. [ ] under TODO");
    new Setting(contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText(exists ? "Open note" : "Create note").setCta().onClick(() => this.submit()));
  }

  drawNote(contentEl) {
    const s = this.state;
    if (s.noteProject !== s.project) {
      s.noteProject = s.project;
      s.noteFolder = s.project.folder;
    }
    new Setting(contentEl).setName("Date").addText(t => {
      t.inputEl.type = "date";
      t.setValue(s.date).onChange(v => {
        if (!moment(v, "YYYY-MM-DD", true).isValid()) return;
        s.date = v;
        this.draw();
      });
    });
    const name = el(null, "span");
    const showName = () => {
      const title = (s.title || "").trim();
      name.textContent = title ? `${s.date} - ${title}.md` : `${s.date} - <title>.md`;
    };
    new Setting(contentEl).setName("Title").setDesc("e.g. Configuration Audit, Literature notes, Weekly report")
      .addText(t => {
        t.inputEl.addClass("hp-wide-input");
        t.setValue(s.title || "").onChange(v => { s.title = v; showName(); });
        setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(contentEl).setName("Folder").setDesc("The project's folder by default.")
      .addText(t => {
        t.inputEl.addClass("hp-wide-input");
        t.setValue(s.noteFolder).onChange(v => { s.noteFolder = v.trim().replace(/\/+$/, ""); });
      });
    const info = el(contentEl, "div", "hp-session-info");
    const r = el(info, "div", "hp-session-line");
    icon(r, "file-text");
    r.appendChild(name);
    showName();
    const r2 = el(info, "div", "hp-session-line");
    icon(r2, "users");
    el(r2, "span", null, "Appears in the project's Activity feed and Meetings tab, dated by its name.");
    new Setting(contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText("Create note").setCta().onClick(() => this.submit()));
  }

  drawQuick(contentEl) {
    const s = this.state;
    new Setting(contentEl).setName("Kind").addDropdown(d => {
      Object.entries(KINDS).filter(([k]) => k !== "meeting" && k !== "done").forEach(([k, v]) => d.addOption(k, v.label));
      d.setValue(s.kind).onChange(v => { s.kind = v; });
    });
    new Setting(contentEl).setName("Author").addDropdown(d => {
      const opts = new Set(["me", "claude", "codex", s.author]);
      opts.forEach(a => d.addOption(a, a));
      d.setValue(s.author).onChange(v => { s.author = v; });
    });
    stacked(new Setting(contentEl).setName("Message").setDesc("The first line is the headline on the panel. Markdown and - [ ] tasks work."))
      .addTextArea(t => {
        t.inputEl.rows = 6;
        t.inputEl.addClass("hp-textarea");
        t.setPlaceholder("What changed?").onChange(v => { s.message = v; });
        setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(contentEl).setName("Next action").setDesc("Optional. Replaces the project's next action.")
      .addText(t => t.setPlaceholder(s.project.next || "unchanged").onChange(v => { s.next = v; }));
    new Setting(contentEl).setName("Health").addDropdown(d => {
      d.addOption("", "Unchanged");
      Object.entries(HEALTH).forEach(([k, v]) => d.addOption(k, v.label));
      d.onChange(v => { s.health = v; });
    });
    new Setting(contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText("Save update").setCta().onClick(() => this.submit()));
  }

  async submit() {
    const s = this.state;
    if (!s || !s.project || this.busy) return;
    if (this.mode === "session") return this.submitSession();
    if (this.mode === "note") return this.submitNote();
    if (!s.message.trim()) { new Notice("Write a message first."); return; }
    this.busy = true;
    try {
      await createUpdate(this.app, s.project, s);
      const fields = {};
      if (s.next.trim()) fields.next_action = s.next.trim();
      if (s.health) fields.health = s.health;
      if (Object.keys(fields).length) await setFields(this.app, s.project.file, fields);
      if (s.author !== this.plugin.settings.author) { this.plugin.settings.author = s.author; this.plugin.saveSettings(); }
      new Notice(`Update logged for ${s.project.name}`);
      this.close();
    } catch (err) {
      console.error(err);
      new Notice(`Could not save update: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  async submitSession() {
    const s = this.state;
    if (!s.folder) { new Notice("Choose a folder first."); return; }
    this.busy = true;
    try {
      const { file, existed } = await createSession(this.app, s.project, { date: moment(s.date, "YYYY-MM-DD"), folder: s.folder });
      if (existed) new Notice(`${file.basename} already exists; opened it.`);
      this.close();
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (err) {
      console.error(err);
      new Notice(`Could not create note: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  async submitNote() {
    const s = this.state;
    const title = (s.title || "").trim();
    if (!title) { new Notice("Give the note a title."); return; }
    if (!s.noteFolder) { new Notice("Choose a folder first."); return; }
    this.busy = true;
    try {
      const { file, existed } = await createDatedNote(this.app, s.project,
        { date: moment(s.date, "YYYY-MM-DD"), title, folder: s.noteFolder });
      if (existed) new Notice(`${file.basename} already exists; opened it.`);
      this.close();
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (err) {
      console.error(err);
      new Notice(`Could not create note: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  onClose() { this.contentEl.empty(); }
}

class ProjectModal extends Modal {
  constructor(plugin, parent = null, area = null) {
    super(plugin.app);
    this.plugin = plugin;
    this.parent = parent;
    this.area = AREAS[area] && area !== "other" ? area : null;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("hp-modal");
    const parent = this.parent;
    this.titleEl.setText(parent ? `New sub-project of ${parent.name}` : "New project");
    const s = this.state = { name: "", area: parent && parent.area !== "other" ? parent.area : this.area || userAreas()[0] || "other", due: "", next: "", parent };
    new Setting(contentEl).setName("Name")
      .setDesc(parent ? `Created in ${parent.folder}/ and linked to ${parent.name}.` : "Also used as the folder and hub note name.")
      .addText(t => { t.onChange(v => { s.name = v; }); setTimeout(() => t.inputEl.focus(), 0); });
    new Setting(contentEl).setName("Area").addDropdown(d => {
      (userAreas().length ? userAreas() : ["other"]).forEach(a => d.addOption(a, AREAS[a].label));
      d.setValue(s.area).onChange(v => { s.area = v; });
    });
    new Setting(contentEl).setName("Due date").setDesc("Optional.").addText(t => {
      t.inputEl.type = "date";
      t.onChange(v => { s.due = v; });
    });
    new Setting(contentEl).setName("Next action").setDesc("Optional.").addText(t => t.onChange(v => { s.next = v; }));
    new Setting(contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText("Create project").setCta().onClick(() => this.submit()));
    this.scope.register(["Mod"], "Enter", () => { this.submit(); return false; });
  }

  async submit() {
    const s = this.state;
    const name = s.name.trim();
    if (!name) { new Notice("Give the project a name."); return; }
    if (/[\\/:*?"<>|#^[\]]/.test(name)) { new Notice("The name can't contain \\ / : * ? \" < > | # ^ [ ]"); return; }
    try {
      const file = await createProject(this.app, { ...s, name, next: s.next.trim() });
      new Notice(`Created ${name}`);
      this.close();
      this.app.workspace.getLeaf(true).openFile(file);
    } catch (err) {
      console.error(err);
      new Notice(`Could not create project: ${err.message}`);
    }
  }

  onClose() { this.contentEl.empty(); }
}

class ArchiveModal extends Modal {
  constructor(plugin, project) {
    super(plugin.app);
    this.plugin = plugin;
    this.p = project;
  }

  onOpen() {
    const { contentEl } = this;
    const data = collect(this.app);
    const p = this.p = data.projects.find(x => x.file.path === this.p.file.path) || this.p;
    this.modalEl.addClass("hp-modal");
    this.titleEl.setText(`Archive ${p.name}`);
    if (!p.dedicated) {
      contentEl.createEl("p", { text: `${p.name} doesn't have a folder of its own, so it can't be moved automatically.` });
      return;
    }
    this.children = subProjectsInside(data.projects, p);
    const earliest = p.entries.length ? p.entries[p.entries.length - 1].date : null;
    const start = p.start || p.created || earliest;
    const s = this.state = {
      outcome: "completed", start: start ? start.format("YYYY-MM-DD") : "", end: moment().format("YYYY-MM-DD"), note: "",
    };
    const info = contentEl.createDiv({ cls: "hp-modal-info" });
    info.createSpan({ text: "Moves " });
    info.createEl("code", { text: `${p.folder}/` });
    info.createSpan({ text: " to " });
    info.createEl("code", { text: `${archiveTarget(this.app, p)}/` });
    info.createSpan({ text: ". Links to it keep working, and you can restore it any time." });
    if (this.children.length) {
      info.createEl("div", { text: `Sub-projects that move with it: ${this.children.map(c => c.name).join(", ")}.` });
    }
    new Setting(contentEl).setName("Outcome").addDropdown(d => {
      d.addOption("completed", "Completed (status: done)");
      d.addOption("stopped", "Stopped or dropped (status: archived)");
      d.setValue(s.outcome).onChange(v => { s.outcome = v; });
    });
    new Setting(contentEl).setName("Start date").setDesc(start ? "Pre-filled from the project's start, creation date or first update." : "")
      .addText(t => { t.inputEl.type = "date"; t.setValue(s.start).onChange(v => { s.start = v; }); });
    new Setting(contentEl).setName("End date").addText(t => {
      t.inputEl.type = "date";
      t.setValue(s.end).onChange(v => { s.end = v; });
    });
    stacked(new Setting(contentEl).setName("Closing note").setDesc("Optional. Logged as the project's final update."))
      .addTextArea(t => {
        t.inputEl.rows = 4;
        t.inputEl.addClass("hp-textarea");
        t.setPlaceholder("e.g. Paper accepted at ACL 2026; code released.").onChange(v => { s.note = v; });
      });
    new Setting(contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText("Archive project").setCta().onClick(() => this.submit()));
  }

  async submit() {
    const s = this.state;
    if (!s || this.busy) return;
    if (!s.end) { new Notice("Set an end date."); return; }
    if (s.start && s.end < s.start) { new Notice("The end date is before the start date."); return; }
    this.busy = true;
    try {
      const dest = await archiveProject(this.app, this.p, this.children, s);
      new Notice(`Archived ${this.p.name} to ${dest}`);
      this.close();
    } catch (err) {
      console.error(err);
      new Notice(`Could not archive: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  onClose() { this.contentEl.empty(); }
}

class TextModal extends Modal {
  constructor(app, title, value, onSubmit, inputType = "text", allowClear = true) {
    super(app);
    this.title = title;
    this.value = value || "";
    this.onSubmit = onSubmit;
    this.inputType = inputType;
    this.allowClear = allowClear;
  }

  onOpen() {
    this.modalEl.addClass("hp-modal");
    this.titleEl.setText(this.title);
    const done = () => { this.close(); this.onSubmit(this.value.trim()); };
    new Setting(this.contentEl).addText(t => {
      t.inputEl.addClass("hp-wide-input");
      t.inputEl.type = this.inputType;
      t.setValue(this.value).onChange(v => { this.value = v; });
      t.inputEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); done(); } });
      setTimeout(() => t.inputEl.select(), 0);
    });
    const row = new Setting(this.contentEl);
    if (this.allowClear) row.addButton(b => b.setButtonText("Clear").onClick(() => { this.value = ""; done(); }));
    row.addButton(b => b.setButtonText("Save").setCta().onClick(done));
  }

  onClose() { this.contentEl.empty(); }
}

// ---------- views ----------

class PanelView extends MarkdownRenderChild {
  constructor(plugin, containerEl, mode, opts, sourcePath) {
    super(containerEl);
    this.plugin = plugin;
    this.app = plugin.app;
    this.mode = mode;
    this.opts = opts;
    this.sourcePath = sourcePath;
    this.feedLimit = parseInt(opts.feed, 10) || (mode === "home" ? 25 : 10);
    this.expanded = new Set();
  }

  onload() {
    this.plugin.views.add(this);
    this.render();
  }

  onunload() { this.plugin.views.delete(this); }

  render() {
    if (this.inner) this.removeChild(this.inner);
    this.inner = this.addChild(new Component());
    this.containerEl.replaceChildren();
    const data = this.data = collect(this.app);
    try {
      if (this.mode === "home") this.renderHome(data);
      else if (this.mode === "page") this.renderProjectPage(data);
      else if (this.mode === "tasks") this.renderCarriedTasks(data);
      else if (this.mode === "done") this.renderDoneSince(data);
      else this.renderProjectTimeline(data);
    } catch (err) {
      console.error(err);
      el(this.containerEl, "div", "hp-error", `Home Project Manager error: ${err.message}`);
    }
  }

  get st() { return this.plugin.settings; }

  update(patch) {
    Object.assign(this.st, patch);
    this.plugin.saveSettings();
    this.plugin.refreshAll();
  }

  // ----- home -----

  renderHome(data) {
    const root = el(this.containerEl, "div", "hp-root");
    const open = data.projects.filter(p => !p.program && !CLOSED.has(p.status));
    const weekAgo = moment().subtract(7, "days");

    // Hero
    const hero = el(root, "div", "hp-hero");
    const hi = el(hero, "div", "hp-hero-text");
    const h = moment().hour();
    const greet = h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    el(hi, "div", "hp-greeting", (this.opts.name || this.st.userName) ? `${greet}, ${this.opts.name || this.st.userName}` : greet);
    el(hi, "div", "hp-date", `${moment().format("dddd, MMMM D")} · Week ${moment().isoWeek()}`);
    const actions = el(hero, "div", "hp-hero-actions");
    btn(actions, "Log", "message-square-plus", "hp-btn-primary", () => new UpdateModal(this.plugin).open())
      .setAttribute("aria-label", "Quick update or session note");
    btn(actions, "New project", "folder-plus", null, () => new ProjectModal(this.plugin).open());
    btn(actions, null, "refresh-cw", "hp-btn-icon", () => this.plugin.refreshAll()).setAttribute("aria-label", "Refresh");

    // Stats
    const stats = el(root, "div", "hp-stats");
    const stat = (key, n, label, ic, color) => {
      const c = el(stats, "div", "hp-stat" + (this.st.focus === key ? " is-active" : "") + (key ? " is-clickable" : ""));
      c.style.setProperty("--hp-accent", color);
      const top = el(c, "div", "hp-stat-top");
      icon(top, ic);
      el(top, "span", "hp-stat-n", String(n));
      el(c, "div", "hp-stat-label", label);
      if (key) c.addEventListener("click", () => this.update({ focus: this.st.focus === key ? null : key }));
    };
    stat(null, open.filter(p => p.status === "active").length, "Active projects", "rocket", "var(--interactive-accent)");
    stat(null, data.entries.filter(e => e.date.isAfter(weekAgo)).length, "Activity this week", "activity", "#2dd4bf");
    stat("blocked", open.filter(p => p.health === "blocked").length, "Blocked", "octagon-alert", "#f87171");
    stat("stale", open.filter(p => p.stale).length, `Quiet ${STALE_DAYS}+ days`, "hourglass", "#fbbf24");
    stat("due", open.filter(p => p.overdue || p.dueSoon).length, "Due soon / overdue", "calendar-clock", "#f472b6");
    stat("review", open.filter(p => p.status === "needs-review").length, "Needs review", "list-checks", "#38bdf8");

    const main = el(root, "div", "hp-main");
    this.renderProjects(el(main, "section", "hp-col hp-col-projects"), data);
    this.renderFeed(el(main, "section", "hp-col hp-col-feed"), data.entries);
  }

  renderProjects(sec, data) {
    const head = el(sec, "div", "hp-section-head");
    el(head, "h3", "hp-section-title", "Projects");
    const seg = el(head, "div", "hp-seg");
    const areas = ["all", ...Object.keys(AREAS).filter(a => data.projects.some(p => !p.program && p.area === a))];
    if (!areas.includes(this.st.area)) this.st.area = "all";
    for (const a of areas) {
      const b = el(seg, "button", "hp-seg-btn" + (this.st.area === a ? " is-active" : ""), a === "all" ? "All" : AREAS[a].label);
      if (a !== "all") b.style.setProperty("--hp-accent", AREAS[a].color);
      b.addEventListener("click", () => this.update({ area: a }));
    }
    const sort = el(head, "div", "hp-seg");
    for (const [k, label, ic, tip] of [
      ["smart", "Smart", "sparkles", "Automatic: blocked and at-risk first, then by due date"],
      ["custom", "Custom", "grip", "Your order: drag cards, or right-click a card"],
    ]) {
      const b = el(sort, "button", "hp-seg-btn hp-seg-icon" + (this.st.sortMode === k ? " is-active" : ""));
      icon(b, ic);
      el(b, "span", null, label);
      b.setAttribute("aria-label", tip);
      b.addEventListener("click", () => this.update({ sortMode: k }));
    }
    const toggle = el(head, "label", "hp-toggle");
    const cb = el(toggle, "input");
    cb.type = "checkbox";
    cb.checked = !!this.st.showClosed;
    cb.addEventListener("change", () => this.update({ showClosed: cb.checked }));
    el(toggle, "span", null, "Show done & archived");
    btn(head, "New project", "plus", "hp-btn-new", () => new ProjectModal(this.plugin, null, this.st.area).open())
      .setAttribute("aria-label", this.st.area === "all" ? "Create a project" : `Create a ${AREAS[this.st.area].label.toLowerCase()} project`);

    const focus = {
      blocked: p => p.health === "blocked",
      stale: p => p.stale,
      due: p => p.overdue || p.dueSoon,
      review: p => p.status === "needs-review",
    }[this.st.focus];
    const list = this.ordered(data.projects).filter(p => !p.program
      && (this.st.showClosed || !CLOSED.has(p.status))
      && (this.st.area === "all" || p.area === this.st.area)
      && (!focus || focus(p)));

    if (this.st.focus) {
      const bar = el(sec, "div", "hp-focus-bar");
      el(bar, "span", null, `Filtered: ${{ blocked: "blocked", stale: "quiet projects", due: "due soon or overdue", review: "needs review" }[this.st.focus]}`);
      btn(bar, "Clear", "x", "hp-btn-ghost", () => this.update({ focus: null }));
    }
    const grid = el(sec, "div", "hp-grid");
    if (!list.length) el(grid, "div", "hp-empty", "Nothing here. 🎉");
    this.visible = list.map(p => p.name);
    for (const p of list) this.renderCard(grid, p, true);
  }

  renderCard(grid, p, sortable = false) {
    const area = AREAS[p.area];
    const card = el(grid, "div", `hp-card is-${p.health} status-${p.status}`);
    card.style.setProperty("--hp-accent", area.color);
    card.addEventListener("click", e => openFile(this.app, p.file, e));
    if (sortable) this.makeSortable(card, p);

    const top = el(card, "div", "hp-card-top");
    const badge = el(top, "span", "hp-area-icon");
    setIcon(badge, area.icon);
    badge.setAttribute("aria-label", area.label);
    el(top, "span", "hp-card-title", p.name);
    if (sortable) icon(top, "grip-vertical", "hp-grip").setAttribute("aria-label", "Drag to reorder");
    this.statusPill(top, p);

    const meta = el(card, "div", "hp-card-meta");
    if (CLOSED.has(p.status)) this.rangeChip(meta, p);
    else {
      this.healthChip(meta, p);
      this.dueChip(meta, p);
    }
    if (p.parent) this.parentChip(meta, p);

    if (!CLOSED.has(p.status)) this.nextAction(card, p);

    const last = el(card, "div", "hp-last");
    if (p.last) {
      const e = p.last;
      const line = el(last, "div", "hp-last-meta");
      this.authorBadge(line, e.author);
      const k = el(line, "span", "hp-kind-mini");
      k.style.setProperty("--hp-kind", KINDS[e.kind].color);
      icon(k, KINDS[e.kind].icon);
      el(line, "span", "hp-time", relTime(e));
      const text = el(last, "div", "hp-last-text", "…");
      entryText(this.app, e).then(s => {
        text.textContent = s.preview ? `${s.headline}: ${s.preview}` : s.headline;
      });
      last.addEventListener("click", ev => { ev.stopPropagation(); openFile(this.app, e.file, ev); });
    } else {
      el(last, "div", "hp-last-text is-empty", "No updates yet");
    }

    const foot = el(card, "div", "hp-card-foot");
    this.sparkline(foot, p.entries);
    const fa = el(foot, "div", "hp-card-actions");
    btn(fa, null, "message-square-plus", "hp-btn-icon", () => new UpdateModal(this.plugin, p).open())
      .setAttribute("aria-label", "Log: quick update or session note");
    this.archiveButton(fa, p, true);
    btn(fa, null, "external-link", "hp-btn-icon", e => openFile(this.app, p.file, e)).setAttribute("aria-label", "Open project");
  }

  // ----- custom order -----

  // Projects in the chosen order. Custom order is keyed by name, so it survives archiving;
  // projects not placed yet keep their smart position after the placed ones.
  ordered(projects) {
    if (this.st.sortMode !== "custom") return projects;
    const idx = new Map((this.st.order || []).map((n, i) => [n, i]));
    const key = (p, i) => (idx.has(p.name) ? idx.get(p.name) : 1e6 + i);
    return projects.map((p, i) => [p, key(p, i)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  }

  // Move `name` before/after `target` (null target = very top/bottom), then switch to custom order.
  moveProject(name, target, after) {
    const names = this.ordered(this.data.projects.filter(p => !p.program)).map(p => p.name);
    const from = names.indexOf(name);
    if (from < 0) return;
    names.splice(from, 1);
    const at = target == null ? (after ? names.length : 0) : names.indexOf(target) + (after ? 1 : 0);
    names.splice(Math.max(0, at), 0, name);
    this.update({ sortMode: "custom", order: names });
  }

  makeSortable(card, p) {
    card.draggable = true;
    const clear = () => card.classList.remove("is-drop-before", "is-drop-after");
    card.addEventListener("dragstart", e => {
      this.dragName = p.name;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", p.name);
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => {
      this.dragName = null;
      card.classList.remove("is-dragging");
      this.containerEl.querySelectorAll(".is-drop-before, .is-drop-after").forEach(c => c.classList.remove("is-drop-before", "is-drop-after"));
    });
    card.addEventListener("dragover", e => {
      if (!this.dragName || this.dragName === p.name) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = card.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      card.classList.toggle("is-drop-after", after);
      card.classList.toggle("is-drop-before", !after);
    });
    card.addEventListener("dragleave", e => { if (!card.contains(e.relatedTarget)) clear(); });
    card.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      const after = card.classList.contains("is-drop-after");
      clear();
      const name = this.dragName;
      this.dragName = null;
      if (name && name !== p.name) this.moveProject(name, p.name, after);
    });
    // Right-click / long-press menu: reordering without a mouse drag (works on mobile too).
    card.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      const i = this.visible.indexOf(p.name);
      const prev = this.visible[i - 1];
      const next = this.visible[i + 1];
      const menu = new Menu();
      menu.addItem(it => it.setTitle("Move to top").setIcon("arrow-up-to-line").setDisabled(i === 0)
        .onClick(() => this.moveProject(p.name, null, false)));
      menu.addItem(it => it.setTitle("Move up").setIcon("arrow-up").setDisabled(!prev)
        .onClick(() => this.moveProject(p.name, prev, false)));
      menu.addItem(it => it.setTitle("Move down").setIcon("arrow-down").setDisabled(!next)
        .onClick(() => this.moveProject(p.name, next, true)));
      menu.addItem(it => it.setTitle("Move to bottom").setIcon("arrow-down-to-line").setDisabled(i === this.visible.length - 1)
        .onClick(() => this.moveProject(p.name, null, true)));
      menu.addSeparator();
      menu.addItem(it => it.setTitle("Quick update").setIcon("message-square-plus").onClick(() => new UpdateModal(this.plugin, p, "quick").open()));
      menu.addItem(it => it.setTitle("New session note").setIcon("notebook-pen").onClick(() => new UpdateModal(this.plugin, p, "session").open()));
      menu.addItem(it => it.setTitle("Open in new tab").setIcon("external-link")
        .onClick(() => this.app.workspace.openLinkText(p.file.path, "", true)));
      if (p.dedicated && !p.archived) {
        menu.addItem(it => it.setTitle("Archive…").setIcon("archive").onClick(() => new ArchiveModal(this.plugin, p).open()));
      }
      menu.showAtMouseEvent(e);
    });
  }

  // ----- shared project controls (cards and project pages) -----

  statusPill(parent, p) {
    const status = el(parent, "span", `hp-pill hp-status status-${p.status}`, STATUSES[p.status].label);
    status.setAttribute("aria-label", "Change status");
    status.addEventListener("click", e => {
      e.stopPropagation();
      const menu = new Menu();
      for (const [k, v] of Object.entries(STATUSES)) {
        menu.addItem(i => i.setTitle(v.label).setChecked(k === p.status).onClick(() => setFields(this.app, p.file, { status: k })));
      }
      menu.showAtMouseEvent(e);
    });
    return status;
  }

  healthChip(parent, p) {
    const health = el(parent, "span", `hp-chip hp-health is-${p.health}`);
    icon(health, HEALTH[p.health].icon);
    el(health, "span", null, HEALTH[p.health].label + (p.healthSet ? "" : " ·auto"));
    health.setAttribute("aria-label", p.healthSet ? "Health (set manually)" : "Health (derived from updates and dates). Click to set.");
    health.addEventListener("click", e => {
      e.stopPropagation();
      const menu = new Menu();
      for (const [k, v] of Object.entries(HEALTH)) {
        menu.addItem(i => i.setTitle(v.label).setIcon(v.icon).setChecked(k === p.healthSet)
          .onClick(() => setFields(this.app, p.file, { health: k })));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle("Automatic").setIcon("wand-sparkles").setChecked(!p.healthSet)
        .onClick(() => setFields(this.app, p.file, { health: "" })));
      menu.showAtMouseEvent(e);
    });
    return health;
  }

  dueChip(parent, p, always) {
    if (!p.due && !always) return null;
    let txt = "Set due date";
    if (p.due) {
      const days = p.due.diff(moment().startOf("day"), "days");
      txt = CLOSED.has(p.status) ? `Due ${p.due.format("MMM D, YYYY")}`
        : p.overdue ? `Overdue ${-days}d` : days === 0 ? "Due today" : `Due ${p.due.format("MMM D")} · ${days}d`;
    }
    const due = el(parent, "span", "hp-chip hp-due" + (p.overdue ? " is-overdue" : p.dueSoon ? " is-soon" : "") + (p.due ? "" : " is-empty"));
    icon(due, "calendar");
    el(due, "span", null, txt);
    due.setAttribute("aria-label", "Change due date");
    due.addEventListener("click", e => {
      e.stopPropagation();
      new TextModal(this.app, `Due date · ${p.name}`, p.due ? p.due.format("YYYY-MM-DD") : "",
        v => setFields(this.app, p.file, { due: v }), "date").open();
    });
    return due;
  }

  rangeChip(parent, p) {
    const a = p.start || p.created;
    const b = p.end;
    if (!a && !b) return null;
    const c = el(parent, "span", "hp-chip hp-range");
    icon(c, "calendar-range");
    const fmt = m => m.format(m.year() === moment().year() ? "MMM D" : "MMM YYYY");
    el(c, "span", null, `${a ? fmt(a) : "?"} → ${b ? fmt(b) : "now"}`);
    if (a && b) c.setAttribute("aria-label", `${a.format("MMM D, YYYY")} to ${b.format("MMM D, YYYY")} (${b.diff(a, "days")} days)`);
    return c;
  }

  archiveButton(parent, p, iconOnly) {
    if (!p.dedicated) return null;
    if (p.archived) {
      const b = btn(parent, iconOnly ? null : "Restore", "archive-restore", iconOnly ? "hp-btn-icon" : null, async () => {
        try {
          const dest = await restoreProject(this.app, p, subProjectsInside(collect(this.app).projects, p));
          new Notice(`Restored ${p.name} to ${dest}`);
        } catch (err) {
          new Notice(`Could not restore: ${err.message}`);
        }
      });
      b.setAttribute("aria-label", "Restore from archive (status: active)");
      return b;
    }
    const b = btn(parent, iconOnly ? null : "Archive", "archive", iconOnly ? "hp-btn-icon" : null, () => new ArchiveModal(this.plugin, p).open());
    b.setAttribute("aria-label", "Archive project");
    return b;
  }

  parentChip(parent, p) {
    const par = el(parent, "span", "hp-chip hp-parent");
    icon(par, "folder-tree");
    el(par, "span", null, p.parent);
    par.addEventListener("click", e => {
      e.stopPropagation();
      this.app.workspace.openLinkText(p.parent, p.file.path, !!(e.metaKey || e.ctrlKey));
    });
    return par;
  }

  nextAction(parent, p) {
    const next = el(parent, "div", "hp-next" + (p.next ? "" : " is-empty"));
    icon(next, "arrow-right-circle");
    el(next, "span", null, p.next || "Set next action");
    next.setAttribute("aria-label", "Edit next action");
    next.addEventListener("click", e => {
      e.stopPropagation();
      new TextModal(this.app, `Next action · ${p.name}`, p.next, v => setFields(this.app, p.file, { next_action: v })).open();
    });
    return next;
  }

  sparkline(parent, entries, weeks = SPARK_WEEKS) {
    const wrap = el(parent, "div", "hp-spark");
    wrap.setAttribute("aria-label", `Updates per week, last ${weeks} weeks`);
    const start = moment().startOf("isoWeek").subtract(weeks - 1, "weeks");
    const counts = new Array(weeks).fill(0);
    for (const e of entries) {
      const w = e.date.clone().startOf("isoWeek").diff(start, "weeks");
      if (w >= 0 && w < weeks) counts[w]++;
    }
    const max = Math.max(1, ...counts);
    counts.forEach((c, i) => {
      const b = el(wrap, "span", "hp-spark-bar" + (c ? "" : " is-zero"));
      b.style.height = `${Math.max(12, (c / max) * 100)}%`;
      b.setAttribute("aria-label", `Week of ${start.clone().add(i, "weeks").format("MMM D")}: ${c}`);
    });
    return wrap;
  }

  authorBadge(parent, author) {
    const a = el(parent, "span", "hp-author", author);
    a.style.setProperty("--hp-author", authorColor(author));
    return a;
  }

  // ----- feed -----

  renderFeed(sec, entries) {
    const head = el(sec, "div", "hp-section-head");
    el(head, "h3", "hp-section-title", "Activity");
    const authors = ["all", ...new Set(entries.map(e => e.author))];
    if (authors.length > 2) {
      const seg = el(head, "div", "hp-seg");
      for (const a of authors) {
        const b = el(seg, "button", "hp-seg-btn" + (this.st.feedAuthor === a ? " is-active" : ""), a === "all" ? "All" : a);
        if (a !== "all") b.style.setProperty("--hp-accent", authorColor(a));
        b.addEventListener("click", () => this.update({ feedAuthor: a }));
      }
    }
    const list = this.st.feedAuthor === "all" ? entries : entries.filter(e => e.author === this.st.feedAuthor);
    this.renderTimeline(el(sec, "div", "hp-feed"), list, true);
  }

  renderTimeline(container, entries, showProject) {
    if (!entries.length) {
      el(container, "div", "hp-empty", "No updates yet. Use “Log”, or have an agent log one with the helper script.");
      return;
    }
    let lastDay = null;
    let group = null;
    for (const e of entries.slice(0, this.feedLimit)) {
      const day = e.date.format("YYYY-MM-DD");
      if (day !== lastDay) {
        lastDay = day;
        const g = el(container, "div", "hp-day");
        el(g, "div", "hp-day-label", dayLabel(e.date));
        group = el(g, "div", "hp-day-items");
      }
      this.renderEntry(group, e, showProject);
    }
    if (entries.length > this.feedLimit) {
      btn(container, `Show more (${entries.length - this.feedLimit})`, "chevrons-down", "hp-btn-ghost hp-more", () => {
        this.feedLimit += 25;
        this.render();
      });
    }
  }

  renderEntry(parent, e, showProject) {
    const kind = KINDS[e.kind];
    const item = el(parent, "div", `hp-entry kind-${e.kind}`);
    item.style.setProperty("--hp-kind", kind.color);
    const rail = el(item, "div", "hp-entry-rail");
    const dot = el(rail, "span", "hp-entry-dot");
    setIcon(dot, kind.icon);
    dot.setAttribute("aria-label", kind.label);

    const body = el(item, "div", "hp-entry-body");
    const meta = el(body, "div", "hp-entry-meta");
    this.authorBadge(meta, e.author);
    if (showProject) {
      for (const p of e.primary) {
        const chip = el(meta, "span", "hp-proj-chip", p.name);
        chip.style.setProperty("--hp-accent", AREAS[p.area].color);
        chip.addEventListener("click", ev => { ev.stopPropagation(); openFile(this.app, p.file, ev); });
      }
    }
    el(meta, "span", "hp-kind-label", kind.label);
    el(meta, "span", "hp-time", e.hasTime ? e.date.format("HH:mm") : "");

    const headline = el(body, "div", "hp-entry-headline", "…");
    const preview = el(body, "div", "hp-entry-preview");
    const detail = el(body, "div", "hp-entry-detail markdown-rendered");
    headline.addEventListener("click", ev => openFile(this.app, e.file, ev));

    entryText(this.app, e).then(async s => {
      headline.replaceChildren();
      await renderMd(this.app, s.headline, headline, e.file.path, this.inner);
      if (s.preview) preview.textContent = s.preview;
      if (!s.rest) return;
      const key = e.file.path;
      const toggle = btn(body, this.expanded.has(key) ? "Hide details" : "Details", "chevron-down", "hp-btn-ghost hp-toggle-detail", async () => {
        if (this.expanded.has(key)) {
          this.expanded.delete(key);
          detail.replaceChildren();
          toggle.lastChild.textContent = "Details";
          item.classList.remove("is-open");
        } else {
          this.expanded.add(key);
          await renderMd(this.app, s.rest, detail, e.file.path, this.inner);
          toggle.lastChild.textContent = "Hide details";
          item.classList.add("is-open");
        }
      });
      if (this.expanded.has(key)) {
        item.classList.add("is-open");
        await renderMd(this.app, s.rest, detail, e.file.path, this.inner);
      }
    });
  }

  // ----- project page -----

  renderProjectPage(data) {
    const root = el(this.containerEl, "div", "hp-root hp-page");
    const p = data.projects.find(x => x.file.path === this.sourcePath);
    if (!p) {
      el(root, "div", "hp-empty", "project-panel only works inside a hub note with type: project (or program).");
      return;
    }
    const area = AREAS[p.area];
    root.style.setProperty("--hp-accent", area.color);
    const scope = projectScope(this.app, p);
    const tasks = countTasks(this.app, scope.taskFiles);
    const children = data.projects.filter(c => c.parent.toLowerCase() === p.name.toLowerCase());

    // Hero
    const hero = el(root, "div", `hp-page-hero is-${p.health}`);
    const top = el(hero, "div", "hp-page-top");
    const eyebrow = el(top, "div", "hp-eyebrow");
    const badge = el(eyebrow, "span", "hp-area-icon");
    setIcon(badge, area.icon);
    el(eyebrow, "span", "hp-eyebrow-label", `${area.label} ${p.program ? "program" : "project"}`);
    if (p.created) el(eyebrow, "span", "hp-eyebrow-sub", `since ${p.created.format("MMM YYYY")}`);
    const actions = el(top, "div", "hp-hero-actions");
    btn(actions, "Home", "layout-dashboard", null, () => this.plugin.openHome());
    btn(actions, "New note", "file-plus", null, () => this.newNote(p));
    btn(actions, "Sub-project", "folder-plus", null, () => new ProjectModal(this.plugin, p).open())
      .setAttribute("aria-label", `Add a project inside ${p.name}`);
    this.archiveButton(actions, p, false);
    btn(actions, "Log", "message-square-plus", "hp-btn-primary", () => new UpdateModal(this.plugin, p).open())
      .setAttribute("aria-label", "Quick update or session note");

    const chips = el(hero, "div", "hp-card-meta hp-page-chips");
    this.statusPill(chips, p);
    if (CLOSED.has(p.status)) this.rangeChip(chips, p);
    else {
      this.healthChip(chips, p);
      this.dueChip(chips, p, true);
    }
    if (p.archived) {
      const a = el(chips, "span", "hp-chip hp-archived");
      icon(a, "archive");
      el(a, "span", null, "In archive");
    }
    if (p.parent) this.parentChip(chips, p);
    if (!CLOSED.has(p.status)) this.nextAction(hero, p);

    const strip = el(hero, "div", "hp-page-strip");
    this.sparkline(strip, p.entries, 16);
    el(strip, "span", "hp-strip-label", "activity · last 16 weeks");

    // Stats
    const stats = el(root, "div", "hp-stats hp-page-stats");
    const stat = (value, label, ic, color, tab) => {
      const c = el(stats, "div", "hp-stat" + (tab ? " is-clickable" : "") + (tab && this.tab() === tab ? " is-active" : ""));
      c.style.setProperty("--hp-accent", color);
      const t = el(c, "div", "hp-stat-top");
      icon(t, ic);
      el(t, "span", "hp-stat-n" + (typeof value === "string" ? " is-text" : ""), String(value));
      el(c, "div", "hp-stat-label", label);
      if (tab) c.addEventListener("click", () => this.update({ projectTab: tab }));
      return c;
    };
    const updates = p.entries.filter(e => e.isUpdate).length;
    stat(updates, "Updates", "activity", "#2dd4bf", "activity");
    stat(p.last ? relTime(p.last) : "never", "Last activity", "clock", p.stale ? "#fbbf24" : "var(--interactive-accent)");
    stat(tasks.open, tasks.done ? `Open tasks · ${tasks.done} done` : "Open tasks", "list-checks", "#f472b6", "tasks");
    stat(scope.meetings.length, "Meetings", "users", "#38bdf8", "meetings");
    stat(scope.notes.length, "Notes", "files", "#94a3b8", "notes");
    const authors = [...new Set(p.entries.map(e => e.author))];
    const who = stat(authors.length, "Contributors", "users", "#a78bfa");
    const badges = el(who, "div", "hp-who");
    authors.slice(0, 4).forEach(a => this.authorBadge(badges, a));

    // Sub-projects
    if (children.length) {
      const sec = el(root, "section", "hp-page-section");
      const head = el(sec, "div", "hp-section-head");
      el(head, "h3", "hp-section-title", "Sub-projects");
      btn(head, "Add", "plus", "hp-btn-ghost", () => new ProjectModal(this.plugin, p).open());
      const grid = el(sec, "div", "hp-grid");
      this.ordered(children).forEach(c => this.renderCard(grid, c));
    }

    // Tabs
    const tabsEl = el(root, "div", "hp-tabs");
    const tabs = [
      ["activity", "Activity", "activity", p.entries.length], ["meetings", "Meetings", "users", scope.meetings.length],
      ["tasks", "Tasks", "list-checks", tasks.open], ["notes", "Notes", "files", scope.notes.length],
    ];
    for (const [k, label, ic, n] of tabs) {
      const t = el(tabsEl, "button", "hp-tab" + (this.tab() === k ? " is-active" : ""));
      icon(t, ic);
      el(t, "span", null, label);
      el(t, "span", "hp-tab-count", String(n));
      t.addEventListener("click", () => this.update({ projectTab: k }));
    }
    const body = el(root, "div", "hp-tab-body");
    if (this.tab() === "tasks") this.renderTasks(body, scope.taskFiles, p);
    else if (this.tab() === "notes") this.renderNotes(body, scope.notes, p);
    else if (this.tab() === "meetings") this.renderMeetings(body, scope.meetings, p);
    else this.renderTimeline(el(body, "div", "hp-feed"), p.entries, p.program || children.length > 0);
  }

  tab() { return this.st.projectTab || "activity"; }

  newNote(p) {
    new TextModal(this.app, `New note in ${p.name}`, "", async name => {
      if (!name) return;
      try {
        const file = await createNote(this.app, p, name);
        this.app.workspace.getLeaf(true).openFile(file);
      } catch (err) {
        new Notice(`Could not create note: ${err.message}`);
      }
    }, "text", false).open();
  }

  renderTasks(body, files, p) {
    const list = el(body, "div", "hp-tasks");
    el(list, "div", "hp-empty", "Loading tasks…");
    loadTasks(this.app, files).then(tasks => {
      list.replaceChildren();
      const open = tasks.filter(t => t.open).sort((a, b) =>
        (a.due ? a.due.valueOf() : Infinity) - (b.due ? b.due.valueOf() : Infinity) || b.file.stat.mtime - a.file.stat.mtime);
      const done = tasks.filter(t => !t.open).sort((a, b) =>
        (b.doneOn ? b.doneOn.valueOf() : 0) - (a.doneOn ? a.doneOn.valueOf() : 0) || b.file.stat.mtime - a.file.stat.mtime);
      if (!open.length) {
        el(list, "div", "hp-empty", done.length ? "All tasks done. 🎉" : "No tasks yet. Any - [ ] item in this project's notes, updates or meetings shows up here.");
      }
      open.forEach(t => this.renderTask(list, t, p));
      if (done.length) {
        btn(list, this.showDone ? "Hide completed" : `Show completed (${done.length})`, "check-check", "hp-btn-ghost hp-more", () => {
          this.showDone = !this.showDone;
          this.render();
        });
        if (this.showDone) done.slice(0, 50).forEach(t => this.renderTask(list, t, p));
      }
    });
  }

  renderTask(list, t, p) {
    const row = el(list, "div", "hp-task" + (t.open ? "" : " is-done"));
    const cb = el(row, "input", "task-list-item-checkbox hp-task-cb");
    cb.type = "checkbox";
    cb.checked = !t.open;
    cb.addEventListener("change", () => toggleTask(this.app, t));
    const main = el(row, "div", "hp-task-main");
    const text = el(main, "div", "hp-task-text");
    renderMd(this.app, t.text || "(empty task)", text, t.file.path, this.inner);
    const meta = el(main, "div", "hp-task-meta");
    if (t.due) {
      const days = t.due.diff(moment().startOf("day"), "days");
      const d = el(meta, "span", "hp-chip hp-due" + (t.open && days < 0 ? " is-overdue" : t.open && days <= 3 ? " is-soon" : ""));
      icon(d, "calendar");
      el(d, "span", null, t.open && days < 0 ? `Overdue ${-days}d` : days === 0 ? "Today" : t.due.format("MMM D"));
    }
    if (t.doneOn) el(meta, "span", "hp-task-when", `done ${t.doneOn.format("MMM D")}`);
    const src = el(meta, "span", "hp-task-src");
    icon(src, "file-text");
    el(src, "span", null, t.file === p.file ? "this note" : t.file.basename);
    src.addEventListener("click", e => {
      this.app.workspace.openLinkText(t.file.path, "", !!(e.metaKey || e.ctrlKey), { eState: { line: t.line } });
    });
  }

  // Dated notes (meetings, session notes, reports), grouped by semester folder or month.
  renderMeetings(body, meetings, p) {
    const bar = el(body, "div", "hp-notes-bar");
    el(bar, "span", "hp-faint", meetings.length === 1 ? "1 meeting or report" : `${meetings.length} meetings and reports`);
    const add = el(bar, "div", "hp-bar-actions");
    btn(add, "Dated note", "file-plus", "hp-btn-ghost", () => new UpdateModal(this.plugin, p, "note").open());
    btn(add, "New meeting", "notebook-pen", "hp-btn-ghost", () => new UpdateModal(this.plugin, p, "session").open());
    const list = el(body, "div", "hp-notes");
    if (!meetings.length) el(list, "div", "hp-empty", "No meetings yet. “New meeting” creates a dated session note.");
    const limit = this.meetingsLimit || 30;
    const bySemester = GROUPING === "term" ? TERMS.length > 0
      : GROUPING === "auto" && meetings.some(m => m.file.parent && SEMESTER_DIR.test(m.file.parent.name));
    let group = null;
    for (const m of meetings.slice(0, limit)) {
      // Semester projects group by their semester folder (or the semester the date falls in); others by month.
      const folder = m.file.parent ? m.file.parent.name : "";
      const label = GROUPING !== "month" && SEMESTER_DIR.test(folder || "") ? folder.replace("-", " ")
        : bySemester ? semesterOf(m.date).replace("-", " ") : m.date.format("MMMM YYYY");
      if (label !== group) {
        group = label;
        el(list, "div", "hp-meeting-group", label);
      }
      const fm = (this.app.metadataCache.getFileCache(m.file) || {}).frontmatter || {};
      const isMeeting = (m.entry && m.entry.kind === "meeting") || lc(fm.type) === "meeting";
      const row = el(list, "div", "hp-note hp-meeting");
      const ic = el(row, "span", "hp-note-icon" + (isMeeting ? " is-meeting" : ""));
      setIcon(ic, isMeeting ? "users" : "file-text");
      ic.setAttribute("aria-label", isMeeting ? "Meeting" : "Report / dated note");
      const main = el(row, "div", "hp-note-main");
      const summary = fm.summary ? String(fm.summary).trim() : "";
      el(main, "div", "hp-note-name", summary || m.file.basename);
      const meta = el(main, "div", "hp-meeting-meta");
      el(meta, "span", null, m.date.format("ddd, MMM D"));
      if (summary) el(meta, "span", "hp-faint", m.file.basename);
      // On a program page, say which workstream each meeting belongs to.
      for (const q of (m.entry ? m.entry.primary : []).filter(q => q !== p)) {
        const chip = el(meta, "span", "hp-proj-chip", q.name);
        chip.style.setProperty("--hp-accent", AREAS[q.area].color);
      }
      const counts = el(meta, "span", "hp-meeting-counts");
      const t = countTasks(this.app, [m.file]);
      const parts = [];
      if (t.open + t.done) parts.push(`${plural(t.open + t.done, "task")}${t.open ? ` (${t.open} open)` : ""}`);
      counts.textContent = parts.join(" · ");
      if (m.entry && isMeeting) {
        this.app.vault.cachedRead(m.file).then(raw => {
          if (!raw.includes("```project-done")) return;
          const n = sessionContext(m.entry.primary[0] || p, m.date).done.length;
          if (n) counts.textContent = [`✓ ${n} done since last`, ...parts].join(" · ");
        });
      }
      if (t.open) {
        const b = el(row, "span", "hp-meeting-open", String(t.open));
        b.setAttribute("aria-label", `${plural(t.open, "open task")} from this note`);
      }
      row.addEventListener("click", e => openFile(this.app, m.file, e));
    }
    if (meetings.length > limit) {
      btn(list, `Show more (${meetings.length - limit})`, "chevrons-down", "hp-btn-ghost hp-more", () => {
        this.meetingsLimit = limit + 30;
        this.render();
      });
    }
  }

  renderNotes(body, notes, p) {
    const bar = el(body, "div", "hp-notes-bar");
    el(bar, "span", "hp-faint", `${notes.length} note${notes.length === 1 ? "" : "s"} in ${p.folder}`);
    btn(bar, "New note", "file-plus", "hp-btn-ghost", () => this.newNote(p));
    const list = el(body, "div", "hp-notes");
    if (!notes.length) el(list, "div", "hp-empty", "No notes yet.");
    const limit = this.notesLimit || 20;
    const sorted = [...notes].sort((a, b) => b.stat.mtime - a.stat.mtime);
    for (const f of sorted.slice(0, limit)) {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      const isMeeting = lc(fm.type) === "meeting" || (!fm.type && MEETING_NAME.test(f.basename));
      const row = el(list, "div", "hp-note");
      const ic = el(row, "span", "hp-note-icon" + (isMeeting ? " is-meeting" : ""));
      setIcon(ic, isMeeting ? "users" : lc(fm.type) === "project" ? "folder-kanban" : "file-text");
      const main = el(row, "div", "hp-note-main");
      el(main, "div", "hp-note-name", f.basename);
      const rel = f.parent ? f.parent.path.slice(p.folder.length + 1) : "";
      if (rel) el(main, "div", "hp-note-path", rel);
      el(row, "span", "hp-time", moment(f.stat.mtime).fromNow());
      row.addEventListener("click", e => openFile(this.app, f, e));
    }
    if (sorted.length > limit) {
      btn(list, `Show more (${sorted.length - limit})`, "chevrons-down", "hp-btn-ghost hp-more", () => {
        this.notesLimit = limit + 20;
        this.render();
      });
    }
  }

  // ----- session notes -----

  // The session note this block sits in: its project and date (frontmatter, else the file name).
  sessionNote(data, block) {
    const root = el(this.containerEl, "div", "hp-root hp-carried");
    const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
    const fm = (file && (this.app.metadataCache.getFileCache(file) || {}).frontmatter) || {};
    const name = lc(this.opts.project || linkTarget(fm.project));
    const p = data.projects.find(x => x.name.toLowerCase() === name);
    if (!p) {
      el(root, "div", "hp-empty", `${block} needs project: "[[Name]]" in this note's frontmatter.`);
      return null;
    }
    root.style.setProperty("--hp-accent", AREAS[p.area].color);
    const nm = file && file.basename.match(MEETING_NAME);
    const asOf = (parseDate(fm.date) || (nm && parseDate(nm[1])) || { m: moment() }).m.clone().endOf("day");
    return { root, p, asOf };
  }

  // Tasks checked off between the previous session and this one.
  renderDoneSince(data) {
    const s = this.sessionNote(data, "project-done");
    if (!s) return;
    const { prev, since, done } = sessionContext(s.p, s.asOf);
    const head = el(s.root, "div", "hp-carried-head");
    el(head, "span", null, "Since ");
    if (prev) {
      const a = el(head, "a", "internal-link", prev.file.basename);
      a.addEventListener("click", e => openFile(this.app, prev.file, e));
    } else el(head, "span", null, since.format("MMM D"));
    const list = el(s.root, "div", "hp-tasks");
    if (!done.length) {
      el(list, "div", "hp-empty", "Nothing checked off yet.");
      return;
    }
    for (const t of done) {
      const row = el(list, "div", "hp-task is-done");
      icon(row, "circle-check", "hp-done-mark");
      const main = el(row, "div", "hp-task-main");
      renderMd(this.app, t.text, el(main, "div", "hp-task-text"), t.file.path, this.inner);
      const meta = el(main, "div", "hp-task-meta");
      el(meta, "span", "hp-task-when", `done ${moment(t.doneOn).format("MMM D")}`);
      const src = el(meta, "span", "hp-task-src");
      icon(src, "file-text");
      el(src, "span", null, t.file.basename);
      src.addEventListener("click", e => {
        this.app.workspace.openLinkText(t.file.path, "", !!(e.metaKey || e.ctrlKey), { eState: { line: t.line } });
      });
    }
  }

  // Open tasks of the note's project from everything up to this note's date (not later sessions).
  renderCarriedTasks(data) {
    const s = this.sessionNote(data, "project-tasks");
    if (!s) return;
    const { root, p, asOf } = s;
    const later = new Set(p.entries.filter(e => e.date.isAfter(asOf)).map(e => e.file.path));
    const files = projectScope(this.app, p).taskFiles.filter(f => f.path !== this.sourcePath && !later.has(f.path));
    const list = el(root, "div", "hp-tasks");
    loadTasks(this.app, files).then(tasks => {
      const open = tasks.filter(t => t.open).sort((a, b) =>
        (a.due ? a.due.valueOf() : Infinity) - (b.due ? b.due.valueOf() : Infinity) || b.file.stat.mtime - a.file.stat.mtime);
      if (!open.length) el(list, "div", "hp-empty", "Nothing carried over.");
      // Tasks from notes older than two months fold away, so the recent ones stay readable.
      const cutoff = asOf.clone().subtract(OLD_TASK_DAYS, "days");
      const written = t => { const m = t.file.basename.match(MEETING_NAME); return m ? moment(m[1]) : moment(t.file.stat.mtime); };
      const old = open.filter(t => !t.due && written(t).isBefore(cutoff));
      open.filter(t => !old.includes(t)).forEach(t => this.renderTask(list, t, p));
      if (old.length) {
        btn(list, this.showOld ? "Hide older" : `${plural(old.length, "older open task")} (${OLD_TASK_DAYS}+ days)`, "history", "hp-btn-ghost hp-more", () => {
          this.showOld = !this.showOld;
          this.render();
        });
        if (this.showOld) old.forEach(t => this.renderTask(list, t, p));
      }
    });
  }

  // ----- per-project block -----

  renderProjectTimeline(data) {
    const root = el(this.containerEl, "div", "hp-root hp-project-block");
    const p = data.projects.find(x => x.file.path === this.sourcePath);
    if (!p) {
      el(root, "div", "hp-empty", "project-updates only works inside a hub note with type: project (or program).");
      return;
    }
    root.style.setProperty("--hp-accent", AREAS[p.area].color);
    const head = el(root, "div", "hp-section-head");
    el(head, "h4", "hp-section-title", `${p.entries.length} update${p.entries.length === 1 ? "" : "s"}`);
    const meta = el(head, "div", "hp-card-meta");
    const health = el(meta, "span", `hp-chip hp-health is-${p.health}`);
    icon(health, HEALTH[p.health].icon);
    el(health, "span", null, HEALTH[p.health].label);
    this.sparkline(meta, p.entries);
    btn(head, "Log", "message-square-plus", "hp-btn-primary", () => new UpdateModal(this.plugin, p).open());
    if (p.next) {
      const next = el(root, "div", "hp-next");
      icon(next, "arrow-right-circle");
      el(next, "span", null, p.next);
    }
    this.renderTimeline(el(root, "div", "hp-feed"), p.entries, p.program);
  }
}

// ---------- plugin ----------

function parseOpts(source) {
  const opts = {};
  for (const line of source.split("\n")) {
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (m) opts[m[1].toLowerCase()] = m[2];
  }
  return opts;
}

class HomeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const st = this.plugin.settings;
    containerEl.empty();
    const save = () => this.plugin.saveSettings(true);
    const text = (name, desc, key, placeholder) => new Setting(containerEl).setName(name).setDesc(desc)
      .addText(t => t.setPlaceholder(placeholder || String(DEFAULT_SETTINGS[key])).setValue(String(st[key] ?? ""))
        .onChange(v => { st[key] = v; save(); }));
    const number = (name, desc, key) => new Setting(containerEl).setName(name).setDesc(desc)
      .addText(t => {
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.setValue(String(st[key])).onChange(v => { st[key] = Number(v) || DEFAULT_SETTINGS[key]; save(); });
      });

    text("Your name", "Used in the Home greeting when the block has no “name:” option.", "userName", "Alex");
    text("Home note", "The note “Open home dashboard” opens. It is created with a dashboard block if it doesn't exist.", "homeNote");

    new Setting(containerEl).setName("Folders").setHeading();
    text("Projects folder", "New projects go in <this folder>/<area folder>/<name>.", "projectsRoot");
    text("Archive folder", "Archived projects move to <this folder>/<area folder>/<name>.", "archiveRoot");
    new Setting(containerEl).setName("Ignored folders")
      .setDesc("Comma or line separated. Notes here never count as projects, updates or meetings (templates, old archives).")
      .addTextArea(t => t.setPlaceholder("Templates").setValue(st.ignoredFolders || "").onChange(v => { st.ignoredFolders = v; save(); }));
    text("Updates subfolder", "Created inside a project folder to hold update notes.", "updatesFolder");
    text("Meetings subfolder", "Session notes go in the nearest folder with this name, at or above the project.", "meetingsFolder");

    new Setting(containerEl).setName("Areas").setHeading();
    containerEl.createEl("p", { cls: "setting-item-description",
      text: "Each project's “area:” field picks one of these. Icons are Lucide names. Projects with an unknown area show as Other." });
    (st.areas || []).forEach((a, i) => {
      const row = new Setting(containerEl).setClass("hp-area-setting");
      const field = (ph, key, w) => row.addText(t => {
        t.setPlaceholder(ph).setValue(a[key] || "").onChange(v => { a[key] = v.trim(); save(); });
        t.inputEl.style.width = w;
      });
      field("id", "id", "7em");
      field("Label", "label", "8em");
      field("Folder", "folder", "8em");
      field("Icon", "icon", "8em");
      row.addColorPicker(c => c.setValue(a.color || "#94a3b8").onChange(v => { a.color = v; save(); }));
      row.addExtraButton(b => b.setIcon("trash-2").setTooltip("Remove area").onClick(() => {
        st.areas.splice(i, 1);
        save();
        this.display();
      }));
    });
    new Setting(containerEl).addButton(b => b.setButtonText("Add area").onClick(() => {
      st.areas = st.areas || [];
      st.areas.push({ id: `area${st.areas.length + 1}`, label: "New area", color: "#94a3b8", icon: "folder", folder: "New area" });
      save();
      this.display();
    }));

    new Setting(containerEl).setName("Timing").setHeading();
    number("Quiet after (days)", "An active project with no activity for this long is flagged as quiet.", "staleDays");
    number("Due soon (days)", "Projects due within this many days are flagged.", "dueSoonDays");
    number("Old tasks (days)", "In “Still open”, undated tasks from notes older than this are folded away.", "oldTaskDays");

    new Setting(containerEl).setName("Meetings").setHeading();
    new Setting(containerEl).setName("Group meetings by")
      .setDesc("Auto uses terms when the meetings folder already has term subfolders such as “2026-Fall”, and months otherwise.")
      .addDropdown(d => d.addOption("auto", "Auto").addOption("month", "Month").addOption("term", "Term (semester)")
        .setValue(st.meetingGrouping).onChange(v => { st.meetingGrouping = v; save(); }));
    text("Terms", "Name and start date (MM-DD) of each term. A term runs until the next one starts.", "terms");
    new Setting(containerEl).setName("Session note template")
      .setDesc("Body of a new session note. Keep the ```project-done``` and ```project-tasks``` blocks for the live lists. {{date}} and {{project}} are filled in.")
      .addTextArea(t => {
        t.setValue(st.sessionTemplate || DEFAULT_TEMPLATE).onChange(v => { st.sessionTemplate = v; save(); });
        t.inputEl.rows = 14;
        t.inputEl.style.width = "100%";
        t.inputEl.style.fontFamily = "var(--font-monospace)";
      })
      .addExtraButton(b => b.setIcon("rotate-ccw").setTooltip("Restore default").onClick(() => {
        st.sessionTemplate = DEFAULT_TEMPLATE;
        save();
        this.display();
      }));
  }
}

module.exports = class HomeProjectManagerPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.areas)) this.settings.areas = DEFAULT_SETTINGS.areas.map(a => ({ ...a }));
    applyConfig(this.settings);
    this.addSettingTab(new HomeSettingTab(this.app, this));
    this.views = new Set();
    let timer = null;
    this.refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refreshAll(), 400);
    };

    this.registerMarkdownCodeBlockProcessor("home-panel", (src, el, ctx) => {
      ctx.addChild(new PanelView(this, el, "home", parseOpts(src), ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("project-panel", (src, el, ctx) => {
      ctx.addChild(new PanelView(this, el, "page", parseOpts(src), ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("project-updates", (src, el, ctx) => {
      ctx.addChild(new PanelView(this, el, "project", parseOpts(src), ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("project-done", (src, el, ctx) => {
      ctx.addChild(new PanelView(this, el, "done", parseOpts(src), ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("project-tasks", (src, el, ctx) => {
      ctx.addChild(new PanelView(this, el, "tasks", parseOpts(src), ctx.sourcePath));
    });

    // Keep DONE_INDEX in step with file contents.
    const index = (path, text) => {
      const done = scanDone(text);
      if (done.length) DONE_INDEX.set(path, done);
      else DONE_INDEX.delete(path);
    };
    this.registerEvent(this.app.metadataCache.on("changed", (file, data) => {
      if (typeof data === "string") index(file.path, data);
      this.refreshSoon();
    }));
    this.registerEvent(this.app.vault.on("delete", file => { DONE_INDEX.delete(file.path); this.refreshSoon(); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      for (const [path, v] of [...DONE_INDEX]) {
        if (path === oldPath || path.startsWith(oldPath + "/")) {
          DONE_INDEX.delete(path);
          DONE_INDEX.set(file.path + path.slice(oldPath.length), v);
        }
      }
      this.refreshSoon();
    }));
    this.app.workspace.onLayoutReady(async () => {
      // Only files whose cache shows a checked task need reading.
      for (const f of this.app.vault.getMarkdownFiles()) {
        const items = (this.app.metadataCache.getFileCache(f) || {}).listItems || [];
        if (items.some(li => li.task !== undefined && !OPEN_TASK.has(li.task))) index(f.path, await this.app.vault.cachedRead(f));
      }
      this.refreshAll();
    });
    // Re-render at midnight-ish so "today"/"yesterday" stay right on a long-open panel.
    this.registerInterval(window.setInterval(() => this.refreshAll(), 30 * 60 * 1000));

    this.addCommand({ id: "log-update", name: "Log update", callback: () => new UpdateModal(this, this.currentProject(), "quick").open() });
    this.addCommand({ id: "new-session", name: "New session note", callback: () => new UpdateModal(this, this.currentProject(), "session").open() });
    this.addCommand({ id: "new-dated-note", name: "New dated note", callback: () => new UpdateModal(this, this.currentProject(), "note").open() });
    this.addCommand({ id: "new-project", name: "New project", callback: () => new ProjectModal(this).open() });
    this.addCommand({ id: "open-home", name: "Open home dashboard", callback: () => this.openHome() });
    this.addCommand({
      id: "archive-project", name: "Archive current project",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        const p = file && collect(this.app).projects.find(x => x.file.path === file.path && !x.archived);
        if (!p) return false;
        if (!checking) new ArchiveModal(this, p).open();
        return true;
      },
    });
    this.addCommand({
      id: "new-sub-project", name: "New sub-project of current project",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        const p = file && collect(this.app).projects.find(x => x.file.path === file.path);
        if (!p) return false;
        if (!checking) new ProjectModal(this, p).open();
        return true;
      },
    });
    this.addRibbonIcon("layout-dashboard", "Open home dashboard", () => this.openHome());
  }

  // The project the active note belongs to: its hub, or a note naming it in `project:`.
  currentProject() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const { projects } = collect(this.app);
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const name = linkTarget(fm.project).toLowerCase();
    return projects.find(p => p.file.path === file.path) || projects.find(p => p.name.toLowerCase() === name) || null;
  }

  async openHome() {
    let path = normalizePath(trimSlashes(this.settings.homeNote) || "Home.md");
    if (!path.endsWith(".md")) path += ".md";
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      try {
        if (path.includes("/")) await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
        file = await this.app.vault.create(path, ["---", "type: dashboard", "---", "", "```home-panel", "feed: 25", "```", ""].join("\n"));
        new Notice(`Created ${path}`);
      } catch (err) {
        console.error(err);
        new Notice(`Couldn't create ${path}: ${err.message}`);
        return;
      }
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  refreshAll() {
    for (const v of this.views) v.render();
  }

  saveSettings(refresh = false) {
    applyConfig(this.settings);
    if (refresh) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.refreshAll(), 300);
    }
    return this.saveData(this.settings);
  }
};
