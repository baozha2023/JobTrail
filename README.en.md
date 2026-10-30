# JobTrail

[简体中文](README.md) | **English**

JobTrail is a local desktop app for managing your job search on Windows. Keep companies, job opportunities, resumes, application progress, and interview schedules in one place.

## Features

- **Application tracking**: Organize job details and application progress, with links to resumes and scheduled events.
- **Company management**: Find companies, browse career websites, manage multiple office locations and company natures, combine industry, nature and location filters, and save favorites.
- **Job discovery (Beta)**: Search BOSS, Liepin, Zhilian, 51job, Guopin, Shixiseng, Yupao, Nowcoder, and NCSS. Sign in with QR codes, filter salaries, rank results by relevance, browse job details and search history, and save jobs as applications.
- **Resume management**: Keep multiple resumes and track which one you used for each application.
- **Calendar and reminders**: Schedule interviews, assessments, and deadlines with local notifications.
- **AI assistant**: Connect your chosen model, reference resumes and roles, assess resume fit, and generate practice exams. View context usage, compact conversations, or connect external AI tools through MCP.
- **Data backup**: Export and import complete backups of your records, settings, resumes, and chat attachments.
- **Exam PDF export**: Export saved practice questions with answers and explanations below each question or at the end, including partially generated exams.

Supports Simplified Chinese and English, light and dark themes, the system tray, launch at startup, and in-app updates.

## Tech stack

| Area               | Technologies                                          | Role                                                               |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Desktop app        | Electron, TypeScript                                  | Main process, preload scripts, and Windows desktop integration     |
| User interface     | Vue 3, Naive UI, Pinia, Vue I18n                      | Views, components, state management, and localization              |
| Local data         | SQLite, better-sqlite3                                | Store applications and app data on the device                      |
| AI agent and tools | LangChain, LangGraph, MCP SDK                         | Agent workflows and external tool connections                      |
| Web reading        | Playwright                                            | Read dynamic web content on demand                                 |
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

Download the **Windows x64** installer from [GitHub Releases](https://github.com/baozha2023/JobTrail/releases) and follow the prompts to install into an empty folder.

The installer, uninstaller, and app on first launch use English on English-language Windows and Chinese otherwise. You can change the app language in Settings; subsequent launches keep your choice.

You can start managing applications right away. Guided tours introduce the app and job discovery on first use, and can be restarted from Settings.

- **Search for jobs**: Sign in to recruitment platforms with their official QR codes in account management, then enter a keyword and choose a location. Follow any sign-in or website-verification prompts to continue. Some platforms require another scan after restarting; search history and saved applications remain available.
- **Use the AI assistant**: Enter your model service URL, model name, and API key in Settings, then reference jobs, resumes, and other content in chat.
- **Connect external AI tools**: Copy the connection configuration from the MCP page in Settings. MCP is enabled by default and can be turned off; live job discovery starts JobTrail in the system tray when needed.

Dynamic web reading requires an installed, up-to-date **Microsoft Edge Stable**. Local reminders require the app to remain running; you can hide the window in the system tray.

## Data and privacy

JobTrail requires no application account and does not provide cloud sync. Application records, resumes, and chat history are stored locally. When you use the AI assistant, relevant conversations and selected content are sent to the model service you configure.

Recruitment-platform login sessions stay in the local browser profiles and are excluded from portable backups.

Export a complete backup from Settings and save it outside the installation folder. **Importing replaces your current data, and uninstalling clears the installation folder. Back up your data first.**

## Local development

Set up Windows, Node.js 22.19.0 or a newer LTS release, pnpm, and Microsoft Edge Stable, then follow the [configuration guide](AGENTS.md) (in Chinese) to create a local `private-build.config.json`. Do not commit this file to Git. Keep the original build key when working with existing data.

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
- [Logging system](docs/logging.md)
- [Scripts and acceptance tests](scripts/README.md)

## License

[MIT License](LICENSE)
