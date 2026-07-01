/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { OpenExternalIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { CloudUpload } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { ChannelStore, DraftStore, DraftType, FluxDispatcher, Menu, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, Toasts, UploadAttachmentStore, useEffect, UserStore, useState } from "@webpack/common";

import { settings } from "./settings";
import { serviceLabels, ServiceType } from "./types";
import { getMediaUrl } from "./utils/getMediaUrl";
import { cancelCurrentUpload, getUploadState, isConfigured, isFileTypeAllowed, logger, subscribeUploadState, uploadFile, uploadPickedFile, uploadProvidedFiles } from "./utils/upload";
const cl = classNameFactory("vc-file-upload-");
const { getUserMaxFileSize } = findByPropsLazy("getUserMaxFileSize");
const discordFilesExceedLimit = findByCodeLazy("web.filesExceedUploadLimits", "Array.from", ".size") as (files: readonly File[], guildId: string | null) => boolean;
let uploadAddFilesInterceptor: ((event: unknown) => void) | null = null;
let pasteEventListener: ((event: ClipboardEvent) => void) | null = null;
let dragOverListener: ((event: Event) => void) | null = null;
let dropEventListener: ((event: Event) => void) | null = null;
const handledDropFiles = new WeakSet<File>();

type UploadAddFilesEvent = {
    type: string;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
    draftType?: unknown;
    channelId?: string;
};

function getGuildIdForChannel(channelId: string | null | undefined): string | null {
    if (!channelId) return null;
    try {
        const channel = ChannelStore.getChannel(channelId) as { getGuildId?: () => string | null; guild_id?: string | null; } | null;
        return channel?.getGuildId?.() ?? channel?.guild_id ?? null;
    } catch {
        return null;
    }
}

function shouldInterceptUploadFiles(files: readonly File[], guildId: string | null): boolean {
    if (!settings.store.bypassDiscordUploadOnlyOverLimit) return true;

    try {
        return Boolean(discordFilesExceedLimit(files, guildId));
    } catch {
        const fallbackLimit = getUserMaxFileSize(UserStore.getCurrentUser());
        return files.some(file => file.size > Math.max(0, fallbackLimit));
    }
}
function extractFilesFromValue(value: unknown): File[] {
    if (value instanceof File) return [value];

    if (!Array.isArray(value)) return [];

    return value.flatMap(entry => {
        if (entry instanceof File) return [entry];

        if (!entry || typeof entry !== "object") return [];

        const uploadFile = "file" in entry ? entry.file : null;
        if (uploadFile instanceof File) return [uploadFile];

        const item = "item" in entry && entry.item && typeof entry.item === "object" ? entry.item : null;
        if (!item || !("file" in item)) return [];

        return item.file instanceof File ? [item.file] : [];
    });
}

function interceptUploadAddFiles(event: unknown): void {
    if (!event || typeof event !== "object" || !("type" in event)) return;

    const payload = event as UploadAddFilesEvent;
    if (payload.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;

    if (payload.draftType !== DraftType.ChannelMessage) return;

    if (!settings.store.bypassDiscordUpload || !isConfigured()) return;

    const files = [
        ...extractFilesFromValue(payload.files),
        ...extractFilesFromValue(payload.uploads),
        ...extractFilesFromValue(payload.items)
    ];
    const uniqueFiles = Array.from(new Set(files)).filter(f => isFileTypeAllowed(f) && !handledDropFiles.has(f));

    if (!uniqueFiles.length) return;
    if (!shouldInterceptUploadFiles(uniqueFiles, getGuildIdForChannel(payload.channelId))) return;

    payload.files = [];
    payload.uploads = [];
    payload.items = [];
    void uploadProvidedFiles(uniqueFiles);
}

function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length === 0) return;

    if (!settings.store.autoUploadPastedFiles || !isConfigured()) return;

    const allowed = files.filter(f => isFileTypeAllowed(f));
    if (allowed.length === 0) return;
    if (!shouldInterceptUploadFiles(allowed, getGuildIdForChannel(SelectedChannelStore.getChannelId()))) return;

    event.preventDefault();
    event.stopPropagation();

    void uploadProvidedFiles(allowed);
}

function isForumOrSlashContext(channelId: string | null): boolean {
    if (!channelId) return false;
    try {
        const channel = ChannelStore.getChannel(channelId);
        if (channel?.isForumChannel?.() && DraftStore.getThreadSettings(channelId)) return true;
        if (DraftStore.getDraft(channelId, DraftType.SlashCommand)?.trim()) return true;
        const slashUploads = UploadAttachmentStore.getUploads(channelId, DraftType.SlashCommand);
        if (Array.isArray(slashUploads) && slashUploads.length > 0) return true;
    } catch {
        return false;
    }
    return false;
}

const CHAT_DROP_ZONE_SELECTOR = "[class*=\"messagesWrapper\"], [class*=\"chatContent\"], [class*=\"channelTextArea\"]";

function isChatAreaDrop(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(CHAT_DROP_ZONE_SELECTOR));
}

function handleDragOver(event: DragEvent): void {
    if (!settings.store.bypassDragDrop) return;
    if (!isChatAreaDrop(event.target)) return;
    if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
        event.preventDefault();
    }
}

function handleFileDrop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;

    if (!settings.store.bypassDragDrop || !isConfigured()) return;
    if (!isChatAreaDrop(event.target)) return;
    if (isForumOrSlashContext(SelectedChannelStore.getChannelId())) return;

    const allowed = files.filter(f => isFileTypeAllowed(f));
    if (!allowed.length) return;
    if (!shouldInterceptUploadFiles(allowed, getGuildIdForChannel(SelectedChannelStore.getChannelId()))) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    allowed.forEach(file => handledDropFiles.add(file));
    void uploadProvidedFiles(allowed);
}

function formatBytes(bytes: number): string {
    if (!bytes) return "";

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const ProgressBarInner = () => {
    const [state, setState] = useState(getUploadState);

    useEffect(() => subscribeUploadState(() => setState(getUploadState())), []);

    if (state.phase === "idle") return null;

    const percentage = Math.max(0, Math.min(100, state.percent));
    const progressLabel = state.totalBytes > 0
        ? `${Math.round(percentage)}% - ${formatBytes(state.transferredBytes)} of ${formatBytes(state.totalBytes)}`
        : `${Math.round(percentage)}%`;

    return (
        <div
            className={cl("progress-wrap")}
            data-phase={state.phase}
        >
            <div className={cl("progress-head")}>
                <div className={cl("progress-label")}>
                    {state.status || "Uploading..."}
                </div>
                <div className={cl("progress-meta")}>
                    <span className={cl("progress-percent")}>
                        {progressLabel}
                    </span>
                    {state.canCancel && (
                        <button
                            className={cl("progress-cancel")}
                            type="button"
                            onClick={cancelCurrentUpload}
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>
            <div className={cl("progress-track")}>
                <div
                    className={cl("progress-fill")}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <div className={cl("progress-file")}>
                {state.fileName || ""}{state.currentServiceLabel ? ` • ${state.currentServiceLabel}` : ""}
            </div>
        </div>
    );
};

const ProgressBar = ErrorBoundary.wrap(ProgressBarInner, { noop: true });

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    const { itemSrc, itemHref, target } = props;
    const url = getMediaUrl({ src: itemSrc, href: itemHref, target });

    if (!url) return;

    const group = findGroupChildrenByChildId("open-native-link", children)
        ?? findGroupChildrenByChildId("copy-link", children);

    if (group && !group.some(child => child?.props?.id === "file-upload")) {
        const serviceType = settings.store.serviceType as ServiceType;
        const serviceName = serviceLabels[serviceType];

        group.push(
            <Menu.MenuItem
                label={`Upload to ${serviceName}`}
                key="file-upload"
                id="file-upload"
                action={() => uploadFile(url)}
            />
        );
    }
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    if ("href" in props && !props.src) return;

    const url = getMediaUrl(props);
    if (!url) return;

    if (children.some(child => child?.props?.id === "file-upload-group")) return;

    const serviceType = settings.store.serviceType as ServiceType;
    const serviceName = serviceLabels[serviceType];

    children.push(
        <Menu.MenuGroup id="file-upload-group">
            <Menu.MenuItem
                label={`Upload to ${serviceName}`}
                key="file-upload"
                id="file-upload"
                action={() => uploadFile(url)}
            />
        </Menu.MenuGroup>
    );
};

async function handleUploadFileFromDraft(upload: CloudUpload) {
    const file = upload.item?.file;
    if (!file) return;

    if (!isFileTypeAllowed(file)) {
        showToast("File type not allowed by current filter", Toasts.Type.FAILURE);
        return;
    }

    if (!isConfigured()) {
        showToast("Please configure BigFileUpload settings first", Toasts.Type.FAILURE);
        return;
    }

    try {
        await uploadProvidedFiles([file], true);
        upload.removeFromMsgDraft();
    } catch (e) {
        logger.warn("Draft upload encountered an unexpected error", e);
    }
}

const ExternalIcon = () => <OpenExternalIcon height={24} width={24} />;

const channelAttachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (channel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel)) return;
    if (children.some(child => child?.props?.id === "file-upload-manual" || child?.props?.id === "file-upload-uploads")) return;

    const uploads = UploadAttachmentStore.getUploads(channel.id, DraftType.ChannelMessage);
    const draftUploads = Array.isArray(uploads) ? uploads.filter((u: CloudUpload) => u.item?.file && isFileTypeAllowed(u.item.file)) : [];

    if (draftUploads.length > 0) {
        children.splice(1, 0,
            <Menu.MenuItem
                id="file-upload-uploads"
                key="file-upload-uploads"
                label="Upload to Host"
                iconLeft={ExternalIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: ExternalIcon
                }}
            >
                {draftUploads.map((upload: CloudUpload) => (
                    <Menu.MenuItem
                        id={`file-upload-draft-${upload.id}`}
                        key={upload.id}
                        label={upload.filename}
                        action={() => handleUploadFileFromDraft(upload)}
                    />
                ))}
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="file-upload-manual"
                    key="file-upload-manual"
                    label="Choose File..."
                    action={() => uploadPickedFile()}
                />
            </Menu.MenuItem>
        );
    } else {
        children.splice(1, 0,
            <Menu.MenuItem
                id="file-upload-manual"
                key="file-upload-manual"
                label="Upload to Host"
                iconLeft={ExternalIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: ExternalIcon
                }}
                action={() => uploadPickedFile()}
            />
        );
    }
};

export default definePlugin({
    name: "BigFileUpload",
    description: "Bypass Discord's upload limit by uploading to external file uploaders.",
    tags: ["Media"],
    authors: [Devs.ScattrdBlade, Devs.creations, { name: "Key", id: 1230319937155760131n }],
    settings,
    patches: [
        {
            find: ".CREATE_FORUM_POST||",
            replacement: {
                match: /(textValue:.{0,50}channelId:\i\.id\}\))(?:,\i(,))?/,
                replace: "$1,$self.renderUploadProgress()$2"
            }
        },
        // Forces an early return on the file size limit nitro upsell modal
        {
            find: "#{intl::tRuxk9::raw}",
            replacement: {
                match: /(?<=MAX_FILE_SIZE_250_MB.{0,250})Array\.from\(\i\)\.some/,
                replace: "$self.shouldBypassDiscordUploadSizeCheck()?false:$&"
            }
        },
        // Neuters the pre-upload size gate in promptToUpload that opens the "exceeds size limit" modal
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(if\()(\(0,\i\.\i\)\(\i,\i\))(\)return void \i\(\i,\i\);)/,
                replace: "$1$self.shouldBypassDiscordUploadSizeCheck()?false:$2$3"
            }
        },
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "channel-attach": channelAttachMenuPatch
    },
    start() {
        if (uploadAddFilesInterceptor) {
            return;
        }

        uploadAddFilesInterceptor = event => interceptUploadAddFiles(event);
        FluxDispatcher.addInterceptor(uploadAddFilesInterceptor);

        pasteEventListener = event => handlePaste(event);
        document.addEventListener("paste", pasteEventListener, true);

        dragOverListener = event => handleDragOver(event as DragEvent);
        document.addEventListener("dragover", dragOverListener, true);

        dropEventListener = event => handleFileDrop(event as DragEvent);
        document.addEventListener("drop", dropEventListener, true);
    },
    stop() {
        if (!uploadAddFilesInterceptor) {
            return;
        }

        const index = FluxDispatcher._interceptors.indexOf(uploadAddFilesInterceptor);
        if (index > -1) {
            FluxDispatcher._interceptors.splice(index, 1);
        }

        uploadAddFilesInterceptor = null;

        if (pasteEventListener) {
            document.removeEventListener("paste", pasteEventListener, true);
            pasteEventListener = null;
        }

        if (dragOverListener) {
            document.removeEventListener("dragover", dragOverListener, true);
            dragOverListener = null;
        }

        if (dropEventListener) {
            document.removeEventListener("drop", dropEventListener, true);
            dropEventListener = null;
        }
    },
    shouldBypassDiscordUploadSizeCheck(): boolean {
        return Boolean(settings.store.bypassDiscordUpload) && isConfigured();
    },
    renderUploadProgress() {
        return <ProgressBar />;
    }
});
