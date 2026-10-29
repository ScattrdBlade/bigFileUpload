> [!TIP]
> **If you run into any issues, please let me know in the [Support Server](https://discord.gg/jHDJaW9Gyz)**

# Big File Upload (Vencord)

Bypass Discord's upload limit without Nitro. Big File Upload sends the files Discord would refuse to an external host (Catbox, GoFile, an S3 bucket, your own Zipline, WebDAV or ShareX server, and more) and pastes the link into chat. Everything else stays a normal attachment.

## Features

- **Upload** through Discord's upload button, drag & drop and paste, or right-click **Upload to \<host>** on media or media links. With **Bypass Discord Upload Button** off, `+` → **Upload to Host** is available for manual uploads.
- **17 hosts**, anonymous or your own. The maximum file size depends on the host (up to 8 GB per file on Desktop and Vesktop).
- **Fallback Hosts** when one fails. Your own servers never fall back to a public host by themselves.
- **Progress bar and queue**, with cancel.
- **Link options**, an **upload history** with Delete buttons, **APNG to GIF**, a **video embed proxy** and an optional **CORS proxy** for blocked hosts and Vencord Web.

## Supported Hosts

**No account needed:**

- Catbox.moe (default): 200 MB (GIFs 20 MB). Deleted after 2 years without access, unless uploaded with your userhash.
- Litterbox: 1 GB, kept 1 to 72 hours.
- 0x0.st (Desktop and Vesktop): 512 MB, kept 30 days to a year (less for bigger files) or shorter.
- tmpfiles.org: 100 MB, kept 1 to 48 hours.
- GoFile: deleted after about 10 days without downloads.
- buzzheavier.com
- temp.sh: 4 GB, kept 3 days.
- filebin.net: kept about 6 days.

**Need a key, token or your own server:** PixelDrain (10 GB, deleted after 60 days without downloads), Nest (45 MB), PixelVault (25 MB), Zipline, E-Z Host, Encrypting.host, S3-compatible (AWS S3, Cloudflare R2, MinIO…), WebDAV (Nextcloud, ownCloud or any WebDAV server) and ShareX/Custom Uploader.

Catbox and Litterbox refuse `.exe`, `.scr`, `.cpl`, `.jar` and Word documents. 0x0.st refuses `.exe` and `.jar`. The host picker shows each host's limits as a badge. Hosts can change their limits at any time.

## DOWNLOAD INSTRUCTIONS

You can either **git clone** the repository OR **manually install** it by downloading it as a zip file.

> [!WARNING]
> Make sure you have the Vencord [developer build](https://docs.vencord.dev/installing/) installed, built from the latest `main` (run `git pull` in your Vencord folder first). Older Vencord versions aren't supported.

> [!IMPORTANT]
> Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.

### GIT CLONE INSTALLATION

The full cloning installation guide can be found [here](https://discord.com/channels/1015060230222131221/1257038407503446176/1257038407503446176) or via [the official Vencord Docs](https://docs.vencord.dev/installing/custom-plugins/).

1. Direct your terminal (CMD/PowerShell) to the `userplugins` folder (`cd src/userplugins`).
2. Open the terminal and paste `git clone https://github.com/ScattrdBlade/bigFileUpload`
3. Ensure it's structured as `src/userplugins/bigFileUpload`
4. Run `pnpm build` in the terminal (CMD/PowerShell) and the plugin should be added.

### MANUAL INSTALLATION

1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/bigFileUpload`
4. Run `pnpm build` in the terminal (CMD/PowerShell) and the plugin should be added.

### AFTER INSTALLING OR UPDATING

- **Fully restart Discord or Vesktop** (quit it from the tray). Part of BigFileUpload runs in the app and loads only then. Until you do, BigFileUpload shows "native helper not loaded" and uploads fail.
- **Update every device that shares settings through Cloud Sync.** Older versions ignore Fallback Order's Inactive area, and a running device can overwrite changes made elsewhere, so check the list after syncing.

## Updating from an older version

Nothing you use is turned off: your Fallback Order and every host you set up stay active, and a notice lists those that need credentials with the server each sends to. Check that each is still yours. Hosts that need an account and that you never set up become inactive. Hosts that need no account stay active. A selected Zipline without URL or token, or PixelDrain without API key, is replaced by Catbox (its uploads already went to fallbacks), with a notice. New installs use Catbox.

## Where your files go

- **Upload Service** is tried first. **Fallback Order** lists the other hosts, each with a switch. Drag or use Alt+arrow keys to reorder. Hosts in **Inactive (never used)** are never contacted, even from the right-click menu. **Reset to default** turns on only hosts that need no account. Hosts that need an account start inactive. Turning one on shows its settings under **Fallback Hosts**, missing fields first.
- **Your own servers stay private.** If a selected Zipline, S3, WebDAV, custom uploader or Encrypting.host fails, files go automatically only to your other active private hosts (Zipline, S3, WebDAV), never to a public host or a custom uploader. With "Always ask before using another host", the dialog may offer a public host, and nothing is sent until you confirm.
- **When the Selected Host Fails**: "Use the next active host" (default, public hosts only when the selected host is public) or "Always ask before using another host". **Disable Fallback Hosts** uses only the selected host.
- A selected host that isn't set up stops automatic uploads. Discord keeps the file, with "Zipline isn't configured. Open BigFileUpload settings". With your own server or Encrypting.host selected, menu uploads send nothing either.
- Hosts that can't take a file (size, type) are skipped before sending, and a message names the host used instead, or why nothing was uploaded.
- **The first time BigFileUpload takes a file from Discord**, a dialog names the host and how long it keeps files: "Upload" sends, "Choose host" opens the settings. With **Respect Discord File Size Limit** off, there's no dialog: a notification is shown and the files are uploaded.

## When BigFileUpload takes a file

Under **Discord Integration**:

- **Bypass Discord Upload Button**, **Bypass Drag & Drop** and **Bypass Pasted Files** pick which paths to take over. The search box, message edits, bios and files you can't send in that chat are left to Discord.
- **Respect Discord File Size Limit** (on by default) takes only what Discord would refuse there (20 MB free, 50 MB Nitro Basic, 500 MB to 1 GB Nitro, boosts and the per-message total included). Under it, **Take Over Files Above (MB)** lowers that limit, and **Upload Whole Batch Externally** uploads a whole batch when some files are over.
- With it off, every file in a normal message box is taken. New forum posts and threads still only hand over files Discord would refuse. While **Skip Discord-Generated Files** is on (default), `message.txt`, text sent as a file and clip shares stay with Discord unless they're over the limit. Activity "Share moment" images always stay with Discord.
- **Allowed File Types**: extensions like `png,jpg,mp4`. `!` excludes one (`!exe,!zip`). Empty handles every file. A line under the field explains your entries.

**When Discord says a file is too large** (one BigFileUpload left alone), a notification offers help. Clicking it never uploads anything by itself, and it doesn't name the files.

- If your selected host isn't set up, it reads "BigFileUpload isn't set up", and clicking it opens BigFileUpload's settings.
- If the file's type is excluded under Allowed File Types, it reads "Upload with BigFileUpload?" and opens a dialog naming each file's host. Only its upload button uploads.

## Uploading from a message or the + menu

- **Right-click → Upload to \<host>** on an image, video, audio file or media link uploads the original, not Discord's preview. This includes embedded images, video previews and the media viewer. Media from other sites comes from Discord's full-size copy first (the site never sees you), then the site, then the CORS proxy. Desktop and Vesktop refuse links to your own network.
- If a video embed exposes only a provider player, the upload option explains that there's no direct link to the file.
- With **Bypass Discord Upload Button** on, use Discord's normal `+` upload button. With it off, **+ → Upload to Host** uploads a file you pick, or one already attached.
- Downloads from links show progress and stop early when a file is too big for every host.

## The link

Under **Upload Behavior**:

- **Insert URL into Chatbox** puts the link into the chat the file came from (or copies it, with a message, if you switched chats).
- **Send Immediately** (off by default) posts each link as its own message, for uploads started from a message box. Right-click uploads, new forum posts or threads, chats you can't send in and over-long links go into the box instead. Sent links never ping. If Discord refuses right away (slowmode, permissions), the link goes into the box or is copied. If Discord hasn't answered after 15 seconds, the message is left to Discord. If it fails later, a notification lets you copy the link. Nothing is sent twice.
- **Copy URL to Clipboard** copies it. Spoiler files are inserted as `||link||`. The copy stays plain.
- **Link as Filename** shows the file name as the link text. While it's off, **Prevent Discord Embeds** wraps links in `<>`.
- **Preserve Original Filename** keeps your file's name where the host allows it.
- **Strip Query Parameters**, with **Which Parameters**: "Tracking parameters only (utm\_\*, fbclid, si, …)" (default) or "All query parameters". Encrypting.host links are never changed, since their query carries the decryption key. With "Tracking parameters only", custom-uploader links aren't changed either, since their query can carry a token.
- **Convert APNG to GIF** (off by default) keeps loops and transparency (soft edges become hard). Files over 32 MB, or with oversized or too many frames, upload unconverted. Cancel stops at the next conversion step.

## Progress, queue and cancelling

- The progress bar (percentage, bytes, host, "Attempt 2/3") shows in the message box that started the upload.
- Files added meanwhile are queued and use your settings as they are at their turn. Click "+N queued" to see the waiting files with their sizes, and remove one with ×. **Cancel current** and **Cancel all** stop the running upload or everything.
- **Cancelling after the file was fully sent keeps the link:** BigFileUpload waits up to 30 seconds (**Stop waiting**), never posts it automatically, offers "Copy link", and lists it in the history as "cancelled after upload".

## Video links

Under **Upload Behavior**, **Video Embed Proxy** (on by default) wraps video links Discord can't embed, so they play inline. The wrapper sees the link and every viewer's IP address ([details](#the-cors-proxy-question)).

- **Embed Proxy Service**: "CORS Proxy" (the default, or autocompressor.net while the proxy isn't used for video links here), "autocompressor.net (AUTO-REZ Media Technologies)" or "x266.mov" (logs links with viewers' IP addresses for 30 days).
- **Skip When Discord Can Embed** (on by default) leaves small direct mp4, webm and mov links from Catbox, Litterbox, 0x0.st and similar plain, so Discord plays them itself. The setting shows the size limit.
- **Use My Proxy for Video Links** (off by default) uses your own proxy.
- **Also Wrap Private Host Links** (off by default) wraps Zipline, S3, WebDAV and custom-uploader links. Links without a file extension, Nextcloud and ownCloud share links and S3 links without a Public Base URL stay plain.
- Never wrapped: Encrypting.host links, links with a query, `#fragment` or user name, and links inserted with Prevent Discord Embeds.
- The service is checked from your device when you upload a video. If it's down, BigFileUpload tries the other services and says which one it used. If none is up, the link is posted plain. **Embed Service Status** shows its state, with **Check now**. When your connection comes back, failed checks are forgotten and the next video upload checks again.

## Settings that appear only when they apply

- A setting shows only while it does something, indented under the one that reveals it. Hidden settings keep their values and do nothing.
- Fallback hosts' options show under **Fallback Hosts** while that host is active and works on your platform, and hide while **Disable Fallback Hosts** is on.
- Text fields point out problems but save your text. A settings group that fails to load shows an error. The rest keep working.
- **Saved Credentials** (under Upload Service): credentials live in your Vencord settings, so exports and Cloud Sync include them. This lists those of unused hosts, each with **Clear**, which removes it on every synced device. Ones only your other devices can use read "Used on your other devices, not usable here".

## Upload history and deleting files

**Upload History**, at the bottom of the settings, lists your last 50 uploads on this device. It never syncs or goes into exports, since it holds links and delete keys.

- **Copy link**, **Remove from history** and **Clear history** leave the files on their hosts.
- **Delete from \<host>** (asks first) works for Catbox uploads made with your userhash, 0x0.st, PixelDrain, WebDAV, S3, and custom uploaders that return a deletion link. It uses your current credentials on the same server.
- When Delete can't run right now, the entry says why. Uploads to hosts that don't support deleting have no Delete button.
- A custom uploader's deletion link gets none of your config's headers or credentials, and never follows redirects.

## Host options

<details>
<summary><b>Catbox, Litterbox, tmpfiles.org and 0x0.st</b></summary>

- **Catbox Userhash**: uploads are kept, and deletable from the history.
- Litterbox: **Retention Window** (1, 12, 24 or 72 hours). A **File Name Length** of 16 characters makes links much harder to guess.
- tmpfiles.org: **Retention Window** (1 hour by default, or 6, 24 or 48 hours).
- 0x0.st: **Hard-to-Guess Links** (on by default) and **Delete After** (1 hour to 30 days).

</details>

<details>
<summary><b>GoFile</b></summary>

Without a **GoFile Token**, GoFile creates a guest account per upload. **Reuse One Guest Account** (on by default) reuses the first one, which links your anonymous uploads to each other. Its token stays on this device unless **Sync GoFile Guest Token Across Devices** is on (then it syncs and is exported). **Reset guest token** starts a new guest account. The token never goes through the CORS proxy.

</details>

<details>
<summary><b>Zipline</b></summary>

Before uploading to an https Zipline from Desktop or Vesktop, BigFileUpload asks it for its limits (once per session, without credentials). A file over its max size goes to your next host. With chunked uploads on and Zipline v4.8 or newer, big files go up in chunks, past reverse-proxy caps such as Cloudflare's 100 MB. http and Vencord Web upload in one piece without the check.

</details>

<details>
<summary><b>S3-compatible storage</b></summary>

- **Public Base URL** sets your links' address. Without it, links use the bucket's address, which needs anonymous reads. BigFileUpload checks once per bucket each session (never through the proxy) and warns.
- Cloudflare R2 needs a Public Base URL (r2.dev or a custom domain). Until then S3 is skipped.
- Files over 5 GB use multipart uploads (parts of at least 64 MB). On Vencord Web, so do files over the CORS proxy's limit (about 99 MB) sent through it. Multipart on Vencord Web needs `ExposeHeaders: ETag` and `DELETE` in the bucket's CORS rules. Also add a lifecycle rule that aborts incomplete multipart uploads after a day.
- **Sign Payload** hashes files for servers that refuse unsigned uploads. A wrong clock or region is corrected for the session.
- Bucket names with dots need **Use Path-Style Endpoint** over https.

</details>

<details>
<summary><b>WebDAV</b></summary>

File names are made unique, so nothing is overwritten. **Server Type** "Nextcloud" or "ownCloud" creates a share link in your **Share Link Format** (Share Page, Direct Download or Markdown Link). "Generic WebDAV", or any **Server URL** without `/remote.php/`, posts the file's own address. If the share link fails, nothing is posted and no other host is tried. The file's own link, which needs your WebDAV login, is kept in Upload History, and a notification lets you copy it or delete the file. A public share may already exist, so check the server's Shares list before trying again.

</details>

<details>
<summary><b>ShareX/Custom Uploader template syntax</b></summary>

Paste or import a `.sxcu` file, or use **Form View**. The body must be Multipart Form Data or Binary.

- Supported: `{json:…}`, `{regex:…}`, `{xml:…}`, `{header:…}`, `{response}`, `{responseurl}`, `{filename}`, `{random:a|b}` and `{base64:…}`, nested, with `\` escapes (so a regex needs `\\d` for `\d`). Older `$json:…$` and `RegexList` configs work.
- Refused: ShareX window functions (`{inputbox}`, `{prompt}`, `{select}`, `{outputbox}`, `{input}`), `{random}` in the Request URL and functions before the address's path.
- A `{regex:…}` gets one second, its pattern can be up to 1,000 characters and only the first 256 KiB of the answer is searched. Each field gets about five seconds in all. Clients that block blob workers can't use `{regex:…}`.
- On Vencord Web, `{header:…}` sees only headers exposed to discord.com. File-name patterns (`%y`, `%rn`) aren't expanded.

</details>

<details>
<summary><b>Encrypting.host</b></summary>

**Domains JSON**: blank means `["normal"]` (which still includes edgy names such as hatecri.me). The others are `["offensive"]`, `["sad"]`, `["weeb"]`, or `[""]` for all. **URL Style** "Zero-width (zws)" hides the decryption key in invisible characters. The Embed, Zero-width and Fake Link styles add **Embed Title**, **Embed Color** or **Fake Link**.

</details>

## Big files and your own servers

- **Desktop and Vesktop** copy files over 4 MB to a private temporary file ("Preparing… x%") to keep memory use flat. It needs free disk space and is removed afterwards.
- Plain `http://` works only for servers on your own network (192.168.x.x, 10.x.x.x, Tailscale's 100.x.x.x addresses, `.local` names and the like). Tailscale MagicDNS names (`*.ts.net`) don't count. **Allow Insecure HTTP**, under the server's address in its host settings, allows one public http Zipline, WebDAV or custom-uploader address on this device (Desktop and Vesktop). Vencord Web can't use http servers.
- **Desktop and Vesktop** ask before the first upload or deletion on one of your own servers (Zipline, S3, WebDAV, custom uploader or your own proxy). **Trust** remembers it on this device. **Allow until restart** allows it until Discord restarts. **Cancel** stops it. Built-in hosts never ask, and synced or imported settings can't approve a server. **Approved Servers**, under **Upload Service**, lists trusted servers. **Reset Approved Servers** forgets them all.

## Network

- **Use CORS Proxy** and **CORS Proxy** (keircn's default proxy or **Your own proxy (self-hosted)…**): see [below](#the-cors-proxy-question). An address that can't be used turns the proxy off, with the reason, and is never replaced by the default. Changing it asks first when credentials would pass through.
- **Upload Timeout** (1 minute by default, 30 seconds to 10 minutes) moves on to the next host after that long without progress.

<details>
<summary><b>Retry rules</b></summary>

- A rate limit, a server error or a connection that failed before sending gets one retry on the same host. A host that just failed is tried last for 5 minutes.
- **Blocked hosts** (Desktop and Vesktop, proxy accepted) get one retry through the proxy, without optional credentials. For hosts that need a login, and your own servers, a notification says "\<host> is blocked on this network". Click it to choose, with "Always for \<host> on this device". **Always-Retry Choices** lists those choices and your servers seen on your network, with **Remove** and **Forget all** (this device only).

</details>

## Conflicting plugins

FileUpload, AutoZipper and Encryptcord take the same uploads. BigFileUpload warns at every start while one is enabled. AddAttachments works alongside it.

## Troubleshooting

- **"BigFileUpload: native helper not loaded" at start, and uploads fail:** Rebuild Vencord (`pnpm build`) and fully restart Discord or Vesktop from the tray. A reload isn't enough.
- **Files over 1.9 GB are left to Discord after updating:** Fully restart Discord or Vesktop to finish the update.
- **Discord's UI crashes when BigFileUpload shows a notification:** Your Vencord is too old. Update it to v1.15.12 or newer and rebuild.
- **Big files stay with Discord and a notice says your host isn't configured:** Open BigFileUpload's settings and fill in what your **Upload Service** is missing, or pick another host.
- **"No configured host accepts" a file:** It is over every active host's size limit or type rules. Turn on a host that takes it under **Fallback Order**, or set up S3, WebDAV or a custom uploader.
- **A host fails on your network but works elsewhere:** Your network may block it. On Desktop and Vesktop, choose **Use the proxy** when BigFileUpload asks at start-up, or turn on **Use CORS Proxy** under **Network**. Blocked hosts are then retried through it.
- **"http is only allowed for LAN hosts":** Use https, or turn on **Allow Insecure HTTP** under that server's address in its host settings (Desktop and Vesktop). **Network** lists the servers you allowed, with **Remove**.
- **"Part of its Discord integration failed (Discord update?)" or "upload interception appears broken (Discord update?)":** A Discord update broke one of BigFileUpload's hooks. With the second one, Discord's own size limits are back on. Update BigFileUpload, rebuild and fully restart. If it stays, [report a bug](#reporting-bugs).
- **Uploads behave oddly or are taken twice:** Turn off FileUpload, AutoZipper or Encryptcord. They take the same uploads.

## Reporting bugs

1. **Update first:** rebuild Vencord (`pnpm build`) and fully restart Discord.
2. **Reproduce the problem**, then copy the console lines (Ctrl+Shift+I → Console, filter `BigFileUpload`).
3. **Open an issue** at https://github.com/ScattrdBlade/bigFileUpload/issues saying what you did, expected and got, with those lines. Remove any tokens or private links first.

## The CORS-proxy question

BigFileUpload asks once per device whether to use a CORS proxy: at the first start of a new install or of the update that added the question, and again after you re-enable it.

**What the proxy does**

- **Desktop and Vesktop:** uploads go straight to the host. When your network blocks one (ISP, router, VPN or firewall, including HTTP 451 and "Access denied" pages), the upload is retried once through the proxy before the next host. After a retry past a definite block works, login-free uploads to that host use the proxy directly for 10 minutes. Uploads over its limit (about 99 MB for the default proxy) never use it. A failed direct download from a link is retried through it too (no size limit, and never Discord's own media links), so it sees that file.
- **Declined on Desktop and Vesktop:** the proxy is never used. A blocked host fails like any other ([Where your files go](#where-your-files-go)).
- **Vencord Web:** your browser blocks uploads from discord.com to most hosts, and the proxy relays them. Files over its limit can't use it, except to S3, which then sends parts that fit. Without it, only Litterbox, GoFile, filebin.net and your own servers that allow discord.com work. Catbox, tmpfiles.org, buzzheavier.com, temp.sh, E-Z Host, Nest, Encrypting.host, PixelVault and PixelDrain don't.
- **Declined on Vencord Web:** hosts that need the proxy are skipped, active fallback hosts that accept discord.com are used, and your own servers are tried directly. If fallbacks are disabled or none accepts discord.com, files over Discord's limit stay with Discord unless your upload host takes them. Encrypting.host files stay with Discord unless an active private host takes them. When your upload host needs the proxy, the pop-up says what declining does.

**What it can see**

- Every file it relays. The default proxy doesn't hide your IP address from the host. One from the [self-host guide](SELF-HOSTING.md) does.
- **Desktop and Vesktop:** a proxied retry leaves out optional credentials (Catbox userhash, GoFile token), so the upload is anonymous and can't be deleted from your account. Hosts that need credentials (tokens, passwords, WebDAV login, S3 signatures) and your private hosts ask first, at most once per host each session. Ticking "Always for \<host> on this device" can be undone under **Network** → **Always-Retry Choices**. Hosts on your own network, including names ever seen on a private address, never use the proxy. Whoever controls your network (public Wi-Fi, say) can make a host look blocked and trigger the retry.
- **Vencord Web:** "Use the proxy" lets the credentials of hosts that use it pass it (tokens, passwords, WebDAV login, Catbox userhash, S3 signatures), and it sees files from links whose direct download failed.

**The default proxy**

`cors.keiran0.workers.dev` is run by keircn on Cloudflare. Its code is at [codeberg.org/key/corsproxy](https://codeberg.org/key/corsproxy), but BigFileUpload can't check that the running proxy uses it, and there's no privacy or logging policy. It takes uploads up to about 99 MB (Cloudflare's 100 MB cap, less buffering) and can go down. To avoid a third party, [run your own](SELF-HOSTING.md).

**Video links**

With **Video Embed Proxy** on and **Embed Proxy Service** set to "CORS Proxy" (the default), the proxy also wraps video links Discord can't embed. Whoever opens one goes through the proxy, which sees the link and their IP address. Discord fetches the preview through it too. A wrapped link breaks if the proxy goes down.

- If you decline, video links go through autocompressor.net while it's up (AUTO-REZ Media Technologies). Its page loads Google ads, so Google also gets the link and viewers' IP addresses. If autocompressor.net is definitely down, x266.mov is tried next. It logs links with viewers' IP addresses for 30 days.
- The service is checked from your IP address when you upload a video, which lets it connect you to the link. A definite failure can switch to another eligible service. If no service is available, or its status is uncertain, the link is posted plain.
- Your own proxy wraps video links only with **Use My Proxy for Video Links** on for it, and never when it isn't reachable from the internet (plain http, a local name or a private address). Until then autocompressor.net and x266.mov are used as above, whatever you answer. With it on, your proxy's address is in every video link, and anyone can use it and spend its quota.
- Turn off Video Embed Proxy for plain links.

**Cloud Sync and other devices**

"Don't use it" turns the proxy off on your other devices too. "Use the proxy" never turns it on for a device that declined. One that wasn't using it asks first.

**When it asks again**

- At the next start if you closed the pop-up without choosing. Until then, blocked hosts aren't retried through the proxy (Desktop) and no host credentials go through it (Vencord Web).
- At the next start after you re-enable BigFileUpload, and when the accepted proxy is changed on another device.

To change your answer later, turn **Use CORS Proxy** on or off under BigFileUpload → **Network**. That counts as your answer on this device.

## Self-hosting the CORS proxy

To run your own proxy instead of the default one, follow [SELF-HOSTING.md](SELF-HOSTING.md).
