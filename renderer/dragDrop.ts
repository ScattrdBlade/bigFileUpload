/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Handles drag-and-drop override and paste interception helpers
 * Exposes functions consumed by the renderer entry
 */

import { ChannelStore, DraftStore, DraftType, SelectedChannelStore, showToast, Toasts, UploadAttachmentStore, UploadManager } from "@webpack/common";

import { pluginLogger as log } from "../logging";
import { formatFileSize } from "./formatting";
import { startUploadBatch } from "./progress";

// Upload function will be injected by index.tsx
// Second arg: skipBatchStart - true when caller already called startUploadBatch
let uploadBufferFn: ((file: File, skipBatchStart?: boolean) => Promise<void>) | null = null;

// Nitro limit checker function - injected by index.tsx
let shouldUseNativeUploadFn: ((fileSize: number) => boolean) | null = null;

// Visual overlay element
let dragOverlay: HTMLDivElement | null = null;

// Drag-and-drop size limit (1GB)
export const DRAG_DROP_MAX_SIZE = 1024 * 1024 * 1024;

export function setUploadFunction(fn: (file: File, skipBatchStart?: boolean) => Promise<void>) {
    uploadBufferFn = fn;
}

export function setNitroLimitChecker(fn: (fileSize: number) => boolean) {
    shouldUseNativeUploadFn = fn;
}

function showDragOverlay() {
    if (dragOverlay) return;
    log.debug("Creating drag overlay for secure upload prompt");

    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    const channelName = channel?.name || "channel";

    dragOverlay = document.createElement("div");
    dragOverlay.className = "vc-bfu-drag-overlay";

    const content = document.createElement("div");
    content.className = "vc-bfu-drag-content";

    const icon = document.createElement("img");
    icon.src = "https://media.discordapp.net/stickers/1039992459209490513.png";
    icon.className = "vc-bfu-drag-icon";

    const text = document.createElement("div");
    text.textContent = "Upload to #" + channelName;
    text.className = "vc-bfu-drag-text";

    const subtext = document.createElement("div");
    subtext.textContent = "Using BigFileUpload (Max 1GB via drag-and-drop)";
    subtext.className = "vc-bfu-drag-subtext";

    content.appendChild(icon);
    content.appendChild(text);
    content.appendChild(subtext);
    dragOverlay.appendChild(content);

    document.body.appendChild(dragOverlay);
}

function hideDragOverlay() {
    if (dragOverlay) {
        dragOverlay.remove();
        dragOverlay = null;
    }
}

// Use counter instead of boolean to handle nested drag events correctly
// Each dragenter increments, each dragleave decrements, hide overlay when counter reaches 0
let dragEnterCount = 0;

/**
 * True when we must not show the overlay or intercept (let Discord handle natively):
 * - Forum: only when creating a new post (new-post composer open), not when inside an existing post/thread.
 * - Slash command: user has draft or attachments in slash command context.
 * Uses project stores only (ChannelStore, DraftStore, UploadAttachmentStore) - no DOM.
 */
export function isForumOrSlashCommandContextForChannel(channelId: string | null): boolean {
    if (!channelId) return false;
    try {
        const channel = ChannelStore.getChannel(channelId);
        // Forum: only skip when in forum channel AND new-post composer is open (thread settings),
        // not when inside an existing post/thread (then channel is the thread, not the forum)
        if (channel?.isForumChannel?.() && DraftStore.getThreadSettings(channelId)) return true;
        // Slash command: user has draft or attachments in slash command context
        if (DraftStore.getDraft(channelId, DraftType.SlashCommand)?.trim()) return true;
        if (UploadAttachmentStore.getUploadCount(channelId, DraftType.SlashCommand) > 0) return true;
    } catch {
        // Stores may not be ready
        return false;
    }
    return false;
}

function hasFileItems(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer?.items?.length) return false;
    for (let i = 0; i < dataTransfer.items.length; i++) {
        if (dataTransfer.items[i].kind === "file") {
            return true;
        }
    }
    return false;
}

function handleDragEnter(e: DragEvent) {
    if (!hasFileItems(e.dataTransfer)) return;

    // Do not show overlay or intercept when user is uploading to forum post or slash command
    const channelId = SelectedChannelStore.getChannelId();
    if (isForumOrSlashCommandContextForChannel(channelId)) {
        log.debug("Drag over forum/slash context, not showing overlay");
        return;
    }

    dragEnterCount++;
    log.debug("handleDragEnter invoked", {
        dragEnterCount,
        itemCount: e.dataTransfer?.items?.length ?? 0
    });

    e.preventDefault();
    e.stopPropagation();

    // Only show overlay on first enter
    if (dragEnterCount === 1) {
        showDragOverlay();
    }
}

function handleDragOver(e: DragEvent) {
    // Do not intercept when in forum/slash context so Discord can receive the drop
    if (isForumOrSlashCommandContextForChannel(SelectedChannelStore.getChannelId())) return;

    // Must prevent default for drop to work
    if (dragEnterCount > 0 || hasFileItems(e.dataTransfer)) {
        e.preventDefault();
        e.stopPropagation();
    }
}

function handleDragLeave(e: DragEvent) {
    if (dragEnterCount <= 0) return;

    dragEnterCount--;
    log.debug("handleDragLeave invoked", {
        dragEnterCount,
        isWindowLeave: e.relatedTarget === null
    });

    e.stopPropagation();

    // Hide overlay when counter reaches 0 (all drag leaves processed)
    if (dragEnterCount === 0) {
        hideDragOverlay();
    }
}

const FirstThreadMessageDraftType = 2;

function clearAllDraftTypesInDrop(channelId: string) {
    try {
        UploadManager.clearAll(channelId, DraftType.ChannelMessage);
        UploadManager.clearAll(channelId, DraftType.SlashCommand);
        UploadManager.clearAll(channelId, (DraftType as Record<string, number>).FirstThreadMessage ?? FirstThreadMessageDraftType);
    } catch (err) {
        log.warn("Failed to clear native upload UI:", err);
    }
}

export async function handleDrop(e: DragEvent) {
    log.debug("handleDrop received event", {
        fileCount: e.dataTransfer?.files?.length ?? 0
    });
    if (!e.dataTransfer?.files?.length) return;

    const channelId = SelectedChannelStore.getChannelId();

    // Do not intercept when user is dropping onto forum post or slash command input
    if (isForumOrSlashCommandContextForChannel(channelId)) {
        log.debug("Drop on forum/slash context, not intercepting");
        hideDragOverlay();
        dragEnterCount = 0;
        return;
    }

    const files = Array.from(e.dataTransfer.files);

    // Check if ALL files are under Nitro limit - use Discord's native upload.
    // We must call UploadManager.addFiles (not just return) because we already
    // preventDefault/stopPropagation on dragEnter/dragOver, so the drop never
    // reaches Discord if we only return.
    if (shouldUseNativeUploadFn) {
        const allUnderNitroLimit = files.every(file => shouldUseNativeUploadFn!(file.size));
        if (allUnderNitroLimit) {
            log.debug("All files under Nitro limit, using Discord native upload", {
                files: files.map(f => ({ name: f.name, size: formatFileSize(f.size) }))
            });
            hideDragOverlay();
            dragEnterCount = 0;
            if (channelId) {
                UploadManager.addFiles({
                    channelId,
                    draftType: DraftType.ChannelMessage,
                    files: files.map(file => ({ file, platform: 1 })),
                    showLargeMessageDialog: false
                });
            }
            return;
        }
    }

    e.preventDefault();
    e.stopPropagation();

    hideDragOverlay();
    dragEnterCount = 0;

    if (!uploadBufferFn) return;

    log.debug("Processing drop for channel", { channelId });

    if (!channelId) {
        showToast("Please select a channel before uploading", Toasts.Type.FAILURE);
        return;
    }

    clearAllDraftTypesInDrop(channelId);

    log.debug(`Drag-and-drop: ${files.length} file(s) (exceeds Nitro limit)`, files.map(file => ({
        name: file.name,
        size: formatFileSize(file.size),
        type: file.type || "unknown"
    })));

    startUploadBatch(files.length);

    for (const file of files) {
        try {
            if (file.size > DRAG_DROP_MAX_SIZE) {
                showToast(
                    `'${file.name}' is too large (${formatFileSize(file.size)}). Drag-and-drop limit is ${formatFileSize(DRAG_DROP_MAX_SIZE)}. Use the Upload button for larger files.`,
                    Toasts.Type.FAILURE
                );
                continue;
            }

            log.debug("Dispatching uploadBufferFn for dropped file", {
                fileName: file.name,
                fileSize: file.size
            });
            // Pass true for skipBatchStart since we already called startUploadBatch above
            await uploadBufferFn(file, true);

        } catch (error) {
            log.error(`Drag-and-drop upload failed for '${file.name}':`, error);
            showToast(`Failed to upload '${file.name}'. Try again or use the Upload button.`, Toasts.Type.FAILURE);
        }
    }
}

export function enableDragDropOverride() {
    document.addEventListener("dragenter", handleDragEnter, { capture: true });
    document.addEventListener("dragover", handleDragOver, { capture: true });
    document.addEventListener("dragleave", handleDragLeave, { capture: true });
    document.addEventListener("drop", handleDrop, { capture: true });
    log.debug("SECURE drag-and-drop override registered");
}

export function disableDragDropOverride() {
    document.removeEventListener("dragenter", handleDragEnter, { capture: true });
    document.removeEventListener("dragover", handleDragOver, { capture: true });
    document.removeEventListener("dragleave", handleDragLeave, { capture: true });
    document.removeEventListener("drop", handleDrop, { capture: true });
    hideDragOverlay();
    dragEnterCount = 0;
}
