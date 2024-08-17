/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, Argument, CommandContext, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { OpenExternalIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { DraftType, Menu, PermissionsBits, PermissionStore, SelectedChannelStore, showToast, UploadManager } from "@webpack/common";

const UploadStore = findByPropsLazy("getUploads");
const OptionClasses = findByPropsLazy("optionName", "optionIcon", "optionLabel");

// Define the settings for the plugin
const settings = definePluginSettings({
    fileUploader: {
        description: "Select the file uploader service",
        type: OptionType.SELECT,
        options: [
            { label: "GoFile", value: "GoFile", default: true },
            { label: "Catbox", value: "Catbox" },
            { label: "Litterbox", value: "Litterbox" },
        ],
        restartNeeded: false,
    },
    catboxUserHash: {
        description: "Catbox.moe user hash (optional)",
        type: OptionType.STRING,
        default: "",
    },
    litterboxTime: {
        description: "Litterbox file expiration time",
        type: OptionType.SELECT,
        options: [
            { label: "1 hour", value: "1h", default: true },
            { label: "12 hours", value: "12h" },
            { label: "24 hours", value: "24h" },
            { label: "72 hours", value: "72h" },
        ],
        restartNeeded: false,
    },
});

async function resolveFile(options: Argument[], ctx: CommandContext): Promise<File | null> {
    for (const opt of options) {
        if (opt.name === "file") {
            const upload = UploadStore.getUpload(ctx.channel.id, opt.name, DraftType.SlashCommand);
            return upload.item.file;
        }
    }
    return null;
}

async function uploadFileToGofile(file: File, channelId: string) {
    try {
        const formData = new FormData();
        formData.append("file", file);

        const serverResponse = await fetch("https://api.gofile.io/servers");
        const serverData = await serverResponse.json();
        const server = serverData.data.servers[Math.floor(Math.random() * serverData.data.servers.length)].name;

        const uploadResponse = await fetch(`https://${server}.gofile.io/uploadFile`, {
            method: "POST",
            body: formData,
        });
        const uploadResult = await uploadResponse.json();

        if (uploadResult.status === "ok") {
            const { downloadPage } = uploadResult.data;
            setTimeout(() => insertTextIntoChatInputBox(`${downloadPage} `), 10);
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        } else {
            console.error("Error uploading file:", uploadResult);
            sendBotMessage(channelId, { content: "Error uploading file. Check the console for more info." });
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        }
    } catch (error) {
        console.error("Error uploading file:", error);
        sendBotMessage(channelId, { content: "Error uploading file. Check the console for more info." });
        UploadManager.clearAll(channelId, DraftType.SlashCommand);
    }
}

async function uploadFileToCatbox(file: File, channelId: string) {
    try {
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        formData.append("fileToUpload", file);

        const userHash = settings.store.catboxUserHash;
        if (userHash) {
            formData.append("userhash", userHash);
        }

        const uploadResponse = await fetch("https://any.corsbypass-f43.workers.dev/?https://catbox.moe/user/api.php", {
            method: "POST",
            body: formData,
        });
        const uploadResult = await uploadResponse.text();

        if (uploadResult.startsWith("https://")) {
            setTimeout(() => insertTextIntoChatInputBox(`${uploadResult} `), 10);
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        } else {
            console.error("Error uploading file:", uploadResult);
            sendBotMessage(channelId, { content: "Error uploading file. Check the console for more info." });
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        }
    } catch (error) {
        console.error("Error uploading file:", error);
        sendBotMessage(channelId, { content: "Error uploading file. Check the console for more info." });
        UploadManager.clearAll(channelId, DraftType.SlashCommand);
    }
}

async function uploadFileToLitterbox(file: File, channelId: string) {
    try {
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        formData.append("fileToUpload", file);
        formData.append("time", settings.store.litterboxTime);

        const uploadResponse = await fetch("https://any.corsbypass-f43.workers.dev/?https://litterbox.catbox.moe/resources/internals/api.php", {
            method: "POST",
            body: formData,
        });
        const uploadResult = await uploadResponse.text();

        if (uploadResult.startsWith("https://")) {
            setTimeout(() => insertTextIntoChatInputBox(`${uploadResult}`), 10);
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        } else {
            console.error("Error uploading file:", uploadResult);
            sendBotMessage(channelId, { content: "Error uploading file. Check the console for more info." });
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        }
    } catch (error) {
        console.error("Error uploading file:", error);
        sendBotMessage(channelId, { content: "Error uploading file. Check the console for more info." });
        UploadManager.clearAll(channelId, DraftType.SlashCommand);
    }
}

async function uploadFile(file: File, channelId: string) {
    const uploader = settings.store.fileUploader;
    switch (uploader) {
        case "GoFile":
            await uploadFileToGofile(file, channelId);
            break;
        case "Catbox":
            await uploadFileToCatbox(file, channelId);
            break;
        case "Litterbox":
            await uploadFileToLitterbox(file, channelId);
            break;
        default:
            console.error("Unknown uploader:", uploader);
            sendBotMessage(channelId, { content: "Error: Unknown uploader selected." });
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
    }
}

function triggerFileUpload() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";

    fileInput.onchange = async event => {
        const target = event.target as HTMLInputElement;
        if (target && target.files && target.files.length > 0) {
            const file = target.files[0];
            if (file) {
                const channelId = SelectedChannelStore.getChannelId();
                await uploadFile(file, channelId);
            } else {
                showToast("No file selected");
            }
        }
    };

    document.body.appendChild(fileInput);
    fileInput.click();
    document.body.removeChild(fileInput);
}

const ctxMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (props.channel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, props.channel)) return;

    children.splice(1, 0,
        <Menu.MenuItem
            id="upload-big-file"
            label={
                <div className={OptionClasses.optionLabel}>
                    <OpenExternalIcon className={OptionClasses.optionIcon} height={24} width={24} />
                    <div className={OptionClasses.optionName}>Upload a Big File</div>
                </div>
            }
            action={triggerFileUpload}
        />
    );
};

export default definePlugin({
    name: "BigFileUpload",
    description: "Bypass Discord's upload limit by uploading files using /fileupload or the 'Upload a Big File' button and they'll get uploaded as GoFile, Catbox.moe, or Litterbox links in chat.",
    authors: [Devs.ScattrdBlade],
    settings,
    dependencies: ["CommandsAPI"],
    contextMenus: {
        "channel-attach": ctxMenuPatch,
    },
    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fileupload",
            description: "Upload a file to Discord",
            options: [
                {
                    name: "file",
                    description: "The file to upload",
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    required: true,
                },
            ],
            execute: async (opts, cmdCtx) => {
                const file = await resolveFile(opts, cmdCtx);
                if (file) {
                    await uploadFile(file, cmdCtx.channel.id);
                } else {
                    sendBotMessage(cmdCtx.channel.id, { content: "No file specified!" });
                    UploadManager.clearAll(cmdCtx.channel.id, DraftType.SlashCommand);
                }
            },
        },
    ],
});
