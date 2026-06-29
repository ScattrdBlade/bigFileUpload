**UPDATE: Major overhaul**

- **New upload services** - PixelDrain, Zipline, E-Z Host, Nest, Encrypting.host, S3-compatible, PixelVault, and WebDAV.
- **Bypass Discord's upload button** - Intercept the native upload button.
- **APNG → GIF** - Optionally convert animated PNGs to GIF on upload.
- **Quality-of-life** - Auto-copy the URL, preserve original filenames, and strip query parameters.

> [!TIP]
> **If you run into any issues, please let me know on [Discord](https://discord.gg/jHDJaW9Gyz)**

# Big File Upload (Vencord)

Bypass Discord's upload limit without Nitro. Big File Upload sends your files to an external host — Catbox, GoFile, an S3 bucket, your own WebDAV or ShareX-compatible server, and more — then pastes the resulting link straight into chat.

You can upload in several ways: the `Upload to Host` option in the `+` attachment menu, a right-click `Upload to <host>` entry on any image, video, or link, or by letting it transparently take over Discord's own upload button, drag & drop, and clipboard paste. A live progress bar shows the percentage, bytes transferred, and current host, with a cancel button.

If a host fails, it automatically falls back to the next one (no-key hosts first by default), so an upload almost always lands. Enable Nitro-aware mode to let Discord handle anything under your current upload limit and only bypass for larger files. The maximum file size depends on the host you choose. Extras include converting APNG to GIF, preserving original filenames, auto-copying the link, stripping query parameters, and an optional embed proxy for inline video previews.

## Supported Uploaders

**No account or API key required** (work anonymously):

- Catbox.moe
- Litterbox
- 0x0.st _(desktop only)_
- tmpfiles.org
- GoFile
- buzzheavier.com
- temp.sh
- filebin.net
- PixelDrain

**Require a token / API key / credentials:**

- Zipline
- E-Z Host
- Nest
- Encrypting.host
- S3-compatible (AWS S3, Cloudflare R2, MinIO, etc.)
- PixelVault
- ShareX Custom Uploader
- WebDAV (Nextcloud / ownCloud)

## DOWNLOAD INSTRUCTIONS

You can either **git clone** the repository OR **manually install** it by downloading it as a zip file.

> [!WARNING]
> Make sure you have the Vencord [developer build](https://docs.vencord.dev/installing/) installed.

> [!IMPORTANT]
> Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.

### GIT CLONE INSTALLATION

The full cloning installation guide can be found [here](https://discord.com/channels/1015060230222131221/1257038407503446176/1257038407503446176) or via [the official Vencord Docs](https://docs.vencord.dev/installing/custom-plugins/).

1. Direct your terminal (command prompt/CMD) to the `userplugins` folder, e.g. `cd src/userplugins`.
2. Open the terminal and paste `git clone https://github.com/ScattrdBlade/bigFileUpload`
3. Ensure it's structured as `src/userplugins/bigFileUpload` or `src/userplugins/bigFileUpload-main`
4. Run `pnpm build` in the terminal (command prompt/CMD) and the plugin should be added.

### MANUAL INSTALLATION

1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/bigFileUpload` or `src/userplugins/bigFileUpload-main`
4. Run `pnpm build` in the terminal (command prompt/CMD) and the plugin should be added.
