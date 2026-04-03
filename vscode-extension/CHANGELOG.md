# Changelog

All notable changes to the VS Code extension package are documented here.

## 1.0.0 - 2026-04-02

- Initial Marketplace-ready release of the NERV CODE VS Code sidebar.
- Added transparent NERV logo assets generated from the provided source image.
- Switched command and sidebar icons to packaged PNG assets compatible with VS Code Marketplace.
- Replaced machine-specific launch defaults with portable settings:
  `nerv-code.command`, `nerv-code.cliPath`, and `nerv-code.nodePath`.
- Reduced activation scope from `*` to command and view activation events.
- Added extension-local README, license, and packaging whitelist for cleaner VSIX output.
