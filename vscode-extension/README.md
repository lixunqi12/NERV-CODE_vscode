# NERV CODE for VS Code

NERV CODE brings the NERV-CODE CLI into the VS Code secondary sidebar with a themed webview, model switching, session restart controls, permission prompts, and lightweight IDE context sharing.

## Special Thanks

This extension package is based on the original **NERV-CODE** project by **Ax1i1om**.

- Original repository: **[Ax1i1om/NERV-CODE](https://github.com/Ax1i1om/NERV-CODE)**

Special thanks to the original author for the original project and the NERV-themed implementation this packaging builds on.

## Requirements

This extension does not bundle the CLI. Install or build the NERV-CODE CLI separately, then use one of these launch modes:

- Put `nerv` on your `PATH` and keep `nerv-code.command` set to `nerv`.
- Or set `nerv-code.cliPath` to your local `dist/cli.js`.
- Optionally set `nerv-code.nodePath` if `node` is not available on `PATH`.

## Quick Start

1. Build or install the NERV-CODE CLI.
2. Open VS Code settings and configure one of:
   - `nerv-code.command`: `nerv`
   - `nerv-code.cliPath`: `/absolute/path/to/NERV-CODE/dist/cli.js`
3. Open the `NERV CODE` view in the secondary sidebar.

## Publishing Targets

Recommended registries:

- VS Code Marketplace for standard VS Code users.
- Open VSX for VSCodium and open registries.

## Privacy Checklist

- Publish under a brand or organization publisher instead of a personal account.
- Keep `repository`, `homepage`, and `bugs` unset until they point to an org-owned public repo.
- Never include real API keys, tokens, or personal machine paths in screenshots or default settings.
