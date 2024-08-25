**UPDATE: Added `custom file uploader` option with the ability to import ShareX config files. Specific settings only show up depending on what file uploader service is selected. Default file uploader service is now set to Catbox (for new users only). Made file uploaders work without using a CORS proxy/bypass. Minor fixes and improvements.**

# Big File Upload (Vencord)
This is a Vencord plugin that allows you to bypass Discord's upload limit. It adds the `Upload a Big File` button (located under the regular upload button) and `/fileupload` command. This allows you to upload files to Discord by uploading them to uploaders such as gofile.io, catbox.moe, litterbox, or a custom uploader of your choice that allows you to import ShareX config files, and then pasting the link containing the upload into your Discord chatbox. This is essentially a quick way to upload big files to Discord without nitro.

## DOWNLOAD INSTRUCTIONS
You can either __clone__ the repository OR __manually install__ it by downloading it as a zip file.<br/>
> [!WARNING]
> Make sure you have the Vencord [developer build](https://docs.vencord.dev/installing/) installed.<br/>

### CLONE INSTALLATION
The cloning installation guide can be found [here](https://discord.com/channels/1015060230222131221/1257038407503446176/1257038407503446176) or via [the official Vencord Docs](https://docs.vencord.dev/installing/custom-plugins/).

### MANUAL INSTALLATION
> [!IMPORTANT]
> Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.
1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/bigFileUpload` or `src/userplugins/bigFileUpload-main`
5. Run `pnpm build` in the terminal (command prompt/CMD) and the plugin should be added.

> [!TIP]
> If you run into any issues, please feel free to message me on Discord: [scattrdblade](https://discord.com/users/678007540608532491)
