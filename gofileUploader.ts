/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, Argument, CommandContext, sendBotMessage } from "@api/Commands";
import { insertTextIntoChatInputBox } from "@utils/discord";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { DraftType } from "@webpack/common";

const UploadStore = findByPropsLazy("getUploads");

async function resolveFile(options: Argument[], ctx: CommandContext): Promise<File | null> {
    for (const opt of options) {
        if (opt.name === "file") {
            const upload = UploadStore.getUpload(ctx.channel.id, opt.name, DraftType.SlashCommand);
            return upload.item.file;
        }
    }
    return null;
}

export default definePlugin({
    name: "GofileUploader",
    description: "Upload files to gofile.io and share links in chat using `/fileshare`.",
    authors: [
        {
            name: "ScattrdBlade",
            id: 678007540608532491n,
        },
        {
            name: "samu.lol",
            id: 702973430449832038n,
        }
    ],
    dependencies: ["CommandsAPI"],
    target: "DESKTOP",
    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fileshare",
            description: "Upload a file to gofile.io and get the download link",
            options: [
                {
                    name: "file",
                    description: "The file to upload",
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    required: true,
                },
            ],
            execute: async (opts, cmdCtx) => {
                try {
                    const file = await resolveFile(opts, cmdCtx);
                    if (!file) throw "No file specified!";

                    const formData = new FormData();
                    formData.append("file", file);

                    const serverResponse = await fetch("https://api.gofile.io/getServer");
                    const serverData = await serverResponse.json();
                    const { server } = serverData.data;

                    const uploadResponse = await fetch(`https://${server}.gofile.io/uploadFile`, {
                        method: "POST",
                        body: formData,
                    });
                    const uploadResult = await uploadResponse.json();

                    if (uploadResult.status === "ok") {
                        const { downloadPage } = uploadResult.data;
                        setTimeout(() => insertTextIntoChatInputBox(`${downloadPage} `), 10); // Delay insertion to ensure slash command processing is complete
                        // sendBotMessage(cmdCtx.channel.id, { content: `File uploaded successfully: ${downloadPage}` });
                    } else {
                        console.error("Error uploading file:", uploadResult);
                        sendBotMessage(cmdCtx.channel.id, { content: "Error uploading file. Check the console for more info." });
                    }
                } catch (error) {
                    console.error("Error uploading file:", error);
                    sendBotMessage(cmdCtx.channel.id, { content: "Error uploading file. Check the console for more info." });
                }
            },
        },
    ],
});
