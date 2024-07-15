> [!NOTE]
> **If you run into any issues, please feel free to message me on Discord: [scattrdblade](https://discord.com/users/678007540608532491)**
# File Share (Vencord)
This is a Vencord plugin that adds the `/fileshare` command. It allows you to upload files via the command to https://gofile.io/. After the files are uploaded, the gofile link containing the uploads is pasted into your Discord chatbox where you ran the command. This is essentially a quick way to share your files. Very convenient if your files are too big to upload on Discord.

## DOWNLOAD INSTRUCTIONS
You can either __clone__ the repository OR __manually download__ it as a zip file. (DO **NOT** DO BOTH) <br/>
> [!WARNING]
> Make sure you have the Vencord [developer build](https://github.com/Vendicated/Vencord/blob/main/docs/1_INSTALLING.md) installed.

Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.

**CLONING:**
1. Open up the terminal (command prompt/CMD) and run
```shell
cd Vencord/src/userplugins
```
then run
```js
git clone https://github.com/ScattrdBlade/fileShare
```
2. The plugin folder (`fileShare`) should now be in the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/fileShare`
4. Run `pnpm build` and the plugin should be added.

**MANUAL DOWNLOAD**
1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/fileShare` or `src/userplugins/fileShare-main`
5. Run `pnpm build` in the terminal (command prompt/CMD) and the plugin should be added.

### Credits
This is a completed and fixed version of [samu.lol](https://github.com/144reasons)'s test plugin.
