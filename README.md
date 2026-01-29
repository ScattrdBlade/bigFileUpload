**UPDATE: Multiple embed services, fallback controls, and bug fixes**

-   **Multiple embed services** - choose from embeddr.top (default), x266.mov, discord.nfp.is, or stolen.shoes for video embedding (and removed videos.embed as it is deprecated)
-   **Disable fallbacks** - new option to only use your selected uploader without automatic fallbacks
-   **Bug fixes** - fixed progress bar display issues, upload tracking, and various edge cases
-   **Code cleanup** - refactored styles to use CSS classes

> [!TIP]
> **If you run into any issues, please let me know on [Discord](https://discord.gg/jHDJaW9Gyz)**

# Big File Upload (Vencord)

Bypass Discord's upload limit without Nitro. This plugin adds an `Upload a Big File` button that uploads your files to external hosting services (Catbox, Gofile, etc. or any ShareX-compatible custom uploader) and pastes the link into chat.

Features a real-time progress bar with upload speed, ETA, and cancel button. Supports drag & drop and paste for files up to 1GB, with unlimited file size via the Upload button. Optionally respects your Nitro limit so Discord handles smaller files natively.

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
