# Home Project Manager

A home dashboard and project pages for Obsidian, built entirely from plain notes. It has three parts:

- **A home dashboard** with every project as a card. Cards show health, due dates, quiet projects and recent activity, next to one activity feed for the whole vault.
- **A page for each project,** with Activity, Meetings, Tasks and Notes tabs.
- **Session notes that carry tasks forward.** A new meeting note lists, live, what was checked off since the last meeting and everything still open, so nothing gets retyped.

Updates are small Markdown files in a documented format. You, a teammate, or a coding agent such as Claude Code or Codex can each add one, and it shows up on the dashboard.

Nothing is stored in a database. Delete the plugin and your notes stay readable Markdown.

## Install

**From the community plugin list:** once the plugin is approved, search for *Home Project Manager* in **Settings → Community plugins**.

**Before then, with BRAT:** install [BRAT](https://github.com/TfTHacker/obsidian42-brat), choose **Add beta plugin**, and enter this repository's URL.

**By hand:** download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/home-project-manager/`. Then reload Obsidian and enable the plugin.

Then run **Open home dashboard** from the command palette. If your Home note doesn't exist yet, the command creates it.

## Concepts

### Projects

A project is a **hub note** whose frontmatter has `type: project`. The hub note sits in a folder named after the project, and everything in that folder belongs to the project.

```yaml
---
type: project
status: active        # active | needs-review | paused | done | archived
area: work            # one of the areas in settings
due: 2026-12-01       # optional
health: on-track      # optional: on-track | at-risk | blocked
next_action: "Send the draft to Sam"   # optional, one line
parent: "[[Bigger Project]]"           # optional, for sub-projects
---
```

Put a `project-panel` block in the hub note to get the project page:

````markdown
```project-panel
```
````

**New project** (on the dashboard or in the command palette) creates the folder and the hub note for you.

A note with `type: program` groups several projects. Its page combines the activity of the projects inside its folder.

### Update notes

An update is one short note in the project's `Updates/` subfolder, named `YYYY-MM-DD HHmm - <author>.md`:

```markdown
---
type: update
project: "[[My Project]]"
date: 2026-10-19T14:30
author: me
kind: progress
---
Finished the config audit; the learning-rate schedule differed between runs.

- [ ] Compare the re-run against the old baseline 📅 2026-10-22
```

- **`kind`:** one of `progress`, `milestone`, `blocker`, `decision` or `note`.
- **First line:** the headline shown in the feed.
- **`author`:** any lowercase name, such as `me`, `claude` or `codex`. Each author gets its own color.

Use **Log → Quick update** to write an update from Obsidian.

### Session notes (meetings)

**Log → Session note** creates `YYYY-MM-DD - <Project>.md` in the nearest `Meetings/` folder at or above the project. If that folder is organised by term (subfolders such as `2026-Fall`), the note goes into the current term's subfolder. The default template has five sections:

- **Done since last time:** a live list of tasks checked off since the previous session.
- **Still open:** a live, checkable list of the project's open tasks.
- **Finished**, **Discuss** and **TODO:** for you to fill in. Write TODOs as checkboxes and never copy them forward. Check them off wherever they are, and the next session note picks them up.

You can change the template in settings.

A note also counts as a meeting if it is named `YYYY-MM-DD - <Project name>`. Notes you already have show up without any changes.

### Dated notes

**Log → Dated note** creates a plain `YYYY-MM-DD - <Title>.md` note, such as a report or a write-up. It appears in the feed and the Meetings tab but never counts as a meeting.

### Done tasks are activity

A task checked off with a `✅ YYYY-MM-DD` date shows in the feed as "Checked off N tasks". It also counts toward the activity charts. The [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin adds that date automatically. Without it, checked tasks still work but don't show up as activity.

### Archiving

**Archive** on a project sets `status: done` or `status: archived`, records `start`, `end` and `archived_from`, then moves the project folder to `<Archive folder>/<area>/<name>`. **Restore** moves it back. Links keep working, because Obsidian updates them on move.

## Code blocks

| Block | Where | Shows |
| --- | --- | --- |
| `home-panel` | any note | the full dashboard. Options: `name: Alex`, `feed: 25` |
| `project-panel` | a project hub note | the project page |
| `project-updates` | a project hub note | the project's timeline only |
| `project-done` | a session note | tasks checked off since the previous session |
| `project-tasks` | a session note | the project's open tasks |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Your name | (empty) | Used in the greeting |
| Home note | `Home.md` | Opened by **Open home dashboard**, and created if missing |
| Projects folder | `Projects` | Where new projects are created |
| Archive folder | `Archive/Projects` | Where archived projects are moved |
| Ignored folders | `Templates` | Notes here are never read as projects, updates or meetings |
| Updates / Meetings subfolder | `Updates` / `Meetings` | Folder names the plugin creates and looks for |
| Areas | Work, Personal, Learning | Name, folder, Lucide icon and color for each area |
| Quiet after | 14 days | An active project with no activity for this long is flagged |
| Due soon | 14 days | Window for due-soon warnings |
| Old tasks | 60 days | Undated tasks in notes older than this are folded in "Still open" |
| Group meetings by | Auto | Group by term or by month. Auto uses terms when term folders exist |
| Terms | Spring 01-07, Summer 05-11, Fall 08-15, Winter 12-10 | Term names and start dates |
| Session note template | see settings | Body of new session notes; `{{date}}` and `{{project}}` are filled in |

## Logging from coding agents

`scripts/log-update.sh` writes an update note from the command line, so agents can report progress without opening Obsidian:

```bash
scripts/log-update.sh "My Project" progress claude "Added retry logic to the uploader; tests pass."
scripts/log-update.sh --list
```

The script finds the vault by walking up from the current folder to the nearest `.obsidian/`, or uses `$VAULT` if it is set. It reads folder names from the plugin's settings.

To use it from anywhere, link it onto your PATH:

```bash
ln -s "$PWD/scripts/log-update.sh" ~/.local/bin/vault-log
```

Then add a line like this to your agent's instructions file (`CLAUDE.md`, `AGENTS.md`):

> When you finish a meaningful piece of work, record it with `VAULT=~/Notes vault-log "<Project>" <progress|milestone|blocker|decision|note> <your-name> "<one-sentence headline>"`. Run `vault-log --list` for project names. Never edit or delete existing notes.

## Development

The plugin is a single CommonJS file with no build step. Edit `main.js` and `styles.css`, copy them into a test vault's plugin folder, and reload Obsidian.

To release:
1. Bump `version` in `manifest.json` and add it to `versions.json`.
2. Push a tag with the same version, for example `git tag 0.1.1 && git push --tags`.
3. The GitHub Action attaches `main.js`, `manifest.json` and `styles.css` to the release.

## License

MIT
