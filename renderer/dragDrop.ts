/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Handles drag-and-drop override and paste interception helpers
 * Exposes functions consumed by the renderer entry
 */

import { ChannelStore, DraftType, SelectedChannelStore, showToast, Toasts, UploadManager } from "@webpack/common";

import { pluginLogger as log } from "../logging";
import { formatFileSize } from "./formatting";
import { startUploadBatch } from "./progress";

// Upload function will be injected by index.tsx
let uploadBufferFn: ((file: File) => Promise<void>) | null = null;

// Nitro limit checker function - injected by index.tsx
let shouldUseNativeUploadFn: ((fileSize: number) => boolean) | null = null;

// Visual overlay element
let dragOverlay: HTMLDivElement | null = null;

// Drag-and-drop size limit (1GB)
export const DRAG_DROP_MAX_SIZE = 1024 * 1024 * 1024;

export function setUploadFunction(fn: (file: File) => Promise<void>) {
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
    dragOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(88, 101, 242, 0.3);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        pointer-events: none;
    `;

    const content = document.createElement("div");
    content.style.cssText = `
        background: rgba(88, 101, 242, 0.95);
        padding: 48px 64px;
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
    `;

    const icon = document.createElement("img");
    icon.src = "https://media.discordapp.net/stickers/1039992459209490513.png";
    icon.style.cssText = `
        width: 128px;
        height: 128px;
        animation: pulse 1.5s ease-in-out infinite;
    `;

    const text = document.createElement("div");
    text.textContent = "Upload to #" + channelName;
    text.style.cssText = `
        font-size: 24px;
        font-weight: 700;
        color: white;
        text-align: center;
    `;

    const subtext = document.createElement("div");
    subtext.textContent = "Using BigFileUpload (Max 1GB via drag-and-drop)";
    subtext.style.cssText = `
        font-size: 14px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.8);
        text-align: center;
    `;

    content.appendChild(icon);
    content.appendChild(text);
    content.appendChild(subtext);
    dragOverlay.appendChild(content);

    if (!document.getElementById("bigfileupload-animations")) {
        const style = document.createElement("style");
        style.id = "bigfileupload-animations";
        style.textContent = `
            @keyframes pulse {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.05); opacity: 0.9; }
            }
        `;
        document.head.appendChild(style);
    }

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

export async function handleDrop(e: DragEvent) {
    log.debug("handleDrop received event", {
        fileCount: e.dataTransfer?.files?.length ?? 0
    });
    if (!e.dataTransfer?.files?.length) return;

    const files = Array.from(e.dataTransfer.files);

    e.preventDefault();
    e.stopPropagation();

    // Check if ALL files are under Nitro limit - if so, use Discord's native UploadManager
    if (shouldUseNativeUploadFn) {
        const allUnderNitroLimit = files.every(file => shouldUseNativeUploadFn!(file.size));
        if (allUnderNitroLimit) {
            log.debug("All files under Nitro limit, using Discord's native upload", {
                files: files.map(f => ({ name: f.name, size: formatFileSize(f.size) }))
            });
            hideDragOverlay();
            dragEnterCount = 0;

            const channelId = SelectedChannelStore.getChannelId();
            if (channelId) {
                // Use Discord's native UploadManager to handle the files
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

    hideDragOverlay();
    dragEnterCount = 0;

    if (!uploadBufferFn) return;

    const channelId = SelectedChannelStore.getChannelId();
    log.debug("Processing drop for channel", { channelId });

    if (!channelId) {
        showToast("Please select a channel before uploading", Toasts.Type.FAILURE);
        return;
    }

    UploadManager.clearAll(channelId, DraftType.ChannelMessage);

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
            await uploadBufferFn(file);

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

    // Clean up the animation style element to prevent memory leak
    const animationStyle = document.getElementById("bigfileupload-animations");
    if (animationStyle) {
        animationStyle.remove();
    }
}
