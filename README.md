# ManageBac connector for Claude

An unofficial [MCP](https://modelcontextprotocol.io) server that lets Claude read your
ManageBac account: assignments, deadlines, grades, teacher comments, notifications and
your timetable. It's much faster than clicking through the ManageBac app.

You run your own copy for free on your own Cloudflare account. Your password goes only
to your own Worker, and nobody else's server is involved.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bobby-sills/managebac-mcp)

> **Not affiliated with ManageBac or Faria Education.** This reads the student website the
> same way your browser does. Check that your school's acceptable-use policy allows it,
> and only use it with your own account.

## What you can ask Claude

- "What's due this week?" / "Do I have anything overdue?"
- "What did my teachers say about my last few assignments?"
- "Summarise the task sheet for my science summative."
- "Any new notifications? Mark the grade ones as read."
- "What's my timetable tomorrow?"

## Tools

| Tool | What it does |
|---|---|
| `get_overview` | Overdue tasks, upcoming tasks, and unread notifications in a single call |
| `list_tasks` | Upcoming, overdue or past tasks, with criterion scores (e.g. C 8/8), teacher comments, and submission timing (early or late) |
| `get_task` | Full task sheet, assessment criteria, released grades and feedback, your uploads, and the discussion |
| `get_calendar` | Calendar items with exact due times and descriptions for a date range |
| `list_notifications` | New or updated tasks, grades posted, comments; unread, read, starred or all |
| `mark_notification_read` | Marks one notification as read (the only tool that changes anything) |
| `list_classes` / `get_class` | Your classes, and each class's stream, units, tasks, discussions, files and members |
| `get_timetable` | Weekly timetable with rooms, teachers and attendance marks |
| `get_page` | Reads any `/student/...` page, e.g. `/student/profile` (reports) or `/student/ib/activity/sa` (Service as Action) |

## Setup (about 5 minutes, all in the browser)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and a GitHub account.

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repo into your GitHub, then asks you for:
   - `MB_HOST`: your school's ManageBac address, e.g. `yourschool.managebac.com`
   - `MB_LOGIN` and `MB_PASSWORD`: your ManageBac email and password
   - `MCP_SECRET`: a long random string you make up (letters and numbers, at least 16 characters).
     Treat it like a password.
2. Click **Create and deploy**. When it finishes, you'll see a Worker URL like
   `https://managebac-mcp.<your-subdomain>.workers.dev`.
3. In Claude, go to **Settings → Connectors → Add custom connector**. Use this URL and leave the OAuth fields empty:
   ```
   https://managebac-mcp.<your-subdomain>.workers.dev/mcp/<your MCP_SECRET>
   ```
4. Ask Claude "what's due this week?"

To change your password or any other value later, go to **Workers & Pages → managebac-mcp → Settings → Variables and Secrets**.

## Security

- The connector URL contains your `MCP_SECRET`. Anyone with the full URL can read your
  ManageBac through it, so don't share it. Every other path returns 404.
- Your password is stored as an encrypted Cloudflare Worker secret. The login session
  is kept in a KV store on your account.
- The connector reads only, with one exception: marking a notification as read.
  It can't submit work or change anything else.

## How it works

- **Sign-in:** the Worker signs in through ManageBac's normal login form, keeps the
  session cookies in KV, and signs in again by itself when the session expires.
- **Tasks, classes, timetable:** these pages are read as HTML and turned into structured data.
- **Due dates:** exact due times come from `/student/events.json`, the data the Calendar page uses.
- **Notifications:** these come from ManageBac's separate notifications service, using the
  token the website embeds in every page.

## Limits

- **Unofficial:** a ManageBac redesign can break the parsers. If tools start returning
  empty lists, please [open an issue](https://github.com/bobby-sills/managebac-mcp/issues).
- **Student accounts with password sign-in only:** schools that use SSO (Google or Microsoft
  sign-in) or 2-step verification aren't supported yet.
- **Attachments:** file links need a signed-in browser.
- **Tested on one MYP school:** DP and other schools' setups may differ a little.

## Development

```bash
npm install
npm test              # parser tests against sanitised real ManageBac markup
npm run typecheck
cp .dev.vars.example .dev.vars   # fill in, then:
npm run dev
```

MIT licensed.
