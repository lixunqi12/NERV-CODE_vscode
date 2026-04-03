# Publish to VS Code Marketplace

This extension package is prepared for Marketplace packaging from this folder:

- [package.json](./package.json)
- [README.md](./README.md)
- [LICENSE.md](./LICENSE.md)
- [CHANGELOG.md](./CHANGELOG.md)

## 1. Create or verify the publisher

Use the Marketplace publisher management page to create a brand publisher, for example `nerv`.

Official page:

- https://marketplace.visualstudio.com/manage/publishers/

## 2. Create an Azure DevOps PAT

Create a Personal Access Token with the `Marketplace > Manage` scope.

Official docs:

- https://code.visualstudio.com/api/working-with-extensions/publishing-extension

## 3. Log in once

```powershell
npx @vscode/vsce login nerv
```

When prompted, paste the PAT.

## 4. Package locally

```powershell
npm run package
```

This creates:

- `nerv-code-1.0.0.vsix`

## 5. Publish

```powershell
npm run publish:marketplace
```

If you prefer not to store login state, you can also publish with an environment variable:

```powershell
$env:VSCE_PAT='YOUR_TOKEN'
npx @vscode/vsce publish --allow-missing-repository
```

## Notes

- The extension intentionally omits `repository` metadata so the Marketplace page does not point to a personal repo by default.
- The Marketplace icon is a PNG generated from the provided NERV logo source image.
- The extension activates only on its commands and sidebar view, not on global startup.
