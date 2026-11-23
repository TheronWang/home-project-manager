#!/usr/bin/env node
// Builds the sample vault in ./sample with dates relative to today, and installs the plugin into it.
// Usage: node scripts/build-sample.mjs          (rewrites sample/, keeping nothing else)
//
// Everything in it is fictional. Open the folder in Obsidian with "Open folder as vault".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, "sample");

const pad = n => String(n).padStart(2, "0");
const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const ymd = n => { const d = day(n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const stamp = (n, hm) => `${ymd(n)}T${hm}`;
const fileStamp = (n, hm) => `${ymd(n)} ${hm.replace(":", "")}`;
const fwd = n => ymd(-n);

function write(rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.replace(/^\n/, ""));
}
const fm = obj => "---\n" + Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map(x => `  - ${x}`).join("\n")}` : `${k}: ${v}`).join("\n") + "\n---\n";

// ---------- reset ----------
// Keep Obsidian's own state for the sample (window layout, trust) if it exists.
const keep = new Set([".obsidian", "README.md"]);
if (fs.existsSync(root)) for (const f of fs.readdirSync(root)) if (!keep.has(f)) fs.rmSync(path.join(root, f), { recursive: true, force: true });

// ---------- projects ----------
function hub(folder, name, fields, body = "") {
  write(`${folder}/${name}/${name}.md`, fm({ type: "project", status: "active", ...fields, tags: ["project"] }) + `
# ${name}

\`\`\`project-panel
\`\`\`

${body}`);
}

function update(folder, name, n, hm, author, kind, message) {
  write(`${folder}/${name}/Updates/${fileStamp(n, hm)} - ${author}.md`,
    fm({ type: "update", project: `"[[${name}]]"`, date: stamp(n, hm), author, kind }) + message.trim() + "\n");
}

const W = "Projects/Work", P = "Projects/Personal", L = "Projects/Learning";

// Website Redesign: the busy one, with weekly meetings.
hub(W, "Website Redesign", { area: "work", created: ymd(62), due: fwd(24), health: "on-track",
  next_action: '"Ship the new navigation to staging"' }, `## Outcome

> [!goal] Definition of done
> The new marketing site is live, passes an accessibility audit, and the old CMS is switched off.

## Notes

- Design system lives in [[Design Principles]].
- Stakeholders: marketing (content), platform (hosting), support (help center links).
`);
write(`${W}/Website Redesign/Design Principles.md`, fm({ type: "project-note", project: '"[[Website Redesign]]"', area: "work", created: ymd(58) }) + `
# Design Principles

1. Content first: every page answers one question.
2. One primary action per screen.
3. Text at least 16px; contrast at least 4.5:1.
4. Navigation never goes deeper than two levels.
`);
const wr = (n, hm, a, k, m) => update(W, "Website Redesign", n, hm, a, k, m);
wr(55, "10:05", "me", "decision", "Chose a static-site generator over the old CMS, since every page is marketing content and builds stay under a minute.");
wr(48, "16:20", "me", "progress", "Finished the sitemap: 42 pages collapse to 18, and every old URL has a redirect target.");
wr(41, "11:40", "claude", "progress", "Built the page-template components (hero, feature grid, pricing table) with tests for each.\n\n- [x] Hero component ✅ " + ymd(41) + "\n- [x] Feature grid ✅ " + ymd(41));
wr(34, "09:15", "me", "milestone", "Design review passed; marketing signed off on the homepage and pricing layouts.");
wr(27, "14:50", "codex", "progress", "Migrated 18 pages of content from the CMS export; 3 pages need manual cleanup of embedded tables.");
wr(20, "17:30", "claude", "progress", "Added the redirect map and a CI check that fails on any old URL without a target.");
wr(13, "10:10", "me", "blocker", "Staging deploys are blocked on a DNS change from the platform team. Unblocked once they add the CNAME (ticket filed).");
wr(9, "15:45", "me", "progress", "Platform added the CNAME; staging is live at the new domain.");
wr(4, "11:20", "claude", "progress", "Rebuilt the navigation as a two-level menu with keyboard support; Lighthouse accessibility is now 100.");
wr(1, "16:05", "codex", "progress", "Fixed layout shift on the pricing page by reserving image space; CLS dropped from 0.21 to 0.02.");

// Weekly session notes for Website Redesign.
const meet = (n, body, summary = "") => write(`${W}/Website Redesign/Meetings/${ymd(n)} - Website Redesign.md`,
  fm({ type: "meeting", project: '"[[Website Redesign]]"', area: "work", date: ymd(n), summary }) + body);
meet(35, `
##### Finished
1. Homepage and pricing layouts reviewed with marketing.

##### Discuss
1. Do we keep the blog on the old CMS for now?

##### TODO
1. [x] Export all CMS content as Markdown ✅ ${ymd(28)}
2. [x] Draft the redirect map ✅ ${ymd(21)}
3. [x] Ask platform for staging DNS ✅ ${ymd(13)}
`, "Design sign-off");
meet(28, `
##### Done since last time
\`\`\`project-done
\`\`\`

##### Finished
1. Content export finished; 3 pages need table cleanup.

##### Discuss
1. Blog stays on the old CMS until Q1.

##### TODO
1. [x] Clean up tables on the 3 flagged pages ✅ ${ymd(18)}
2. [x] Add a CI check for redirects ✅ ${ymd(20)}
3. [ ] Write alt text for the product screenshots
`, "Content migration");
meet(14, `
##### Done since last time
\`\`\`project-done
\`\`\`

##### Still open
\`\`\`project-tasks
\`\`\`

##### Finished
1. Pricing table now pulls from the billing config.

##### Discuss
1. Staging DNS is still waiting on platform.

##### TODO
1. [x] Follow up with platform on the CNAME ✅ ${ymd(10)}
2. [x] Rebuild the navigation as a two-level menu ✅ ${ymd(4)}
3. [ ] Run an accessibility audit on staging 📅 ${fwd(5)}
`, "Waiting on staging DNS");
meet(7, `
##### Done since last time
\`\`\`project-done
\`\`\`

##### Still open
\`\`\`project-tasks
\`\`\`

##### Finished
1. Staging is live at the new domain.

##### Discuss
1. Launch checklist: who owns analytics?

##### TODO
1. [x] Fix layout shift on pricing ✅ ${ymd(1)}
2. [ ] Set up analytics events for sign-up clicks 📅 ${fwd(3)}
3. [ ] Schedule the launch announcement with marketing 📅 ${fwd(12)}
`, "Staging live");
meet(0, `
##### Done since last time
\`\`\`project-done
\`\`\`

##### Still open
\`\`\`project-tasks
\`\`\`

##### Finished
1.

##### Discuss
1. Go or no-go for launch on ${fwd(24)}?

##### TODO
1. [ ] Freeze content two days before launch
`, "Launch readiness");
write(`${W}/Website Redesign/${ymd(16)} - Usability Test Report.md`, fm({ type: "project-note", project: '"[[Website Redesign]]"', area: "work", date: ymd(16), summary: "5 participants, 2 navigation issues found" }) + `
Five participants each tried three tasks on the staging build.

- 5/5 found pricing within 20 seconds.
- 3/5 missed the "Docs" link in the old dropdown, which led to the two-level menu.
- 2/5 expected the logo to link home on mobile.
`);

// Mobile App Launch: due soon and at risk.
hub(W, "Mobile App Launch", { area: "work", created: ymd(50), due: fwd(6), health: "at-risk",
  next_action: '"Get App Store review feedback"' }, "## Notes\n\nRelease checklist lives in the tasks below.\n\n- [ ] Submit build 1.0 for App Store review 📅 " + fwd(2) + "\n- [ ] Prepare release notes 📅 " + fwd(4) + "\n- [x] Finish crash-reporting setup ✅ " + ymd(6) + "\n");
const ma = (n, hm, a, k, m) => update(W, "Mobile App Launch", n, hm, a, k, m);
ma(44, "10:00", "me", "progress", "Beta build shipped to 40 internal testers.");
ma(30, "13:30", "codex", "progress", "Added offline caching for the feed; cold start is 30% faster.");
ma(18, "09:45", "me", "decision", "Cut the tablet layout from 1.0 to protect the launch date; it moves to 1.1.");
ma(6, "18:10", "claude", "progress", "Wired up crash reporting and symbol upload in CI.");
ma(2, "12:00", "me", "blocker", "App Store review flagged the sign-in flow for missing account deletion. Needs an in-app delete option before resubmitting.");

// Q4 Planning: needs review.
hub(W, "Q4 Planning", { status: "needs-review", area: "work", created: ymd(40), due: fwd(9),
  next_action: '"Collect team estimates"' }, "## Notes\n\n- [ ] Draft the Q4 roadmap one-pager 📅 " + fwd(7) + "\n");
update(W, "Q4 Planning", 22, "15:00", "me", "note", "Leadership wants the roadmap a week earlier this year; moved the due date.");

// Marathon Training: steady personal project.
hub(P, "Marathon Training", { area: "personal", created: ymd(60), due: fwd(40), health: "on-track",
  next_action: '"Long run: 28 km on Sunday"' }, "## Plan\n\n16-week plan, four runs a week.\n");
const mt = (n, m, k = "progress") => update(P, "Marathon Training", n, "07:30", "me", k, m);
mt(52, "Week 1 done: 32 km total, all easy pace.");
mt(38, "First 20 km long run at 6:10/km, felt comfortable.");
mt(24, "Half-marathon tune-up race in 1:49:12, a personal best.", "milestone");
mt(10, "Week 9 done: 54 km total; left calf a bit tight, added a rest day.");
mt(3, "Long run 26 km at 6:05/km with no calf issues.");

// Home Garden: gone quiet.
hub(P, "Home Garden", { area: "personal", created: ymd(80), next_action: '"Plant garlic before the first frost"' },
  "## Notes\n\n- [ ] Order garlic bulbs\n- [ ] Mulch the raised beds\n");
update(P, "Home Garden", 33, "18:00", "me", "progress", "Harvested the last tomatoes and pulled the plants; beds are ready for winter crops.");

// Learn Rust: learning project with an agent helping.
hub(L, "Learn Rust", { area: "learning", created: ymd(45), health: "on-track",
  next_action: '"Finish chapter 10: generics and traits"' }, "## Resources\n\n- [[Rust Resources]]\n");
write(`${L}/Learn Rust/Rust Resources.md`, fm({ type: "project-note", project: '"[[Learn Rust]]"', area: "learning", created: ymd(45) }) + `
# Rust Resources

- The Rust Programming Language ("the book"), chapters 1 to 20
- Rustlings exercises
- Small project: a command-line todo app
`);
const lr = (n, hm, a, k, m) => update(L, "Learn Rust", n, hm, a, k, m);
lr(42, "20:30", "me", "progress", "Finished chapters 1 to 4; ownership finally clicked after the string-slicing exercises.");
lr(29, "21:00", "me", "progress", "Rustlings: 45 of 94 exercises done.\n\n- [x] Finish the ownership exercises ✅ " + ymd(29));
lr(15, "19:45", "claude", "progress", "Reviewed the todo-app code: replaced three unwrap() calls with proper error handling and added tests for parsing.");
lr(5, "20:15", "me", "milestone", "The todo app works end to end: add, list, done, and save to a JSON file.\n\n- [ ] Add a `--due` flag to the todo app\n- [ ] Read chapter 10: generics and traits");

// Spanish B1: blocked.
hub(L, "Spanish B1", { area: "learning", created: ymd(70), due: fwd(55), health: "blocked",
  next_action: '"Find a new conversation partner"' }, "");
update(L, "Spanish B1", 47, "08:00", "me", "progress", "Finished unit 6 of the course; vocabulary review streak at 30 days.");
update(L, "Spanish B1", 12, "08:15", "me", "blocker", "My conversation partner moved away, so speaking practice stopped. Unblocked once I find a new partner or tutor.");

// An archived project.
write("Archive/Projects/Learning/Photography Basics/Photography Basics.md", fm({ type: "project", status: "done", area: "learning",
  start: ymd(150), end: ymd(65), archived_from: "Projects/Learning/Photography Basics", tags: ["project"] }) + "\n# Photography Basics\n\n```project-panel\n```\n");
write(`Archive/Projects/Learning/Photography Basics/Updates/${fileStamp(65, "17:00")} - me.md`,
  fm({ type: "update", project: '"[[Photography Basics]]"', date: stamp(65, "17:00"), author: "me", kind: "milestone" }) + "Finished the course and printed a 12-photo portfolio.\n");

// ---------- home and templates ----------
write("Home.md", fm({ type: "dashboard" }) + "\n```home-panel\nname: Alex\nfeed: 25\n```\n");
write("Templates/Project.md", fm({ type: "project", status: "active", area: "work" }) + "\n```project-panel\n```\n");
write("Welcome.md", `# Sample vault

This vault is fictional. It shows what **Home Project Manager** looks like with a few months of use.

- Open [[Home]] for the dashboard.
- Open [[Website Redesign]] for a project page with meetings.
- Every date is relative to the day \`scripts/build-sample.mjs\` was last run. Run it again to refresh them.
`);

// ---------- Obsidian config and the plugin ----------
const obs = path.join(root, ".obsidian");
const pluginDir = path.join(obs, "plugins", "home-project-manager");
fs.mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(repo, f), path.join(pluginDir, f));
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ userName: "Alex", ignoredFolders: "Templates" }, null, 2));
fs.writeFileSync(path.join(obs, "community-plugins.json"), JSON.stringify(["home-project-manager"]));
if (!fs.existsSync(path.join(obs, "app.json"))) fs.writeFileSync(path.join(obs, "app.json"), JSON.stringify({ readableLineLength: false, showInlineTitle: false, propertiesInDocument: "hidden" }, null, 2));
if (!fs.existsSync(path.join(obs, "appearance.json"))) fs.writeFileSync(path.join(obs, "appearance.json"), JSON.stringify({ theme: "obsidian" }, null, 2));

console.log(`Sample vault written to ${path.relative(process.cwd(), root) || "."} (dates relative to ${ymd(0)}).`);
