> [!NOTE]
> **If you run into any issues, please feel free to message me on Discord: [scattrdblade](https://discord.com/users/678007540608532491)**
# File Uploader (Vencord)
This is a Vencord plugin that adds the `/fileshare` command. It allows you to upload files via the command to https://gofile.io/. After the files are uploaded, the gofile link containing the uploads is pasted into your Discord chatbox where you ran the command. This is essentially a quick way to share your files. Very convenient if your files are too big to upload on Discord.

If you want it not to be gofile exclusive and to have the ability to upload it to different file sharers like Mediafire, Firefile.cc, etc., then please message me and let me know on Discord: [scattrdblade](https://discord.com/users/678007540608532491)

## DOWNLOAD INSTRUCTIONS
You can either __clone__ the repository OR __manually download__ it as a zip file. (DO **NOT** DO BOTH) <br/>
> [!WARNING]
> Make sure you have the Vencord [developer build](https://github.com/Vendicated/Vencord/blob/main/docs/1_INSTALLING.md) installed.

Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.

**CLONING:**
1. If your terminal is set to `Vencord` (if it isn't, run `cd Vencord`), clone the repository by running 
```js
git clone https://github.com/ScattrdBlade/Vencord-fileUploader
```
2. Move the plugin folder (`Vencord-fileUploader`) from the `Vencord` folder into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/Vencord-fileUploader`
4. Run `pnpm build` and the plugin should be added.

**MANUAL DOWNLOAD**
1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/Vencord-fileUploader` or `src/userplugins/Vencord-fileUploader-main`
5. Run `pnpm build` and the plugin should be added.

### Credits
This is a completed and fixed version of [samu.lol](https://github.com/144reasons)'s test plugin.
