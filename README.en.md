# JobTrail

[简体中文](README.md) | **English**

JobTrail is a local desktop app for managing your job search on Windows. Keep companies, job opportunities, resumes, application progress, and interview schedules in one place.

## Features

- **Application tracking**: Organize job details and application progress, with links to resumes and scheduled events.
- **Company management**: Find companies, browse career websites, filter by industry, and save favorites.
- **Resume management**: Keep multiple resumes and track which one you used for each application.
- **Calendar and reminders**: Schedule interviews, assessments, and deadlines with local notifications.
- **AI assistant**: Connect a model of your choice to discuss resumes and job opportunities, or connect external AI tools through MCP.
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

The screenshots show the Chinese interface with sample applications, events, and resumes. Click an image to view it at full size.

| Application tracking                                                                            | Calendar                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [![Application tracking](docs/screenshots/applications.png)](docs/screenshots/applications.png) | [![Calendar](docs/screenshots/calendar.png)](docs/screenshots/calendar.png)                |
| Company management                                                                              | Industry categories                                                                        |
| [![Company management](docs/screenshots/companies.png)](docs/screenshots/companies.png)         | [![Industry categories](docs/screenshots/industries.png)](docs/screenshots/industries.png) |
| Resume versions                                                                                 | AI assistant                                                                               |
| [![Resume versions](docs/screenshots/resumes.png)](docs/screenshots/resumes.png)                | [![AI assistant](docs/screenshots/assistant.png)](docs/screenshots/assistant.png)          |

## Download and get started

Download the Windows installer from [GitHub Releases](https://github.com/baozha2023/JobTrail/releases) and follow the prompts to install into an empty folder.

You can start managing applications right away. To use the AI assistant, enter your model service URL, model name, and API key in Settings. To connect an external AI tool, copy the corresponding MCP configuration from Settings. MCP is enabled by default and can be turned off in Settings.

Local reminders require the app to remain running. You can hide the window in the system tray.

## Data and privacy

JobTrail requires no account and does not provide cloud sync. Application records, resumes, and chat history are stored locally. When you use the AI assistant, relevant conversations and selected content are sent to the model service you configure.

Export a complete backup from Settings and save it outside the installation folder. **Importing replaces your current data, and uninstalling clears the installation folder. Back up your data first.**

## Local development

Set up Windows, Node.js, and pnpm, then follow the [configuration guide](CLAUDE.md) (in Chinese) to create a local `private-build.config.json`. Do not commit this file to Git. Keep the original build key when working with existing data.

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

Building the installer also requires Rust with the MSVC toolchain, Visual Studio C++ Build Tools, the .NET SDK, and the Velopack CLI. See the [development guidelines](CLAUDE.md) (in Chinese) for development and release conventions.

## Project documentation

The following documents are in Chinese:

- [Development guidelines](CLAUDE.md)
- [Database structure](docs/database.md)

## License

[MIT License](LICENSE)
