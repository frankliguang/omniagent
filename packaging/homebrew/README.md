# Homebrew Tap: homebrew-omniagent

Homebrew formula for installing OmniAgent CLI.

## Usage

```bash
# Tap this repo
brew tap omniagent/omniagent

# Install
brew install omniagent

# Update to latest
brew upgrade omniagent
```

## What it does

- Installs OmniAgent CLI (`omniagent` command) to `/opt/homebrew/bin/omniagent` (or `/usr/local/bin/omniagent` on Intel Macs)
- Depends on `node` formula for Node.js 20+ runtime
- Creates `~/.omniagent/{memory,logs,transcripts}` directories on post-install
- Verifies `omniagent --version` and `omniagent --help` work via `test do` block

## Manual formula update

When a new version is released:

1. Update the `version` field in `Formula/omniagent.rb`
2. Update the `url` to point to the new release tarball
3. Compute the SHA-256 of the tarball:
   ```bash
   shasum -a 256 omniagent-0.X.Y.tar.gz
   ```
4. Update the `sha256` field
5. Commit and push

Homebrew users will get the new version via `brew upgrade omniagent`.

## Local testing

```bash
# Test the formula locally before publishing
brew install --build-from-source ./Formula/omniagent.rb

# Or audit the formula
brew audit --strict ./Formula/omniagent.rb
```

## Cross-platform notes

- macOS arm64 + x86_64: fully supported
- Linux x86_64: works (no sandbox-exec, bubblewrap must be installed separately)
- Windows: not supported via Homebrew; use `npm install -g omniagent-cli` or WSL2

## Uninstall

```bash
brew uninstall omniagent
brew untap omniagent/omniagent
```
