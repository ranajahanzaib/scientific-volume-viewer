# Contributing

Contributions, bug reports, and focused improvement proposals are welcome.

## Development setup

Install the dependencies using the [README setup instructions](README.md#requirements), then create a feature branch:

```sh
git clone https://github.com/ranajahanzaib/scientific-volume-viewer.git
cd scientific-volume-viewer
git switch -c feature/short-description
```

Before opening a pull request, run the backend tests and frontend checks:

```sh
uv run pytest
pnpm typecheck
pnpm build
```

Include tests for behavior changes where practical. Describe the user-visible change, implementation approach, and any limitations in the pull request. Do not include datasets, credentials, generated telemetry, or dependency directories.

For security issues, follow the private reporting process in [SECURITY.md](.github/SECURITY.md). For community behavior, see the [Code of Conduct](CODE_OF_CONDUCT.md).
