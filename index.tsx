/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { OpenExternalIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, DraftType, Forms, Menu, PermissionsBits, PermissionStore, React, Select, SelectedChannelStore, showToast, Switch, TextInput, Toasts, UploadManager, useEffect, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.BigFileUpload as PluginNative<typeof import("./native")>;

const UploadStore = findByPropsLazy("getUploads");
const OptionClasses = findByPropsLazy("optionName", "optionIcon", "optionLabel");

function createCloneableStore(initialState: any) {
    const store = { ...initialState };
    const listeners: (() => void)[] = [];

    function get() {
        return { ...store };
    }

    function set(newState: Partial<typeof store>) {
        Object.assign(store, newState);
        listeners.forEach(listener => listener());
    }

    function subscribe(listener: () => void) {
        listeners.push(listener);
        return () => {
            const index = listeners.indexOf(listener);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        };
    }

    return {
        get,
        set,
        subscribe
    };
}

// Helper function to safely get error messages
function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return String(error);
}

function sendTextToChat(text: string) {
    if (settings.store.autoSend === "No") {
        insertTextIntoChatInputBox(text);
    } else {
        const channelId = SelectedChannelStore.getChannelId();
        sendMessage(channelId, { content: text });
    }
}

function SettingsComponent(props: { setValue(v: any): void; }) {
    const initialUploader = settings.store.fileUploader || "Catbox";
    const [fileUploader, setFileUploader] = useState(initialUploader);
    const [customUploaderStore] = useState(() => createCloneableStore({
        name: settings.store.customUploaderName || "",
        requestURL: settings.store.customUploaderRequestURL || "",
        fileFormName: settings.store.customUploaderFileFormName || "",
        responseType: settings.store.customUploaderResponseType || "",
        url: settings.store.customUploaderURL || "",
        thumbnailURL: settings.store.customUploaderThumbnailURL || "",
        headers: (() => {
            const parsedHeaders = JSON.parse(settings.store.customUploaderHeaders || "{}");
            if (Object.keys(parsedHeaders).length === 0) {
                parsedHeaders[""] = "";
            }
            return parsedHeaders;
        })(),
        args: (() => {
            const parsedArgs = JSON.parse(settings.store.customUploaderArgs || "{}");
            if (Object.keys(parsedArgs).length === 0) {
                parsedArgs[""] = "";
            }
            return parsedArgs;
        })(),
    }));

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!settings.store.fileUploader || settings.store.fileUploader.trim() === "") {
            updateSetting("fileUploader", "Catbox");
        }

        const unsubscribe = customUploaderStore.subscribe(() => {
            const state = customUploaderStore.get();
            updateSetting("customUploaderName", state.name);
            updateSetting("customUploaderRequestURL", state.requestURL);
            updateSetting("customUploaderFileFormName", state.fileFormName);
            updateSetting("customUploaderResponseType", state.responseType);
            updateSetting("customUploaderURL", state.url);
            updateSetting("customUploaderThumbnailURL", state.thumbnailURL);
            updateSetting("customUploaderHeaders", JSON.stringify(state.headers));
            updateSetting("customUploaderArgs", JSON.stringify(state.args));
        });

        return unsubscribe;
    }, []);

    function updateSetting(key: keyof typeof settings.store, value: any) {
        if (key in settings.store) {
            (settings.store as any)[key] = value;
        } else {
            console.error(`Invalid setting key: ${key}`);
        }
    }

    function handleShareXConfigUpload(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e: ProgressEvent<FileReader>) => {
                try {
                    const config = JSON.parse(e.target?.result as string);

                    customUploaderStore.set({
                        name: "",
                        requestURL: "",
                        fileFormName: "",
                        responseType: "Text",
                        url: "",
                        thumbnailURL: "",
                        headers: { "": "" },
                        args: { "": "" }
                    });

                    customUploaderStore.set({
                        name: config.Name || "",
                        requestURL: config.RequestURL || "",
                        fileFormName: config.FileFormName || "",
                        responseType: config.ResponseType || "Text",
                        url: config.URL || "",
                        thumbnailURL: config.ThumbnailURL || "",
                        headers: config.Headers || { "": "" },
                        args: config.Arguments || { "": "" }
                    });

                    updateSetting("customUploaderName", config.Name || "");
                    updateSetting("customUploaderRequestURL", config.RequestURL || "");
                    updateSetting("customUploaderFileFormName", config.FileFormName || "");
                    updateSetting("customUploaderResponseType", config.ResponseType || "Text");
                    updateSetting("customUploaderURL", config.URL || "");
                    updateSetting("customUploaderThumbnailURL", config.ThumbnailURL || "");
                    updateSetting("customUploaderHeaders", JSON.stringify(config.Headers || { "": "" }));
                    updateSetting("customUploaderArgs", JSON.stringify(config.Arguments || { "": "" }));

                    setFileUploader("Custom");
                    updateSetting("fileUploader", "Custom");

                    showToast("ShareX config imported successfully!");
                } catch (error) {
                    console.error("Error parsing ShareX config:", error);
                    showToast("Error importing ShareX config. Check console for details.");
                }
            };
            reader.readAsText(file);

            event.target.value = "";
        }
    }

    const validateCustomUploaderSettings = () => {
        if (fileUploader === "Custom") {
            if (!settings.store.customUploaderRequestURL || settings.store.customUploaderRequestURL.trim() === "") {
                showToast("Custom uploader request URL is required.");
                return false;
            }
            if (!settings.store.customUploaderFileFormName || settings.store.customUploaderFileFormName.trim() === "") {
                showToast("Custom uploader file form name is required.");
                return false;
            }
            if (!settings.store.customUploaderURL || settings.store.customUploaderURL.trim() === "") {
                showToast("Custom uploader URL (JSON path) is required.");
                return false;
            }
            // Check for placeholder values that shouldn't be there
            if (settings.store.customUploaderURL.includes("$json:") || settings.store.customUploaderURL.includes("$")) {
                showToast("Please replace placeholder values in custom uploader URL field.");
                return false;
            }
        }
        return true;
    };

    const handleFileUploaderChange = (v: string) => {
        if (!v || v.trim() === "") {
            console.warn("Attempted to select empty uploader, keeping current selection");
            return;
        }

        if (v === "Custom" && !validateCustomUploaderSettings()) {
            return;
        }
        setFileUploader(v);
        updateSetting("fileUploader", v);
    };

    const handleArgChange = (oldKey: string, newKey: string, value: any) => {
        const state = customUploaderStore.get();
        const newArgs = { ...state.args };

        if (oldKey !== newKey) {
            delete newArgs[oldKey];
        }

        if (value === "" && newKey === "") {
            delete newArgs[oldKey];
        } else {
            newArgs[newKey] = value;
        }

        customUploaderStore.set({ args: newArgs });

        // Only add empty key-value pair if all current ones are filled
        if (Object.values(newArgs).every(v => v !== "") && Object.keys(newArgs).every(k => k !== "")) {
            newArgs[""] = "";
        }

        customUploaderStore.set({ args: newArgs });
    };

    const handleHeaderChange = (oldKey: string, newKey: string, value: string) => {
        const state = customUploaderStore.get();
        const newHeaders = { ...state.headers };

        if (oldKey !== newKey) {
            delete newHeaders[oldKey];
        }

        if (value === "" && newKey === "") {
            delete newHeaders[oldKey];
        } else {
            newHeaders[newKey] = value;
        }

        customUploaderStore.set({ headers: newHeaders });

        // Only add empty key-value pair if all current ones are filled
        if (Object.values(newHeaders).every(v => v !== "") && Object.keys(newHeaders).every(k => k !== "")) {
            newHeaders[""] = "";
        }

        customUploaderStore.set({ headers: newHeaders });
    };

    const triggerFileUpload = () => {
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    return (
        <Flex flexDirection="column">
            <Forms.FormDivider />
            <Forms.FormSection title="Upload Limit Bypass">
                <Forms.FormText>
                    Select the external file uploader service to be used to bypass the upload limit.
                    If a service fails, the plugin will automatically try other services as fallbacks.
                </Forms.FormText>
                <Select
                    options={[
                        { label: "GoFile (Temporary | Unlimited)", value: "GoFile" },
                        { label: "Catbox (Up to 200MB)", value: "Catbox" },
                        { label: "Litterbox (Temporary | Up to 1GB)", value: "Litterbox" },
                        { label: "Custom Uploader", value: "Custom" },
                    ]}
                    className={Margins.bottom16}
                    select={handleFileUploaderChange}
                    isSelected={v => v === fileUploader}
                    serialize={v => v}
                    closeOnSelect={true}
                    clearable={false}
                />
            </Forms.FormSection>

            <Forms.FormSection>
                <Switch
                    value={settings.store.autoSend === "Yes"}
                    onChange={(enabled: boolean) => updateSetting("autoSend", enabled ? "Yes" : "No")}
                    note="Whether to automatically send the links with the uploaded files to chat instead of just pasting them into the chatbox."
                    hideBorder={true}
                >
                    Auto-Send Uploads To Chat
                </Switch>
            </Forms.FormSection>

            <Forms.FormSection>
                <Switch
                    value={settings.store.autoFormat === "Yes"}
                    onChange={(enabled: boolean) => updateSetting("autoFormat", enabled ? "Yes" : "No")}
                    note="Whether to mask the link to match the original filename."
                    hideBorder={true}
                >
                    Auto-Mask Links
                </Switch>
            </Forms.FormSection>

            <Forms.FormSection title="Upload Timeout">
                <Forms.FormText>
                    Configure how long to wait for large file uploads before timing out. Higher settings allow larger files but may hang longer if the upload fails.
                </Forms.FormText>
                <Select
                    options={[
                        { label: "Conservative (10 min max)", value: "conservative" },
                        { label: "Standard (20 min max)", value: "standard" },
                        { label: "Extended (30 min max)", value: "extended" },
                        { label: "Maximum (60 min max)", value: "maximum" },
                    ]}
                    className={Margins.bottom16}
                    select={(newValue: string) => updateSetting("uploadTimeout", newValue)}
                    isSelected={(v: string) => v === (settings.store.uploadTimeout || "standard")}
                    serialize={(v: string) => v}
                    closeOnSelect={true}
                    clearable={false}
                />
            </Forms.FormSection>

            {fileUploader === "GoFile" && (
                <>
                    <Forms.FormSection title="GoFile Token (optional)">
                        <Forms.FormText>
                            Insert your personal GoFile account's token to save all uploads to your GoFile account.
                        </Forms.FormText>
                        <TextInput
                            type="text"
                            value={settings.store.gofileToken || ""}
                            placeholder="Insert GoFile Token"
                            onChange={newValue => updateSetting("gofileToken", newValue)}
                            className={Margins.top16}
                        />
                    </Forms.FormSection>
                </>
            )}

            {fileUploader === "Catbox" && (
                <>
                    <Forms.FormSection title="Catbox User hash (optional)">
                        <Forms.FormText>
                            Insert your personal Catbox account's hash to save all uploads to your Catbox account.
                        </Forms.FormText>
                        <TextInput
                            type="text"
                            value={settings.store.catboxUserHash || ""}
                            placeholder="Insert User Hash"
                            onChange={newValue => updateSetting("catboxUserHash", newValue)}
                            className={Margins.top16}
                        />
                    </Forms.FormSection>
                </>
            )}

            {fileUploader === "Litterbox" && (
                <>
                    <Forms.FormSection title="File Expiration Time">
                        <Forms.FormText>
                            Select how long it should take for your uploads to expire and get deleted.
                        </Forms.FormText>
                        <Select
                            options={[
                                { label: "1 hour", value: "1h" },
                                { label: "12 hours", value: "12h" },
                                { label: "24 hours", value: "24h" },
                                { label: "72 hours", value: "72h" },
                            ]}
                            placeholder="Select Duration"
                            className={Margins.top16}
                            select={newValue => updateSetting("litterboxTime", newValue)}
                            isSelected={v => v === settings.store.litterboxTime}
                            serialize={v => v}
                        />
                    </Forms.FormSection>
                </>
            )}

            {fileUploader === "Custom" && (
                <>
                    <Forms.FormDivider />
                    <Forms.FormSection title="Custom Uploader Configuration">
                        <Forms.FormText>
                            Configure a custom file uploader. This is the most flexible option and can work around Content Security Policy restrictions.
                            <br /><br />
                            <strong>CSP-Compliant Alternatives:</strong> If Catbox/Litterbox get blocked, try services that use domains like *.githubusercontent.com, *.imgur.com, or other whitelisted domains.
                        </Forms.FormText>
                    </Forms.FormSection>
                    <Forms.FormSection title="Custom Uploader Name">
                        <TextInput
                            type="text"
                            value={customUploaderStore.get().name}
                            placeholder="Name"
                            onChange={(newValue: string) => customUploaderStore.set({ name: newValue })}
                            className={Margins.bottom16}
                        />
                    </Forms.FormSection>

                    <Forms.FormSection title="Request URL">
                        <TextInput
                            type="text"
                            value={customUploaderStore.get().requestURL}
                            placeholder="URL"
                            onChange={(newValue: string) => customUploaderStore.set({ requestURL: newValue })}
                            className={Margins.bottom16}
                        />
                    </Forms.FormSection>

                    <Forms.FormSection title="File Form Name">
                        <TextInput
                            type="text"
                            value={customUploaderStore.get().fileFormName}
                            placeholder="Name"
                            onChange={(newValue: string) => customUploaderStore.set({ fileFormName: newValue })}
                            className={Margins.bottom16}
                        />
                    </Forms.FormSection>

                    <Forms.FormSection title="Response type">
                        <Select
                            options={[
                                { label: "Text", value: "Text" },
                                { label: "JSON", value: "JSON" },
                            ]}
                            placeholder="Select Response Type"
                            className={Margins.bottom16}
                            select={(newValue: string) => customUploaderStore.set({ responseType: newValue })}
                            isSelected={(v: string) => v === customUploaderStore.get().responseType}
                            serialize={(v: string) => v}
                        />
                    </Forms.FormSection>

                    <Forms.FormSection title="URL (JSON path)">
                        <Forms.FormText>
                            Enter the JSON path to extract the file URL from the response.<br />
                            Examples: "url", "data.file_url", "result.download_link"<br />
                            <strong>Do NOT enter a full URL here - just the JSON path.</strong>
                        </Forms.FormText>
                        <TextInput
                            type="text"
                            value={customUploaderStore.get().url}
                            placeholder="url"
                            onChange={(newValue: string) => customUploaderStore.set({ url: newValue })}
                            className={Margins.bottom16}
                        />
                    </Forms.FormSection>

                    <Forms.FormSection title="Thumbnail URL (JSON path)">
                        <TextInput
                            type="text"
                            value={customUploaderStore.get().thumbnailURL}
                            placeholder="Thumbnail URL"
                            onChange={(newValue: string) => customUploaderStore.set({ thumbnailURL: newValue })}
                            className={Margins.bottom16}
                        />
                    </Forms.FormSection>

                    <Forms.FormDivider />
                    <Forms.FormTitle>Custom Uploader Arguments</Forms.FormTitle>
                    {Object.entries(customUploaderStore.get().args).map(([key, value], index) => (
                        <div key={index}>
                            <TextInput
                                type="text"
                                value={key}
                                placeholder="Argument Key"
                                onChange={(newKey: string) => handleArgChange(key, newKey, value as string)}
                                className={Margins.bottom16}
                            />
                            <TextInput
                                type="text"
                                value={value as string}
                                placeholder="Argument Value"
                                onChange={(newValue: string) => handleArgChange(key, key, newValue)}
                                className={Margins.bottom16}
                            />
                        </div>
                    ))}

                    <Forms.FormDivider />
                    <Forms.FormTitle>Headers</Forms.FormTitle>
                    {Object.entries(customUploaderStore.get().headers).map(([key, value], index) => (
                        <div key={index}>
                            <TextInput
                                type="text"
                                value={key}
                                placeholder="Header Key"
                                onChange={(newKey: string) => handleHeaderChange(key, newKey, value as string)}
                                className={Margins.bottom16}
                            />
                            <TextInput
                                type="text"
                                value={value as string}
                                placeholder="Header Value"
                                onChange={(newValue: string) => handleHeaderChange(key, key, newValue)}
                                className={Margins.bottom16}
                            />
                        </div>
                    ))}

                    <Forms.FormDivider />
                    <Forms.FormTitle>Import ShareX Config</Forms.FormTitle>
                    <Button
                        onClick={triggerFileUpload}
                        color={Button.Colors.BRAND}
                        size={Button.Sizes.XLARGE}
                        className={Margins.bottom16}
                    >
                        Import
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".sxcu"
                        style={{ display: "none" }}
                        onChange={handleShareXConfigUpload}
                    />
                </>
            )}
        </Flex>
    );
}

const settings = definePluginSettings({
    fileUploader: {
        type: OptionType.SELECT,
        options: [
            { label: "GoFile (Streaming)", value: "GoFile" },
            { label: "Catbox (Up to 200MB)", value: "Catbox", default: true },
            { label: "Litterbox (Temporary | Up to 1GB)", value: "Litterbox" },
            { label: "Custom Uploader", value: "Custom" },
        ],
        description: "Select the file uploader service",
        hidden: true
    },
    gofileToken: {
        type: OptionType.STRING,
        default: "",
        description: "GoFile Token (optional)",
        hidden: true
    },
    autoSend: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes" },
            { label: "No", value: "No", default: true },
        ],
        description: "Auto-Send",
        hidden: true
    },
    autoFormat: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes" },
            { label: "No", value: "No", default: true },
        ],
        description: "Auto-Format",
        hidden: true
    },
    uploadTimeout: {
        type: OptionType.SELECT,
        options: [
            { label: "Conservative (10 min max)", value: "conservative" },
            { label: "Standard (20 min max)", value: "standard", default: true },
            { label: "Extended (30 min max)", value: "extended" },
            { label: "Maximum (60 min max)", value: "maximum" },
        ],
        description: "Upload timeout for large files",
        hidden: true
    },
    catboxUserHash: {
        type: OptionType.STRING,
        default: "",
        description: "User hash for Catbox uploader (optional)",
        hidden: true
    },
    litterboxTime: {
        type: OptionType.SELECT,
        options: [
            { label: "1 hour", value: "1h", default: true },
            { label: "12 hours", value: "12h" },
            { label: "24 hours", value: "24h" },
            { label: "72 hours", value: "72h" },
        ],
        description: "Duration for files on Litterbox before they are deleted",
        hidden: true
    },
    customUploaderName: {
        type: OptionType.STRING,
        default: "",
        description: "Name of the custom uploader",
        hidden: true
    },
    customUploaderRequestURL: {
        type: OptionType.STRING,
        default: "",
        description: "Request URL for the custom uploader",
        hidden: true
    },
    customUploaderFileFormName: {
        type: OptionType.STRING,
        default: "",
        description: "File form name for the custom uploader",
        hidden: true
    },
    customUploaderResponseType: {
        type: OptionType.SELECT,
        options: [
            { label: "Text", value: "Text", default: true },
            { label: "JSON", value: "JSON" },
        ],
        description: "Response type for the custom uploader",
        hidden: true
    },
    customUploaderURL: {
        type: OptionType.STRING,
        default: "",
        description: "URL (JSON path) for the custom uploader",
        hidden: true
    },
    customUploaderThumbnailURL: {
        type: OptionType.STRING,
        default: "",
        description: "Thumbnail URL (JSON path) for the custom uploader",
        hidden: true
    },
    customUploaderHeaders: {
        type: OptionType.STRING,
        default: JSON.stringify({}),
        description: "Headers for the custom uploader (JSON string)",
        hidden: true
    },
    customUploaderArgs: {
        type: OptionType.STRING,
        default: JSON.stringify({}),
        description: "Arguments for the custom uploader (JSON string)",
        hidden: true
    },
    customSettings: {
        type: OptionType.COMPONENT,
        component: SettingsComponent,
        description: "Configure custom uploader settings",
        hidden: false
    },
}).withPrivateSettings<{
    customUploaderArgs?: Record<string, string>;
    customUploaderHeaders?: Record<string, string>;
}>();

function handleCSPError(error: unknown, serviceName: string, channelId: string) {
    const errorMessage = getErrorMessage(error);
    const isCSPError = errorMessage.includes("Content Security Policy") ||
        errorMessage.includes("CSP") ||
        errorMessage.includes("violates the following Content Security Policy directive");

    if (isCSPError) {
        console.error(`CSP blocking ${serviceName}:`, error);
        sendBotMessage(channelId, {
            content: `**${serviceName} blocked by Content Security Policy**\n` +
                `Discord's security policy is preventing uploads to ${serviceName}.\n\n` +
                "**Solutions:**\n" +
                "• Try using the **Custom uploader** with a CSP-compliant service\n" +
                "• Switch to GoFile which has CSP workarounds\n" +
                "• Check plugin settings for alternative upload services\n\n" +
                "-# This is a Discord security restriction, not a plugin issue."
        });
        showToast(`${serviceName} blocked by CSP - Try Custom uploader`, Toasts.Type.FAILURE);
        return true;
    }
    return false;
}

async function resolveFile(options: any[], ctx: any): Promise<File | null> {
    for (const opt of options) {
        if (opt.name === "file") {
            const upload = UploadStore.getUpload(ctx.channel.id, opt.name, DraftType.SlashCommand);
            return upload.item.file;
        }
    }
    return null;
}

/**
 * GoFile upload
 */
async function uploadFileToGofileWithStreaming(file: File, channelId: string) {
    console.log(`[GoFile] Starting upload for ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    const servers = [
        "store1", "store2", "store3", "store4", "store5", "store6", "store7", "store8", "store9", "store10",
        "store-eu-par-1", "store-eu-par-2", "store-eu-par-3", "store-eu-par-4",
        "store-na-phx-1"
    ];
    const server = servers[Math.floor(Math.random() * servers.length)];

    try {
        const startTime = Date.now();

        console.log("[GoFile] Converting file to ArrayBuffer...");
        const arrayBuffer = await file.arrayBuffer();
        console.log(`[GoFile] ArrayBuffer conversion completed (${arrayBuffer.byteLength} bytes)`);
        console.log(`[GoFile] Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

        const uploadResult = await Native.uploadFileToGofileNative(
            `https://${server}.gofile.io/uploadFile`,
            arrayBuffer,
            file.name,
            file.type,
            settings.store.gofileToken
        );

        const uploadTime = Date.now() - startTime;
        console.log(`[GoFile] Upload completed in ${uploadTime}ms`);

        if ((uploadResult as any).status === "ok") {
            const { downloadPage } = (uploadResult as any).data;
            let finalUrl = downloadPage;

            if (settings.store.autoFormat === "Yes") {
                finalUrl = `[${file.name}](${finalUrl})`;
            }

            setTimeout(() => sendTextToChat(`${finalUrl} `), 10);
            showToast(`${file.name} Successfully Uploaded to GoFile!`, Toasts.Type.SUCCESS);
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        } else {
            throw new Error(`GoFile upload failed: ${JSON.stringify(uploadResult)}`);
        }
    } catch (nativeError) {
        const errorMsg = getErrorMessage(nativeError);
        const sizeMB = file.size / (1024 * 1024);

        if (errorMsg.includes("413") || errorMsg.includes("payload too large")) {
            throw new Error(`GoFile rejected file: too large (${sizeMB.toFixed(1)}MB)`);
        } else if (errorMsg.includes("timeout") || errorMsg.includes("network")) {
            throw new Error(`GoFile upload timeout (${sizeMB.toFixed(1)}MB file may be too large)`);
        }

        throw new Error(`GoFile streaming upload failed: ${errorMsg}`);
    }
}

/**
 * Catbox upload
 */
async function uploadFileToCatboxWithStreaming(file: File, channelId: string) {
    console.log(`[Catbox] Starting upload for ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    const url = "https://catbox.moe/user/api.php";
    const userHash = settings.store.catboxUserHash;

    try {
        console.log("[Catbox] Converting file to ArrayBuffer...");
        const arrayBuffer = await file.arrayBuffer();
        console.log(`[Catbox] ArrayBuffer conversion completed (${arrayBuffer.byteLength} bytes)`);
        console.log(`[Catbox] Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

        const uploadResult = await Native.uploadFileToCatboxNative(
            url,
            arrayBuffer,
            file.name,
            file.type,
            userHash
        );

        if (uploadResult.startsWith("https://") || uploadResult.startsWith("http://")) {
            let finalUrl = uploadResult;

            if (settings.store.autoFormat === "Yes") {
                finalUrl = `[${file.name}](${finalUrl})`;
            }

            setTimeout(() => sendTextToChat(`${finalUrl} `), 10);
            showToast(`${file.name} Successfully Uploaded to Catbox!`, Toasts.Type.SUCCESS);
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        } else {
            throw new Error(`Catbox upload failed: ${uploadResult}`);
        }
    } catch (nativeError) {
        throw new Error(`Catbox streaming upload failed: ${getErrorMessage(nativeError)}`);
    }
}

/**
 * Litterbox upload
 */
async function uploadFileToLitterboxWithStreaming(file: File, channelId: string) {
    console.log(`[Litterbox] Starting upload for ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    const time = settings.store.litterboxTime;

    try {
        console.log("[Litterbox] Converting file to ArrayBuffer...");
        const arrayBuffer = await file.arrayBuffer();
        console.log(`[Litterbox] ArrayBuffer conversion completed (${arrayBuffer.byteLength} bytes)`);
        console.log(`[Litterbox] Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

        const uploadResult = await Native.uploadFileToLitterboxNative(
            arrayBuffer,
            file.name,
            file.type,
            time
        );

        if (uploadResult.startsWith("https://") || uploadResult.startsWith("http://")) {
            let finalUrl = uploadResult;

            if (settings.store.autoFormat === "Yes") {
                finalUrl = `[${file.name}](${finalUrl})`;
            }

            setTimeout(() => sendTextToChat(`${finalUrl}`), 10);
            showToast(`${file.name} Successfully Uploaded to Litterbox!`, Toasts.Type.SUCCESS);
            UploadManager.clearAll(channelId, DraftType.SlashCommand);
        } else {
            throw new Error(`Litterbox upload failed: ${uploadResult}`);
        }
    } catch (nativeError) {
        throw new Error(`Litterbox streaming upload failed: ${getErrorMessage(nativeError)}`);
    }
}

/**
 * Custom upload
 */
async function uploadFileCustomWithStreaming(file: File, channelId: string) {
    console.log(`[Custom] Starting upload for ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    const fileFormName = settings.store.customUploaderFileFormName || "file";
    const responseType = settings.store.customUploaderResponseType;

    let customArgs: Record<string, string>;
    try {
        customArgs = JSON.parse(settings.store.customUploaderArgs || "{}");
    } catch (e) {
        throw new Error(`Failed to parse custom uploader arguments: ${e}`);
    }

    let customHeaders: Record<string, string>;
    try {
        const parsedHeaders = JSON.parse(settings.store.customUploaderHeaders || "{}");
        customHeaders = Object.entries(parsedHeaders).reduce((acc, [key, value]) => {
            if (key && typeof key === "string" && key.trim() !== "") {
                acc[key] = String(value);
            }
            return acc;
        }, {} as Record<string, string>);
    } catch (e) {
        throw new Error(`Failed to parse custom uploader headers: ${e}`);
    }

    // Handle URL path parsing - this should be just the JSON path, not a full URL
    const urlPathString = settings.store.customUploaderURL || "";
    let urlPath: string[] = [];

    // Check if this looks like a JSON path (e.g., "url" or "data.downloadUrl") vs a full URL
    if (urlPathString.includes("://")) {
        // This looks like a full URL (legacy format) - extract just the path
        try {
            const baseUrl = new URL(urlPathString);
            urlPath = baseUrl.pathname.split("/").filter(segment => segment);
        } catch (e) {
            throw new Error(`Invalid custom uploader URL: ${urlPathString}`);
        }
    } else {
        // This is a JSON path (e.g., "url", "data.file_url", etc.)
        urlPath = urlPathString.split(".").filter(segment => segment);
    }

    try {
        console.log("[Custom] Converting file to ArrayBuffer...");
        const arrayBuffer = await file.arrayBuffer();
        console.log(`[Custom] ArrayBuffer conversion completed (${arrayBuffer.byteLength} bytes)`);
        console.log(`[Custom] Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

        const finalUrl = await Native.uploadFileCustomNative(
            settings.store.customUploaderRequestURL,
            arrayBuffer,
            file.name,
            file.type,
            fileFormName,
            customArgs,
            customHeaders,
            responseType,
            urlPath
        );

        let finalUrlForChat = finalUrl;

        if (settings.store.autoFormat === "Yes") {
            finalUrlForChat = `[${file.name}](${finalUrlForChat})`;
        }

        setTimeout(() => sendTextToChat(`${finalUrlForChat} `), 10);
        showToast(`${file.name} Successfully Uploaded with Custom Uploader!`, Toasts.Type.SUCCESS);
        UploadManager.clearAll(channelId, DraftType.SlashCommand);
    } catch (nativeError) {
        throw new Error(`Custom streaming upload failed: ${getErrorMessage(nativeError)}`);
    }
}

function getCompatibleUploaders(fileSize: number, primaryUploader: string): string[] {
    const sizeMB = fileSize / (1024 * 1024);

    const uploaderOrder: string[] = [];

    if (sizeMB > 1024) {
        // Files larger than 1GB - only GoFile and Custom can handle these
        if (primaryUploader === "GoFile") {
            uploaderOrder.push("GoFile");
        } else if (primaryUploader === "Custom") {
            uploaderOrder.push("Custom");
        }

        if (primaryUploader !== "GoFile") {
            uploaderOrder.push("GoFile");
        }
        if (primaryUploader !== "Custom") {
            uploaderOrder.push("Custom");
        }
    } else if (sizeMB > 200) {
        // Files 200MB-1GB - Litterbox, GoFile, and Custom can handle these
        if (primaryUploader === "Litterbox") {
            uploaderOrder.push("Litterbox");
        } else if (primaryUploader === "GoFile") {
            uploaderOrder.push("GoFile");
        } else if (primaryUploader === "Custom") {
            uploaderOrder.push("Custom");
        }

        if (primaryUploader !== "Litterbox") {
            uploaderOrder.push("Litterbox");
        }
        if (primaryUploader !== "GoFile") {
            uploaderOrder.push("GoFile");
        }
        if (primaryUploader !== "Custom") {
            uploaderOrder.push("Custom");
        }
    } else {
        // Files under 200MB - all services can handle these
        uploaderOrder.push(primaryUploader);

        const fallbackOrder = ["Catbox", "Litterbox", "GoFile", "Custom"];
        for (const uploader of fallbackOrder) {
            if (uploader !== primaryUploader) {
                uploaderOrder.push(uploader);
            }
        }
    }

    return uploaderOrder;
}

/**
 * Main upload function with smart fallbacks
 */
async function uploadFile(file: File, channelId: string) {
    const primaryUploader = settings.store.fileUploader || "Catbox";
    const fileSizeMB = file.size / (1024 * 1024);

    console.log(`[BigFileUpload] Starting upload for file: ${file.name}`);
    console.log(`[BigFileUpload] File size: ${file.size} bytes (${fileSizeMB.toFixed(1)}MB)`);

    // Get compatible uploaders based on file size
    const uploaderOrder = getCompatibleUploaders(file.size, primaryUploader);
    console.log(`[BigFileUpload] Uploader order: ${uploaderOrder.join(", ")}`);

    // Large file warning
    if (fileSizeMB > 300) {
        console.warn(`[BigFileUpload] Large file warning: ${fileSizeMB.toFixed(1)}MB may take 10+ minutes to upload`);
        showToast(`Large file detected (${fileSizeMB.toFixed(1)}MB) - this may take 10+ minutes`, Toasts.Type.MESSAGE);
    }

    let lastError: any = null;
    let attemptCount = 0;

    for (let i = 0; i < uploaderOrder.length; i++) {
        const uploader = uploaderOrder[i];
        attemptCount++;

        try {
            console.log(`[BigFileUpload] === Attempt ${attemptCount}: ${uploader} ===`);

            if (i > 0) {
                const previousUploader = uploaderOrder[i - 1];
                console.log(`${previousUploader} failed. Trying fallback uploader: ${uploader}`);
                showToast(`${previousUploader} failed. Trying ${uploader} as fallback...`, Toasts.Type.MESSAGE);

                await new Promise(resolve => setTimeout(resolve, 3000));

                // Clear any residual upload state
                try {
                    UploadManager.clearAll(channelId, DraftType.SlashCommand);
                } catch (clearError) {
                    console.warn("Failed to clear upload manager state:", clearError);
                }
            }

            // Dynamic timeout based on file size and user setting
            const timeoutSetting = settings.store.uploadTimeout || "standard";
            let uploadTimeout;

            switch (timeoutSetting) {
                case "conservative":
                    uploadTimeout = fileSizeMB > 100 ? 600000 : 300000; // 10 min max
                    break;
                case "extended":
                    uploadTimeout = fileSizeMB > 500 ? 1800000 : fileSizeMB > 300 ? 1200000 : fileSizeMB > 100 ? 900000 : 600000; // 30 min max
                    break;
                case "maximum":
                    uploadTimeout = fileSizeMB > 500 ? 3600000 : fileSizeMB > 300 ? 2400000 : fileSizeMB > 100 ? 1800000 : 1200000; // 60 min max
                    break;
                default:
                    uploadTimeout = fileSizeMB > 500 ? 1200000 : fileSizeMB > 300 ? 900000 : fileSizeMB > 100 ? 600000 : 300000; // 20 min max
            }

            console.log(`[BigFileUpload] Upload timeout set to ${uploadTimeout / 60000} minutes for ${fileSizeMB.toFixed(1)}MB file (${timeoutSetting} mode)`);

            // Show progress indicator for large files
            if (fileSizeMB > 200) {
                showToast(`Uploading ${fileSizeMB.toFixed(1)}MB to ${uploader} - this may take up to ${Math.ceil(uploadTimeout / 60000)} minutes...`, Toasts.Type.MESSAGE);
            }

            // Use streaming upload functions with timeout
            const uploadPromise = (() => {
                switch (uploader) {
                    case "GoFile":
                        return uploadFileToGofileWithStreaming(file, channelId);
                    case "Catbox":
                        return uploadFileToCatboxWithStreaming(file, channelId);
                    case "Litterbox":
                        return uploadFileToLitterboxWithStreaming(file, channelId);
                    case "Custom":
                        return uploadFileCustomWithStreaming(file, channelId);
                    default:
                        throw new Error(`Unknown uploader: ${uploader}`);
                }
            })();

            // Add timeout handling
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Upload timeout after ${uploadTimeout / 60000} minutes - file may be too large for reliable upload`));
                }, uploadTimeout);
            });

            await Promise.race([uploadPromise, timeoutPromise]);

            console.log(`[BigFileUpload] ${uploader} upload completed successfully`);
            return;

        } catch (error) {
            console.error(`[BigFileUpload] Upload failed with ${uploader}:`, error);
            console.error(`[BigFileUpload] Error type: ${typeof error}`);
            console.error(`[BigFileUpload] Error message: ${getErrorMessage(error)}`);

            lastError = error;

            // Check for specific error types
            const errorMsg = getErrorMessage(error);

            if (errorMsg.includes("timeout")) {
                console.error(`[BigFileUpload] ${uploader} timed out - file too large for reliable upload`);
                showToast(`${uploader} timed out (${fileSizeMB.toFixed(1)}MB too large)`, Toasts.Type.FAILURE);
            } else if (errorMsg.includes("network") || errorMsg.includes("fetch")) {
                console.error(`[BigFileUpload] ${uploader} network error`);
            } else if (errorMsg.includes("CSP") || errorMsg.includes("Content Security Policy")) {
                console.error(`[BigFileUpload] ${uploader} blocked by CSP`);
            }

            if (handleCSPError(error, uploader, channelId)) {
                continue;
            }

            if (i === uploaderOrder.length - 1) {
                console.error("[BigFileUpload] All uploaders failed. Last error:", lastError);

                const allUploaders = ["Catbox", "Litterbox", "GoFile", "Custom"];
                const skippedUploaders = allUploaders.filter(u => !uploaderOrder.includes(u));

                let skipMessage = "";
                if (skippedUploaders.length > 0) {
                    skipMessage = `\nSkipped (file too large): ${skippedUploaders.join(", ")}\n`;
                }

                // Enhanced error message for timeout issues
                let timeoutAdvice = "";
                if (getErrorMessage(lastError).includes("timeout")) {
                    timeoutAdvice = "\n**Upload Timeout Solutions:**\n" +
                        "• Try uploading during off-peak hours (less network congestion)\n" +
                        "• Use a faster/more stable internet connection\n" +
                        "• Split large files into smaller parts (recommended: under 200MB each)\n" +
                        "• Try a different upload service\n" +
                        "• Consider using Discord's native file upload for very large files\n";
                }

                sendBotMessage(channelId, {
                    content: "**All compatible upload services failed!**\n" +
                        `File size: ${fileSizeMB.toFixed(1)}MB\n` +
                        `Attempts made: ${attemptCount}\n` +
                        `Tried: ${uploaderOrder.join(", ")}${skipMessage}` +
                        `Last error: ${getErrorMessage(lastError)}\n\n` +
                        "**Memory-efficient streaming was used** but uploads still failed.\n" +
                        "This may be due to:\n" +
                        "• **File too large for reliable upload over internet**\n" +
                        "• Network timeout (uploads >400MB often fail)\n" +
                        "• Slow/unstable internet connection\n" +
                        "• Service overload or temporary issues\n" +
                        timeoutAdvice +
                        "\nCheck console for detailed error logs."
                });
                showToast("All streaming uploads failed", Toasts.Type.FAILURE);
                UploadManager.clearAll(channelId, DraftType.SlashCommand);
                return;
            }

            continue;
        }
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
    description: "Bypass Discord's upload limit by uploading files using the 'Upload a Big File' button or /fileupload and they'll get uploaded as links into chat via file uploaders.",
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
            description: "Upload a file",
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
