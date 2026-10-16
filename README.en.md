# JobTrail

[简体中文](README.md) | **English**

JobTrail is a local desktop app for managing your job search on Windows. Keep companies, job opportunities, resumes, application progress, and interview schedules in one place.

## Features

- **Application tracking**: Organize job details and application progress, with links to resumes and scheduled events.
- **Company management**: Find companies, browse career websites, manage multiple office locations, combine industry and location filters, and save favorites.
- **Job discovery (Beta)**: Search BOSS, Liepin, Zhilian, 51job, Guopin, Shixiseng and Yupao, sign in with WeChat or app QR codes where supported, filter salaries, rank results by relevance, browse stable result pages, read job details, open embedded websites and save selected jobs. Supports search history and MCP. See the [job discovery specification](docs/job-discovery.md) for search rules, account management and API contracts.
- **Resume management**: Keep multiple resumes and track which one you used for each application.
- **Calendar and reminders**: Schedule interviews, assessments, and deadlines with local notifications.
- **AI assistant**: Connect your chosen model, reference resumes and roles, assess resume fit, and generate practice exams. View context usage, compact conversations, or connect external AI tools through MCP.
- **Data backup**: Export and import complete backups of your records, settings, resumes, and chat attachments.

Supports Simplified Chinese and English, light and dark themes, the system tray, launch at startup, and in-app updates.

## Tech stack

| Area               | Technologies                                          | Role                                                               |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Desktop app        | Electron, TypeScript                                  | Main process, preload scripts, and Windows desktop integration     |
| User interface     | Vue 3, Naive UI, Pinia, Vue I18n                      | Views, components, state management, and localization              |
| Local data         | SQLite, better-sqlite3                                | Store applications and app data on the device                      |
| AI agent and tools | LangChain, LangGraph, MCP SDK                         | Agent workflows and external tool connections                      |
| Web access         | Playwright                                            | Browse company career pages and retrieve information               |
| Build and release  | electron-vite, Vite, electron-builder, Velopack, Rust | Build the app and handle Windows installation, launch, and updates |
| Testing            | Vitest, Node.js test runner, Playwright               | Unit tests and packaged desktop app tests                          |

## Screenshots

The screenshots show the current Chinese interface with sample data. Click an image to view it at full size.

| Application tracking                                                                            | Calendar                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [![Application tracking](docs/screenshots/applications.png)](docs/screenshots/applications.png) | [![Calendar](docs/screenshots/calendar.png)](docs/screenshots/calendar.png)               |
| Company management                                                                              | Job discovery (Beta)                                                                      |
| [![Company management](docs/screenshots/companies.png)](docs/screenshots/companies.png)         | [![Job discovery (Beta)](docs/screenshots/discovery.png)](docs/screenshots/discovery.png) |
| Industry categories                                                                             | Resume versions                                                                           |
| [![Industry categories](docs/screenshots/industries.png)](docs/screenshots/industries.png)      | [![Resume versions](docs/screenshots/resumes.png)](docs/screenshots/resumes.png)          |

**AI assistant**

[![AI assistant](docs/screenshots/assistant.png)](docs/screenshots/assistant.png)

## Download and get started

Download the Windows installer from [GitHub Releases](https://github.com/baozha2023/JobTrail/releases) and follow the prompts to install into an empty folder.

You can start managing applications right away. To use the AI assistant, enter your model service URL, model name, and API key in Settings. To connect an external AI tool, copy the corresponding MCP configuration from Settings. MCP is enabled by default and can be turned off in Settings.

Job discovery only enables platforms with a confirmed login. Login and expired-session prompts open the QR panel; website-verification prompts open a separate site window. After QR confirmation or the user closes the verification window, JobTrail checks the original query and resumes that platform when the check succeeds.

The built-in assistant also shows sign-in and verification cards in chat using the same recovery flow. QR dialogs close after official confirmation; close the official verification window yourself when finished. After recovery, the assistant reads the original search's latest results and continues your task, preserving your draft and attachments. External MCP clients should direct you to JobTrail to complete the manual step.

You can send another message while the assistant is running. Each chat can queue up to three messages, with viewing, editing and deletion available. Internal recovery notifications run first; pending questions, confirmations and uncertain submissions pause consumption. Queues survive page changes and Renderer reloads and are cleared when the app exits. v2.4.0 retains database v6 and configuration v2; upgrading from v2.3.0 requires no persistence migration.

Live discovery tools reuse an already running JobTrail client from the same installation. If none is running, MCP starts it in the system tray without taking focus. Local history queries do not require the desktop to run.

Dynamic web reading uses the installed **Microsoft Edge Stable**; the installer does not include a separate Playwright Chromium browser. Install Edge and keep it updated. If Edge cannot start, JobTrail reports the problem; local features and static web reading remain available. Automatic mode may return static content with an incomplete-result warning.

Job discovery pages use Electron's embedded Chromium.

Chromium handles job discovery using the system DNS, proxy/PAC, TLS and connection settings, without a custom proxy or public DNS fallback. Login, search and detail pages share an isolated browser session for each platform. See the [discovery specification](docs/job-discovery.md) for network boundaries and live-site validation limits.

Local reminders require the app to remain running. You can hide the window in the system tray.

### v2.3.0 guided tours

New and upgrading users receive an app navigation tour and a separate tour on their first visit to Job discovery. Both support previous/next, skipping, saved progress and restarting from Settings. The discovery tour explains account management without signing in or searching automatically. v2.3.0 finalizes database v6 and configuration v2. Upgrading from v2.2.0 uses formal `5 → 6` database and `1 → 2` configuration migrations; earlier releases follow the continuous migration chain. Existing data and settings are preserved, and full backups include tour progress.

## Data and privacy

JobTrail requires no application account and does not provide cloud sync. Application records, resumes, and chat history are stored locally. When you use the AI assistant, relevant conversations and selected content are sent to the model service you configure.

Recruitment-platform login sessions stay in the local browser profiles and are excluded from portable backups.

Export a complete backup from Settings and save it outside the installation folder. **Importing replaces your current data, and uninstalling clears the installation folder. Back up your data first.**

## Local development

Set up Windows, Node.js, pnpm, and Microsoft Edge Stable, then follow the [configuration guide](AGENTS.md) (in Chinese) to create a local `private-build.config.json`. Do not commit this file to Git. Keep the original build key when working with existing data.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Common commands:

| Command             | Purpose                     |
| ------------------- | --------------------------- |
| `pnpm typecheck`    | Check types                 |
| `pnpm test`         | Run tests                   |
| `pnpm format:check` | Check formatting            |
| `pnpm build`        | Build the app               |
| `pnpm release:win`  | Build the Windows installer |

Building the installer also requires Rust with the MSVC toolchain, Visual Studio C++ Build Tools, the .NET SDK, and the Velopack CLI. See the [development guidelines](AGENTS.md) (in Chinese) for development and release conventions.

## Project documentation

The following documents are in Chinese:

- [Development guidelines](AGENTS.md)
- [Job discovery](docs/job-discovery.md)
- [Database structure](docs/database.md)
- [Persistence upgrades](docs/persistence-upgrade-guide.md)
- [Diagnostics](docs/diagnostics.md)
- [Scripts and acceptance tests](scripts/README.md)

## License

[MIT License](LICENSE)
