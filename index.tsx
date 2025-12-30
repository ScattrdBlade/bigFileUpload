/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { OpenExternalIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, DraftType, Menu, PermissionsBits, PermissionStore, React, Select, SelectedChannelStore, showToast, TextInput, Toasts, UploadManager, useEffect, useState } from "@webpack/common";

import { LoggingLevel, pluginLogger as log, setLoggingLevelProvider } from "./logging";
import { UploadProgressBar } from "./renderer/components/UploadProgressBar";
import { disableDragDropOverride, enableDragDropOverride, setNitroLimitChecker, setUploadFunction } from "./renderer/dragDrop";
import { formatFileSize } from "./renderer/formatting";
import { showUploadNotification } from "./renderer/notifications";
import { clearAndForceHide, completeAndDispatch, completeUpload as completeUploadTracking, markDispatched, startProgressPolling, startUploadBatch, stopProgressPolling } from "./renderer/progress";

const Native = VencordNative.pluginHelpers.BigFileUpload as PluginNative<typeof import("./native")>;

// Type for upload result from native functions
interface UploadResult {
    success: boolean;
    url?: string;
    fileName?: string;
    fileSize?: number;
    uploadId?: string;
    actualUploader?: string;
    attemptedUploaders?: string[];
    error?: string;
}

const OptionClasses = findByPropsLazy("optionName", "optionIcon", "optionLabel");

// Progress tracking - use centralized module
function generateUploadId(): string {
    return `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}


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

// showUploadNotification moved to ./renderer/notifications.ts for sharing with UploadProgressBar

function notifyFallbackInfo(result: any) {
    const attempted: string[] | undefined = result?.attemptedUploaders;
    const uploader: string | undefined = result?.actualUploader;
    if (!attempted || attempted.length <= 1 || !uploader) return;
    const failed = attempted.slice(0, -1);
    if (!failed.length) return;
    const message = `Fallback used: ${failed.join(", ")} failed, uploaded via ${uploader}.`;
    log.info(message);
    showUploadNotification(message, Toasts.Type.MESSAGE);
}

type NativeNotification = { type: string; message: string; timestamp?: number; };

function handleNativeNotification(notification: NativeNotification) {
    const toastType = notification.type === "failure"
        ? Toasts.Type.FAILURE
        : notification.type === "success"
            ? Toasts.Type.SUCCESS
            : Toasts.Type.MESSAGE;

    // Log native events to renderer console (native logs go to main process, not visible in DevTools)
    if (notification.type === "failure") {
        log.error(notification.message);
    } else if (notification.type === "success") {
        log.info(notification.message);
    } else {
        log.info(notification.message);
    }

    showUploadNotification(notification.message, toastType);
}

let nativeNotificationInterval: number | null = null;

async function pollNativeNotifications() {
    try {
        const notifications = await Native.getPendingNotifications?.();
        if (!notifications?.length) return;
        for (const notification of notifications) {
            handleNativeNotification(notification);
        }
    } catch (error) {
        log.warn("Failed to poll native notifications:", error);
    }
}

function startNativeNotificationPolling() {
    if (nativeNotificationInterval !== null) return;
    // Poll immediately once to catch queued notifications
    void pollNativeNotifications();
    // Poll every 500ms for faster fallback notifications
    nativeNotificationInterval = window.setInterval(() => {
        void pollNativeNotifications();
    }, 500);
}

function stopNativeNotificationPolling() {
    if (nativeNotificationInterval !== null) {
        clearInterval(nativeNotificationInterval);
        nativeNotificationInterval = null;
    }
}

// Format ETA seconds into human-readable string
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
        requestMethod: settings.store.customUploaderRequestMethod || "POST",
        bodyType: settings.store.customUploaderBodyType || "MultipartFormData",
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
            updateSetting("customUploaderRequestMethod", state.requestMethod);
            updateSetting("customUploaderBodyType", state.bodyType);
        });

        return unsubscribe;
    }, []);

    function updateSetting(key: keyof typeof settings.store, value: any) {
        if (key in settings.store) {
            (settings.store as any)[key] = value;
        } else {
            log.error(`Invalid setting key: ${key}`);
        }
    }

    function handleShareXConfigUpload(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e: ProgressEvent<FileReader>) => {
                try {
                    const result = e.target?.result;
                    if (typeof result !== "string") {
                        throw new Error("FileReader did not return a string");
                    }
                    const config = JSON.parse(result);

                    // Detect body type from ShareX config
                    const bodyType = config.Body === "Binary" ? "Binary" : "MultipartFormData";

                    customUploaderStore.set({
                        name: "",
                        requestURL: "",
                        fileFormName: "",
                        responseType: "Text",
                        url: "",
                        thumbnailURL: "",
                        headers: { "": "" },
                        args: { "": "" },
                        requestMethod: "POST",
                        bodyType: "MultipartFormData"
                    });

                    customUploaderStore.set({
                        name: config.Name || "",
                        requestURL: config.RequestURL || "",
                        fileFormName: config.FileFormName || "",
                        responseType: config.ResponseType || "Text",
                        url: config.URL || "",
                        thumbnailURL: config.ThumbnailURL || "",
                        headers: config.Headers || { "": "" },
                        args: config.Arguments || { "": "" },
                        requestMethod: config.RequestMethod || "POST",
                        bodyType: bodyType
                    });

                    updateSetting("customUploaderName", config.Name || "");
                    updateSetting("customUploaderRequestURL", config.RequestURL || "");
                    updateSetting("customUploaderFileFormName", config.FileFormName || "");
                    updateSetting("customUploaderResponseType", config.ResponseType || "Text");
                    updateSetting("customUploaderURL", config.URL || "");
                    updateSetting("customUploaderThumbnailURL", config.ThumbnailURL || "");
                    updateSetting("customUploaderHeaders", JSON.stringify(config.Headers || { "": "" }));
                    updateSetting("customUploaderArgs", JSON.stringify(config.Arguments || { "": "" }));
                    updateSetting("customUploaderRequestMethod", config.RequestMethod || "POST");
                    updateSetting("customUploaderBodyType", bodyType);

                    setFileUploader("Custom");
                    updateSetting("fileUploader", "Custom");

                    showToast("ShareX config imported successfully");
                } catch (error) {
                    log.error("Error parsing ShareX config:", error);
                    showToast("Invalid ShareX config. Ensure it's valid JSON.");
                }
            };
            reader.readAsText(file);

            event.target.value = "";
        }
    }

    const validateCustomUploaderSettings = () => {
        if (fileUploader === "Custom") {
            if (!settings.store.customUploaderRequestURL || settings.store.customUploaderRequestURL.trim() === "") {
                showToast("Custom uploader: Request URL is required");
                return false;
            }
            if (!settings.store.customUploaderFileFormName || settings.store.customUploaderFileFormName.trim() === "") {
                showToast("Custom uploader: File form name is required");
                return false;
            }
            if (!settings.store.customUploaderURL || settings.store.customUploaderURL.trim() === "") {
                showToast("Custom uploader: Response URL path is required");
                return false;
            }
            // Check for placeholder values that shouldn't be there
            if (settings.store.customUploaderURL.includes("$json:") || settings.store.customUploaderURL.includes("$")) {
                showToast("Custom uploader: Replace $json:... placeholders with actual JSON paths");
                return false;
            }
        }
        return true;
    };

    const handleFileUploaderChange = (v: string) => {
        if (!v || v.trim() === "") {
            log.warn("Attempted to select empty uploader, keeping current selection");
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

        // Only add empty key-value pair if all current ones are filled
        if (Object.values(newArgs).every(v => v !== "") && Object.keys(newArgs).every(k => k !== "")) {
            newArgs[""] = "";
        }

        // Single set() call to avoid double-write
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

        // Only add empty key-value pair if all current ones are filled
        if (Object.values(newHeaders).every(v => v !== "") && Object.keys(newHeaders).every(k => k !== "")) {
            newHeaders[""] = "";
        }

        // Single set() call to avoid double-write
        customUploaderStore.set({ headers: newHeaders });
    };

    const triggerFileUpload = () => {
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    return (
        <Flex flexDirection="column" style={{ gap: "12px" }}>

            {/* Main Settings */}
            <Heading tag="h5">File Uploader Service</Heading>
            <Paragraph className={Margins.bottom8}>
                Choose where your files will be uploaded. If one service fails, the plugin will automatically try fallback options.
            </Paragraph>
            <Select
                className={Margins.bottom20}
                options={[
                    { label: "Catbox (Up to 200MB, Permanent, Embeds)", value: "Catbox" },
                    { label: "Litterbox (Up to 1GB, 3 days, Embeds)", value: "Litterbox" },
                    { label: "0x0.st (Up to 512MB, 1 year, Embeds)", value: "0x0.st" },
                    { label: "GoFile (Unlimited, 10 days)", value: "GoFile" },
                    { label: "tmpfiles.org (Up to 100MB, 60 min)", value: "tmpfiles.org" },
                    { label: "buzzheavier.com (Unlimited, 60 days)", value: "buzzheavier.com" },
                    { label: "temp.sh (Up to 4GB, 3 days)", value: "temp.sh" },
                    { label: "filebin.net (Unlimited, 6 days)", value: "filebin.net" },
                    { label: "Custom Uploader", value: "Custom" },
                ]}
                select={handleFileUploaderChange}
                isSelected={v => v === fileUploader}
                serialize={v => v}
                closeOnSelect={true}
                clearable={false}
            />

            <Divider />

            {/* Behavior Settings */}
            <Heading tag="h5">Upload Behavior</Heading>
            <Paragraph className={Margins.bottom8}>
                Configure how uploaded file links are handled and displayed in Discord.
            </Paragraph>
            <FormSwitch
                title="Enable Paste"
                description="Intercept file paste events. Disable to let Discord handle pastes natively."
                value={settings.store.pasteEnabled !== "No"}
                onChange={(enabled: boolean) => {
                    updateSetting("pasteEnabled", enabled ? "Yes" : "No");
                    // Dynamically enable/disable paste handler
                    // Always remove first to prevent listener accumulation
                    document.removeEventListener("paste", handlePaste, { capture: true });
                    if (enabled) {
                        document.addEventListener("paste", handlePaste, { capture: true });
                        log.info("Paste interception enabled");
                    } else {
                        log.info("Paste interception disabled");
                    }
                }}
            />
            <FormSwitch
                title="Enable Drag and Drop"
                description="Intercept drag and drop file uploads (up to 1GB). Disable to let Discord handle drag and drop natively."
                value={settings.store.dragAndDropEnabled !== "No"}
                onChange={(enabled: boolean) => {
                    updateSetting("dragAndDropEnabled", enabled ? "Yes" : "No");
                    // Dynamically enable/disable drag and drop
                    if (enabled) {
                        enableDragDropOverride();
                        log.info("Drag-and-drop enabled");
                    } else {
                        disableDragDropOverride();
                        log.info("Drag-and-drop disabled");
                    }
                }}
            />
            <FormSwitch
                title="Respect Nitro Upload Limit"
                description="Let Discord handle files under your Nitro limit natively. Only intercept files that exceed Discord's limit."
                value={settings.store.respectNitroLimit === "Yes"}
                onChange={(enabled: boolean) => updateSetting("respectNitroLimit", enabled ? "Yes" : "No")}
                hideBorder={settings.store.respectNitroLimit === "Yes"}
            />
            {settings.store.respectNitroLimit === "Yes" && (
                <>
                    <Select
                        className={Margins.bottom20}
                        options={[
                            { label: "No Nitro (10MB limit)", value: "none" },
                            { label: "Nitro Basic (50MB limit)", value: "basic" },
                            { label: "Nitro (500MB limit)", value: "full" },
                        ]}
                        placeholder="Select your Nitro tier..."
                        select={value => updateSetting("nitroType", value)}
                        isSelected={value => value === (settings.store.nitroType || "none")}
                        serialize={value => value}
                        closeOnSelect={true}
                        clearable={false}
                    />
                    <Divider />
                </>
            )}
            <FormSwitch
                title="Embed Video Files"
                description="Wrap uploaded video file links with https://embeds.video/ to embed videos that Discord might not embed. Only applies to video files (mp4, webm, mkv, etc.)."
                value={settings.store.useEmbedsVideo === "Yes"}
                onChange={(enabled: boolean) => updateSetting("useEmbedsVideo", enabled ? "Yes" : "No")}
            />
            <FormSwitch
                title="Display Original Filename"
                description="Format upload links as clickable text showing the original filename. Example: [vacation_video.mp4](link) instead of the raw link."
                value={settings.store.autoFormat === "Yes"}
                onChange={(enabled: boolean) => updateSetting("autoFormat", enabled ? "Yes" : "No")}
            />
            <FormSwitch
                title="Auto-Send Links"
                description="Automatically send uploaded file links to chat immediately after upload completes."
                value={settings.store.autoSend === "Yes"}
                onChange={(enabled: boolean) => updateSetting("autoSend", enabled ? "Yes" : "No")}
            />
            <FormSwitch
                title="Use Notifications Instead of Toasts"
                description="Show Vencord notifications instead of inline toasts."
                value={settings.store.useNotifications === "Yes"}
                onChange={(enabled: boolean) => updateSetting("useNotifications", enabled ? "Yes" : "No")}
            />
            <Heading tag="h5">Console Logging</Heading>
            <Paragraph className={Margins.bottom8}>
                Control how much information BigFileUpload prints to the console. Errors only keeps the log quiet, while verbose is useful for debugging.
            </Paragraph>
            <Select
                className={Margins.bottom20}
                options={[
                    { label: "Errors only (quiet)", value: "errors" },
                    { label: "Important info", value: "info" },
                    { label: "Verbose debug", value: "debug" },
                ]}
                placeholder="Choose how chatty the logs should be..."
                select={value => updateSetting("loggingLevel", value as LoggingLevel)}
                isSelected={value => value === (settings.store.loggingLevel || "errors")}
                serialize={value => value}
                closeOnSelect={true}
                clearable={false}
            />

            {/* Service-Specific Settings */}
            {fileUploader === "GoFile" && (
                <>
                    <Divider />
                    <Heading tag="h5">GoFile Account (Optional)</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Link your GoFile account to save all uploads to your personal storage.
                    </Paragraph>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={settings.store.gofileToken || ""}
                        placeholder="Enter your GoFile token here..."
                        onChange={newValue => updateSetting("gofileToken", newValue)}
                    />
                </>
            )}

            {fileUploader === "Catbox" && (
                <>
                    <Divider />
                    <Heading tag="h5">Catbox Account (Optional)</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Save uploads to your Catbox account by providing your user hash.
                    </Paragraph>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={settings.store.catboxUserHash || ""}
                        placeholder="Enter your Catbox user hash..."
                        onChange={newValue => updateSetting("catboxUserHash", newValue)}
                    />
                </>
            )}

            {fileUploader === "Litterbox" && (
                <>
                    <Divider />
                    <Heading tag="h5">File Expiration</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Choose how long files should remain available before automatic deletion.
                    </Paragraph>
                    <Select
                        className={Margins.bottom20}
                        options={[
                            { label: "1 hour", value: "1h" },
                            { label: "12 hours", value: "12h" },
                            { label: "24 hours (1 day)", value: "24h" },
                            { label: "72 hours (3 days)", value: "72h" },
                        ]}
                        placeholder="Select expiration time..."
                        select={newValue => updateSetting("litterboxTime", newValue)}
                        isSelected={v => v === settings.store.litterboxTime}
                        serialize={v => v}
                    />
                </>
            )}

            {fileUploader === "0x0.st" && (
                <>
                    <Divider />
                    <Heading tag="h5">0x0.st Expiration (Optional)</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Set expiration time using flexible format: 1y 2w 3d 4h 5m 6s (or combined like 1y2w3d4h5m6s). Examples: "7d" (7 days), "1y" (1 year), "30d" (30 days), "168h" (7 days). Maximum: 1 year. Leave empty for automatic retention based on file size: smaller files kept longer (up to 1 year), larger files shorter retention (minimum 30 days).
                    </Paragraph>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={settings.store.zeroX0Expires || ""}
                        placeholder="e.g., 7d or 1y2w or 168h"
                        onChange={newValue => updateSetting("zeroX0Expires", newValue)}
                    />
                </>
            )}

            {fileUploader === "Custom" && (
                <>
                    <Divider />

                    <Heading tag="h5">Custom Uploader</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Configure your own upload service. Compatible with ShareX custom uploaders and can bypass CSP restrictions.
                    </Paragraph>

                    <Heading tag="h5">Uploader Name</Heading>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={customUploaderStore.get().name}
                        placeholder="e.g., My Custom Uploader"
                        onChange={(newValue: string) => customUploaderStore.set({ name: newValue })}
                    />

                    <Heading tag="h5">API Endpoint</Heading>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={customUploaderStore.get().requestURL}
                        placeholder="https://example.com/api/upload"
                        onChange={(newValue: string) => customUploaderStore.set({ requestURL: newValue })}
                    />

                    <Heading tag="h5">File Form Field Name</Heading>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={customUploaderStore.get().fileFormName}
                        placeholder="e.g., file, image, upload"
                        onChange={(newValue: string) => customUploaderStore.set({ fileFormName: newValue })}
                    />

                    <Heading tag="h5">HTTP Method</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Most uploaders use POST. Use PUT for raw binary uploads (like transfer.sh style APIs).
                    </Paragraph>
                    <Select
                        className={Margins.bottom20}
                        options={[
                            { label: "POST", value: "POST" },
                            { label: "PUT", value: "PUT" },
                            { label: "PATCH", value: "PATCH" },
                        ]}
                        placeholder="Select HTTP method..."
                        select={(newValue: string) => customUploaderStore.set({ requestMethod: newValue })}
                        isSelected={(v: string) => v === customUploaderStore.get().requestMethod}
                        serialize={(v: string) => v}
                    />

                    <Heading tag="h5">Body Type</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Multipart for form uploads with fields. Binary for raw file uploads (PUT-style APIs).
                    </Paragraph>
                    <Select
                        className={Margins.bottom20}
                        options={[
                            { label: "Multipart Form Data", value: "MultipartFormData" },
                            { label: "Binary (raw file)", value: "Binary" },
                        ]}
                        placeholder="Select body type..."
                        select={(newValue: string) => customUploaderStore.set({ bodyType: newValue })}
                        isSelected={(v: string) => v === customUploaderStore.get().bodyType}
                        serialize={(v: string) => v}
                    />

                    <Heading tag="h5">Response Format</Heading>
                    <Select
                        className={Margins.bottom20}
                        options={[
                            { label: "Plain Text", value: "Text" },
                            { label: "JSON", value: "JSON" },
                        ]}
                        placeholder="Select response type..."
                        select={(newValue: string) => customUploaderStore.set({ responseType: newValue })}
                        isSelected={(v: string) => v === customUploaderStore.get().responseType}
                        serialize={(v: string) => v}
                    />

                    <Heading tag="h5">URL Path (JSON)</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Extract URL from JSON response. Examples: "url", "data.file_url", "result.download_link" (NOT a full URL!)
                    </Paragraph>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={customUploaderStore.get().url}
                        placeholder="url"
                        onChange={(newValue: string) => customUploaderStore.set({ url: newValue })}
                    />

                    <Heading tag="h5">Thumbnail Path (Optional)</Heading>
                    <TextInput
                        className={Margins.bottom20}
                        type="text"
                        value={customUploaderStore.get().thumbnailURL}
                        placeholder="thumbnail_url"
                        onChange={(newValue: string) => customUploaderStore.set({ thumbnailURL: newValue })}
                    />

                    <Divider />

                    <Heading tag="h5">Request Arguments</Heading>
                    <div className={Margins.bottom20}>
                        {Object.entries(customUploaderStore.get().args).map(([key, value], index) => (
                            <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
                                <TextInput
                                    type="text"
                                    value={key}
                                    placeholder="Key"
                                    onChange={(newKey: string) => handleArgChange(key, newKey, value as string)}
                                />
                                <TextInput
                                    type="text"
                                    value={value as string}
                                    placeholder="Value"
                                    onChange={(newValue: string) => handleArgChange(key, key, newValue)}
                                />
                            </div>
                        ))}
                    </div>

                    <Divider />

                    <Heading tag="h5">Custom Headers</Heading>
                    <div className={Margins.bottom20}>
                        {Object.entries(customUploaderStore.get().headers).map(([key, value], index) => (
                            <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
                                <TextInput
                                    type="text"
                                    value={key}
                                    placeholder="Header Key"
                                    onChange={(newKey: string) => handleHeaderChange(key, newKey, value as string)}
                                />
                                <TextInput
                                    type="text"
                                    value={value as string}
                                    placeholder="Header Value"
                                    onChange={(newValue: string) => handleHeaderChange(key, key, newValue)}
                                />
                            </div>
                        ))}
                    </div>

                    <Divider />

                    <Heading tag="h5">ShareX Import</Heading>
                    <Paragraph className={Margins.bottom8}>
                        Quickly import configuration from a ShareX custom uploader file (.sxcu)
                    </Paragraph>
                    <Button
                        onClick={triggerFileUpload}
                        color={Button.Colors.BRAND}
                        size={Button.Sizes.MEDIUM}
                    >
                        Import ShareX Config
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
            { label: "Catbox (Up to 200MB, Permanent)", value: "Catbox", default: true },
            { label: "Litterbox (Up to 1GB, 3 days)", value: "Litterbox" },
            { label: "0x0.st (Up to 512MB, Up to 1 year)", value: "0x0.st" },
            { label: "tmpfiles.org (100MB, 60 min)", value: "tmpfiles.org" },
            { label: "GoFile (Unlimited, +10 days)", value: "GoFile" },
            { label: "buzzheavier.com (Unlimited, +60 days)", value: "buzzheavier.com" },
            { label: "temp.sh (Up to 4GB, 3 days)", value: "temp.sh" },
            { label: "filebin.net (Unlimited, 6 days)", value: "filebin.net" },
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
            { label: "1 minute", value: "60000" },
            { label: "2 minutes", value: "120000" },
            { label: "5 minutes (Recommended)", value: "300000", default: true },
            { label: "10 minutes", value: "600000" },
        ],
        description: "How long to wait for the server to respond. Lower values may cause uploads to fail for large files or slow connections.",
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
            { label: "1 hour", value: "1h" },
            { label: "12 hours", value: "12h" },
            { label: "24 hours", value: "24h" },
            { label: "72 hours (3 days)", value: "72h", default: true },
        ],
        description: "Duration for files on Litterbox before they are deleted",
        hidden: true
    },
    zeroX0Expires: {
        type: OptionType.STRING,
        default: "1y",
        description: "Expiration for 0x0.st uploads (optional, e.g., '7d', '1y', '1y2w3d4h5m6s')",
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
    customUploaderRequestMethod: {
        type: OptionType.SELECT,
        options: [
            { label: "POST", value: "POST", default: true },
            { label: "PUT", value: "PUT" },
            { label: "PATCH", value: "PATCH" },
        ],
        description: "HTTP method for the custom uploader",
        hidden: true
    },
    customUploaderBodyType: {
        type: OptionType.SELECT,
        options: [
            { label: "Multipart Form Data", value: "MultipartFormData", default: true },
            { label: "Binary (raw file)", value: "Binary" },
        ],
        description: "Request body type for the custom uploader",
        hidden: true
    },
    useNotifications: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes" },
            { label: "No", value: "No", default: true },
        ],
        description: "Use desktop notifications instead of toasts",
        hidden: true
    },
    useEmbedsVideo: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes", default: true },
            { label: "No", value: "No" },
        ],
        description: "Wrap uploaded video URLs with embeds.video for better embedding",
        hidden: true
    },
    dragAndDropEnabled: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes", default: true },
            { label: "No", value: "No" },
        ],
        description: "Enable drag and drop file uploads",
        hidden: true
    },
    pasteEnabled: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes", default: true },
            { label: "No", value: "No" },
        ],
        description: "Enable paste file uploads",
        hidden: true
    },
    respectNitroLimit: {
        type: OptionType.SELECT,
        options: [
            { label: "Yes", value: "Yes", default: true },
            { label: "No", value: "No" },
        ],
        description: "Use Discord native upload for files under Nitro limit",
        hidden: true
    },
    nitroType: {
        type: OptionType.SELECT,
        options: [
            { label: "None (10MB)", value: "none", default: true },
            { label: "Nitro Basic (50MB)", value: "basic" },
            { label: "Nitro (500MB)", value: "full" },
        ],
        description: "Your Discord Nitro subscription tier",
        hidden: true
    },
    loggingLevel: {
        type: OptionType.SELECT,
        options: [
            { label: "Errors only", value: "errors", default: true },
            { label: "Important info", value: "info" },
            { label: "Verbose debug", value: "debug" },
        ],
        description: "Control how much BigFileUpload logs to the console",
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

setLoggingLevelProvider(() => {
    try {
        return (settings.store.loggingLevel as LoggingLevel) ?? "errors";
    } catch {
        // Settings store isn't ready yet (plugin still initializing)
        return "errors";
    }
});

// Drag-and-drop / Paste size limit (1GB - safe for most systems)
const DRAG_DROP_MAX_SIZE = 1024 * 1024 * 1024; // 1GB in bytes

// Nitro upload limits
const NITRO_LIMITS = {
    none: 10 * 1024 * 1024, // 10MB for no Nitro
    basic: 50 * 1024 * 1024, // 50MB for Nitro Basic
    full: 500 * 1024 * 1024, // 500MB for full Nitro
} as const;

/**
 * Get the user's Discord upload limit based on their Nitro tier
 */
function getNitroLimit(): number {
    const nitroType = settings.store.nitroType || "none";
    return NITRO_LIMITS[nitroType as keyof typeof NITRO_LIMITS] || NITRO_LIMITS.none;
}

/**
 * Check if a file should use Discord's native upload (under Nitro limit)
 */
function shouldUseNativeUpload(fileSize: number): boolean {
    if (settings.store.respectNitroLimit !== "Yes") {
        return false; // User wants BigFileUpload to handle everything
    }
    return fileSize <= getNitroLimit();
}

// Uploaders that don't support EXE files
const EXE_BLOCKED_UPLOADERS = ["Catbox", "Litterbox", "0x0.st"];
const EXE_FALLBACK_UPLOADER = "GoFile";

/**
 * Check if a file is an EXE based on extension
 */
function isExeFile(fileName: string): boolean {
    return fileName.toLowerCase().endsWith(".exe");
}

/**
 * Get the effective uploader, skipping blocked services for EXE files
 */
function getEffectiveUploader(fileName: string, selectedUploader: string): string {
    if (isExeFile(fileName) && EXE_BLOCKED_UPLOADERS.includes(selectedUploader)) {
        log.info(`${selectedUploader} doesn't support EXE files, using ${EXE_FALLBACK_UPLOADER} instead`);
        return EXE_FALLBACK_UPLOADER;
    }
    return selectedUploader;
}

/**
 * SECURE: Handle drag-and-drop / paste uploads for small files
 * Renderer sends buffer to main process, no file paths exposed
 */
async function handleSmallFileUpload(file: File, skipBatchStart = false) {
    try {
        const channelId = SelectedChannelStore.getChannelId();
        log.debug(`handleSmallFileUpload invoked for ${file.name}`, {
            channelId,
            skipBatchStart,
            fileSize: formatFileSize(file.size)
        });

        // Check size limit for drag-and-drop/paste
        if (file.size > DRAG_DROP_MAX_SIZE) {
            showUploadNotification(
                `File too large (${formatFileSize(file.size)}). Drag-and-drop limit is ${formatFileSize(DRAG_DROP_MAX_SIZE)}. Use the Upload button for larger files.`,
                Toasts.Type.FAILURE
            );
            return;
        }

        // Start progress tracking for single file upload (unless called from paste handler which already started batch)
        if (!skipBatchStart) {
            startUploadBatch(1);
            log.debug("Started upload batch for single file from drag/paste handler");
        }

        // Load file into buffer (safe - size limited)
        const buffer = await file.arrayBuffer();
        log.debug(`Loaded ${buffer.byteLength} bytes into memory for ${file.name}`);

        // Get MIME type from File object (important for upload services to recognize file format)
        const mimeType = file.type || "application/octet-stream";
        log.debug(`File MIME type: ${mimeType}`);

        // Get the selected uploader, with EXE file handling
        const selectedUploader = settings.store.fileUploader || "Catbox";
        const effectiveUploader = getEffectiveUploader(file.name, selectedUploader);

        // Log upload start (Important Info level)
        log.info(`Uploading ${file.name} (${formatFileSize(file.size)}) via ${effectiveUploader}`);

        // Secure upload: send buffer to main process (no file paths exposed)
        log.debug("Calling Native.uploadFileBuffer...");
        const result = await Native.uploadFileBuffer(
            buffer,
            file.name,
            mimeType,
            {
                fileUploader: effectiveUploader,
                gofileToken: settings.store.gofileToken,
                catboxUserHash: settings.store.catboxUserHash,
                litterboxTime: settings.store.litterboxTime,
                zeroX0Expires: settings.store.zeroX0Expires,
                autoFormat: settings.store.autoFormat,
                customUploaderRequestURL: settings.store.customUploaderRequestURL,
                customUploaderFileFormName: settings.store.customUploaderFileFormName,
                customUploaderResponseType: settings.store.customUploaderResponseType,
                customUploaderURL: settings.store.customUploaderURL,
                customUploaderArgs: settings.store.customUploaderArgs,
                customUploaderHeaders: settings.store.customUploaderHeaders,
                customUploaderRequestMethod: settings.store.customUploaderRequestMethod,
                customUploaderBodyType: settings.store.customUploaderBodyType,
                loggingLevel: (settings.store.loggingLevel as LoggingLevel) ?? "errors",
                uploadTimeout: parseInt(settings.store.uploadTimeout || "300000", 10),
				useEmbedsVideo: settings.store.useEmbedsVideo
            }
        );

        const typedResult = result as UploadResult;
        log.debug("Upload result", result);

        // Ensure Discord's native upload UI is cleared so the progress bar disappears
        if (channelId) {
            try {
                UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                UploadManager.clearAll(channelId, DraftType.SlashCommand);
            } catch (clearError) {
                log.warn("Failed to clear native upload UI:", clearError);
            }
        }

        if (!result.success) {
            // Complete tracking even on failure (to clear progress bar)
            if (result.uploadId) {
                completeUploadTracking(result.uploadId);
            } else {
                clearAndForceHide();
            }
            // Don't show error notification if upload was cancelled
            if (result.error !== "Upload cancelled by user") {
                showUploadNotification(`Upload failed: ${result.error}`, Toasts.Type.FAILURE);
            }
            return;
        }

        // Send URL to chat
        if (result.url) {
            // Send text first, then atomically complete + dispatch to prevent race condition
            sendTextToChat(`${result.url}`);

            // Use atomic completeAndDispatch to set both isComplete and isDispatched together
            // This prevents race conditions where one state is set but not the other
            if (result.uploadId) {
                log.debug("Using atomic completeAndDispatch for ID:", result.uploadId);
                completeAndDispatch(result.uploadId);
            } else {
                log.warn("No uploadId in result, using markDispatched fallback");
                markDispatched();
                clearAndForceHide();
            }

            // Show success notification with actual uploader info
            const { actualUploader, attemptedUploaders } = typedResult;
            log.debug(`Checking notification: actualUploader=${actualUploader}, selectedUploader=${selectedUploader}, match=${actualUploader === selectedUploader}`);

            if (actualUploader && actualUploader !== selectedUploader) {
                // Fallback was used - notify user
                const failedUploaders = attemptedUploaders ? attemptedUploaders.slice(0, -1).join(", ") : selectedUploader;
                const notificationMsg = `${result.fileName} uploaded via ${actualUploader} (fallback from ${failedUploaders})`;
                log.debug(`Showing fallback notification: ${notificationMsg}`);
                showUploadNotification(notificationMsg, Toasts.Type.SUCCESS);
            } else {
                log.debug("Showing normal success notification");
                showUploadNotification(`${result.fileName} uploaded successfully`, Toasts.Type.SUCCESS);
                notifyFallbackInfo(result);
            }

            // Ensure progress is cleared even if uploadId wasn't tracked earlier
            // This is a fallback to ensure the progress bar always hides on success
            if (!result.uploadId) {
                log.warn("No uploadId on success, forcing progress clear");
                clearAndForceHide();
                // Also clear native side progress
                await Native.clearProgress();
            }
        } else {
            showUploadNotification("Upload succeeded but no URL was returned. Try a different uploader.", Toasts.Type.FAILURE);
            clearAndForceHide();
        }
    } catch (error) {
        log.error(`Upload failed for '${file.name}' (${formatFileSize(file.size)}):`, error);
        showUploadNotification(`Upload failed unexpectedly: ${getErrorMessage(error)}`, Toasts.Type.FAILURE);

        // Clear progress bar on error - force immediate hide
        clearAndForceHide();
        await Native.clearProgress();

        // Clear Discord's native upload UI on error too
        const channelId = SelectedChannelStore.getChannelId();
        if (channelId) {
            try {
                UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                UploadManager.clearAll(channelId, DraftType.SlashCommand);
            } catch (clearError) {
                log.warn("Failed to clear native upload UI on error:", clearError);
            }
        }
    }
}

async function triggerFileUpload() {
    try {
        const channelId = SelectedChannelStore.getChannelId();
        log.debug("triggerFileUpload invoked", { channelId });
        log.info("Manual upload started");

        // Start progress tracking for button upload
        startUploadBatch(1);
        log.debug("Upload batch started for manual selection");

        // Notify user which uploader will be used
        const selectedUploader = settings.store.fileUploader || "Catbox";
        showUploadNotification(`Uploading via ${selectedUploader}...`, Toasts.Type.MESSAGE);
        log.debug("Manual uploader selection snapshot", {
            selectedUploader,
            gofileToken: Boolean(settings.store.gofileToken),
            catboxUserHash: Boolean(settings.store.catboxUserHash),
            litterboxTime: settings.store.litterboxTime
        });
        log.info(`Manual uploader: ${selectedUploader}`);

        // Secure upload: everything happens in main process (unlimited file size)
        const result = await Native.pickAndUploadFile({
            fileUploader: selectedUploader,
            gofileToken: settings.store.gofileToken,
            catboxUserHash: settings.store.catboxUserHash,
            litterboxTime: settings.store.litterboxTime,
            zeroX0Expires: settings.store.zeroX0Expires,
            autoFormat: settings.store.autoFormat,
            customUploaderRequestURL: settings.store.customUploaderRequestURL,
            customUploaderFileFormName: settings.store.customUploaderFileFormName,
            customUploaderResponseType: settings.store.customUploaderResponseType,
            customUploaderURL: settings.store.customUploaderURL,
            customUploaderArgs: settings.store.customUploaderArgs,
            customUploaderHeaders: settings.store.customUploaderHeaders,
            customUploaderRequestMethod: settings.store.customUploaderRequestMethod,
            customUploaderBodyType: settings.store.customUploaderBodyType,
            loggingLevel: (settings.store.loggingLevel as LoggingLevel) ?? "errors",
            respectNitroLimit: settings.store.respectNitroLimit === "Yes",
            nitroTier: settings.store.nitroType,
            uploadTimeout: parseInt(settings.store.uploadTimeout || "300000", 10),
			useEmbedsVideo: settings.store.useEmbedsVideo
        }) as UploadResult & { useNativeUpload?: boolean; buffer?: ArrayBuffer };

        // If file is under Nitro limit, use Discord's native upload
        if (result.useNativeUpload && result.buffer && result.fileName) {
            log.debug("File under Nitro limit, using Discord's native upload", {
                fileName: result.fileName,
                fileSize: result.fileSize ? formatFileSize(result.fileSize) : "unknown"
            });

            // Clear progress bar since we're not using external upload
            clearAndForceHide();

            // Create a File object from the buffer
            const file = new File([result.buffer], result.fileName);

            // Use Discord's native UploadManager
            if (channelId) {
                UploadManager.addFiles({
                    channelId,
                    draftType: DraftType.ChannelMessage,
                    files: [{ file, platform: 1 }],
                    showLargeMessageDialog: false
                });
                showUploadNotification(`Using Discord upload for ${result.fileName}`, Toasts.Type.MESSAGE);
            }
            return;
        }
        log.debug("Native.pickAndUploadFile result:", result);

        if (!result.success) {
            clearAndForceHide();

            if (result.error === "File selection cancelled") {
                showUploadNotification("File selection cancelled", Toasts.Type.MESSAGE);
                return;
            }

            if (result.error === "Upload cancelled by user") {
                showUploadNotification("Upload cancelled", Toasts.Type.FAILURE);
                return;
            }

            showUploadNotification(`Upload failed: ${result.error}`, Toasts.Type.FAILURE);
            if (channelId) {
                try {
                    UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                    UploadManager.clearAll(channelId, DraftType.SlashCommand);
                } catch (clearError) {
                    log.warn("Failed to clear native upload UI:", clearError);
                }
            }
            return;
        }

        // Send URL to chat
        if (result.url) {
            if (result.fileName) {
                const formattedSize = typeof result.fileSize === "number" ? formatFileSize(result.fileSize) : "unknown size";
                log.debug(`Manual upload completed for ${result.fileName} (${formattedSize}) via ${result.actualUploader || selectedUploader}`);
            }

            // Send text first, then atomically complete + dispatch to prevent race condition
            sendTextToChat(`${result.url}`);
            showUploadNotification(`${result.fileName} uploaded successfully`, Toasts.Type.SUCCESS);
            notifyFallbackInfo(result);

            // Use atomic completeAndDispatch to set both isComplete and isDispatched together
            // This prevents race conditions where one state is set but not the other
            if (result.uploadId) {
                log.debug("Using atomic completeAndDispatch for manual upload", { uploadId: result.uploadId });
                completeAndDispatch(result.uploadId);
            } else {
                log.debug("Manual upload succeeded without uploadId, using markDispatched fallback");
                markDispatched();
            }
        }

        if (channelId) {
            try {
                UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                UploadManager.clearAll(channelId, DraftType.SlashCommand);
            } catch (clearError) {
                log.warn("Failed to clear native upload UI:", clearError);
            }
        }
    } catch (error) {
        log.error(`Manual upload failed (uploader: ${settings.store.fileUploader || "Catbox"}):`, error);
        showUploadNotification(`Upload failed unexpectedly: ${getErrorMessage(error)}`, Toasts.Type.FAILURE);

        // Clear progress bar on error - force immediate hide
        clearAndForceHide();
        await Native.clearProgress();

        // Clear Discord's native upload UI on error too
        const channelId = SelectedChannelStore.getChannelId();
        if (channelId) {
            try {
                UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                UploadManager.clearAll(channelId, DraftType.SlashCommand);
            } catch (clearError) {
                log.warn("Failed to clear native upload UI on error:", clearError);
            }
        }
    }
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

// Paste event handler
async function handlePaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    // CRITICAL: Prevent Discord from also processing this paste event
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Check if ALL files are under Nitro limit - if so, use Discord's native UploadManager
    const allUnderNitroLimit = fileArray.every(file => shouldUseNativeUpload(file.size));
    if (allUnderNitroLimit) {
        log.debug("All files under Nitro limit, using Discord's native upload", {
            nitroLimit: formatFileSize(getNitroLimit()),
            files: fileArray.map(f => ({ name: f.name, size: formatFileSize(f.size) }))
        });

        const channelId = SelectedChannelStore.getChannelId();
        if (channelId) {
            // Use Discord's native UploadManager to handle the files
            UploadManager.addFiles({
                channelId,
                draftType: DraftType.ChannelMessage,
                files: fileArray.map(file => ({ file, platform: 1 })),
                showLargeMessageDialog: false
            });
        }
        return;
    }

    const channelId = SelectedChannelStore.getChannelId();

    if (!channelId) {
        showToast("Please select a channel before uploading", Toasts.Type.FAILURE);
        return;
    }

    // Clear Discord's native upload modal immediately (same as drag-and-drop)
    UploadManager.clearAll(channelId, DraftType.ChannelMessage);
    UploadManager.clearAll(channelId, DraftType.SlashCommand);

    log.info("Paste intercepted (files exceed Nitro limit)");
    log.debug("Paste handler received files:", fileArray.map(file => ({
        name: file.name,
        size: formatFileSize(file.size),
        type: file.type || "unknown"
    })));

    // Start batch upload tracking for all files (even single files)
    startUploadBatch(fileArray.length);

    // Upload each file using the secure buffer method
    for (const file of fileArray) {
        try {
            await handleSmallFileUpload(file, true); // true = skip batch start since we already started it
        } catch (error) {
            log.error("Paste upload error:", error);
            showUploadNotification(`Failed to upload '${file.name}'. Try again or use the Upload button.`, Toasts.Type.FAILURE);
        }
    }
}

// Set the upload function for dragDrop.ts to use
setUploadFunction(handleSmallFileUpload);

// Set the Nitro limit checker for dragDrop.ts to use
setNitroLimitChecker(shouldUseNativeUpload);


export default definePlugin({
    name: "BigFileUpload",
    description: "Bypass Discord's upload limit by uploading to external file uploaders via drag-drop, paste, or the Upload button.",
    authors: [Devs.ScattrdBlade],
    settings,
    dependencies: ["CommandsAPI"],


    patches: [
        {
            find: "formWithLoadedChatInput",
            replacement: {
                // Insert progress bar before the form
                // The actual webpack code: (0,i.jsxs)("form",{ref:this.inputFormRef,onSubmit:e4,className:
                match: /\(0,i\.jsxs\)\("form",\{ref:this\.inputFormRef/,
                replace: '$self.renderProgressBar(),(0,i.jsxs)("form",{ref:this.inputFormRef'
            }
        }
    ],


    start() {
        // Start progress polling for the progress bar
        startProgressPolling();
        startNativeNotificationPolling();
        log.debug("Progress polling initialized from plugin start");

        // Enable drag-and-drop if enabled in settings
        if (settings.store.dragAndDropEnabled !== "No") {
            enableDragDropOverride();
            log.info("Drag-and-drop enabled");
        } else {
            log.info("Drag-and-drop disabled by user settings");
        }

        // Enable paste handler separately if enabled in settings
        if (settings.store.pasteEnabled !== "No") {
            document.addEventListener("paste", handlePaste, { capture: true });
            log.info("Paste interception enabled");
        } else {
            log.info("Paste interception disabled by user settings");
        }
    },

    stop() {
        // Stop progress polling to prevent memory leaks
        stopProgressPolling();

        // Disable drag-and-drop
        disableDragDropOverride();

        // Disable paste
        document.removeEventListener("paste", handlePaste, { capture: true });
        log.info("BigFileUpload disabled");

        stopNativeNotificationPolling();
    },

    // Following SpotifyControls pattern - render the component directly
    renderProgressBar() {
        return React.createElement(UploadProgressBar);
    },

    contextMenus: {
        "channel-attach": ctxMenuPatch,
    },
});
