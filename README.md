**UPDATE: Major revamp with real-time progress bar, streaming uploads, and full ShareX compatibility**

-   **More file uploaders** - additional natively supported file uploaders
-   **New progress bar** - real-time upload progress with speed, ETA, percentage, and cancel button
-   **Streaming uploads** - faster file transfers with chunked streaming instead of loading entire file into memory
-   **Full ShareX support** - import `.sxcu` configs with POST/PUT/PATCH methods, binary uploads, and smart JSON response parsing
-   **Nitro-aware mode** - optionally let Discord handle files under your Nitro limit natively
-   **Drag & drop / paste** - intercept file uploads up to 1GB
-   **Video embedding** - auto-wrap video links with embeds.video for inline playback
-   **Better error handling** - detailed error messages with file context for easier debugging

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
