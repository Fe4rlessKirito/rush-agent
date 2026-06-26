# Rush Agent Repository Instructions

## Release Rule

Every completed feature addition or bug fix must be published to GitHub with an incremented version number and clear release information.

Use semantic versioning:

- Patch version, such as `0.1.1`, for bug fixes and small safe changes.
- Minor version, such as `0.2.0`, for new features or meaningful behavior changes.
- Major version, such as `1.0.0`, only for breaking changes or a declared stable release.

Documentation-only changes do not need a release unless the user explicitly asks for one.

## Version Files

When bumping a version, keep these files in sync:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Prefer `npm version <version> --no-git-tag-version` for the Node files, then update the Tauri and Cargo versions to match.

## Required Checks

Before publishing a feature or bug fix:

1. Run the relevant tests or build checks for the change.
2. Run `npm run tauri build` before creating a release.
3. Confirm the Windows installer artifacts exist under `src-tauri/target/release/bundle/`.
4. Copy the installer artifacts into `releases/` with names that include the version.
5. Keep generated release artifacts out of git; `releases/` and Tauri build output are ignored.

## GitHub Publishing

For each shipped feature or bug fix:

1. Commit the source changes with a concise message.
2. Push the branch to GitHub.
3. Create and push an annotated tag named `v<version>`.
4. Create a GitHub Release for that tag.
5. Upload the installer assets, especially the NSIS `.exe` setup installer and MSI when available.
6. Include release notes that list what changed, the version number, and any known limitations.

Use the configured private repo remote:

```powershell
git push origin master
git push origin v<version>
gh release create v<version> releases\<installer-files> --title "Rush Agent v<version>" --notes "<release notes>"
```

## Current Release

The initial published release is `v0.1.0`.

Existing installer artifact naming:

- `Rush-Agent-v0.1.0-x64-setup.exe`
- `Rush-Agent-v0.1.0-x64.msi`
