**UPDATE: New uploading method that increases upload speed and success, as well as letting users set timeout length and providing more detailed errors and logging**

> [!TIP]
> **If you run into any issues, please let me know on [Discord](https://discord.gg/jHDJaW9Gyz)**

# Big File Upload (Vencord)
This is a Vencord plugin that allows you to bypass Discord's upload limit. It adds the `Upload a Big File` button (located under the regular upload button) and `/fileupload` command. This allows you to upload files to Discord by uploading them to uploaders such as gofile.io, catbox.moe, litterbox, or a custom uploader of your choice that allows you to import ShareX config files, and then automatically pasting the link containing the upload into your Discord chatbox. This is essentially a quick way to upload big files to Discord without nitro.

## DOWNLOAD INSTRUCTIONS
You can either __git clone__ the repository OR __manually install__ it by downloading it as a zip file.<br/>
> [!WARNING]
> Make sure you have the Vencord [developer build](https://docs.vencord.dev/installing/) installed.<br/>

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
5. Run `pnpm build` in the terminal (command prompt/CMD) and the plugin should be added.
