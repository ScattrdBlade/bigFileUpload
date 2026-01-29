/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Progress tracking system for file uploads
 * Manages upload progress state for the progress bar component
 */

import { pluginLogger as log } from "../logging";

export interface UploadProgress {
    uploadId: string;
    fileName: string;
    loaded: number;
    total: number;
    percent: number;
    speed: number;
    eta: number;
    transferred: number;
}

// Global progress state for multiple uploads
// Maps uploadId to progress
export const activeUploads = new Map<string, UploadProgress>();

// Currently displayed upload (for single progress bar view)
export let currentUploadId: string | null = null;

// Completion state - used to show "Upload Complete" briefly before hiding
export let isComplete = false;
let completionLogReported = false;

// Dispatched state - URL has been pasted into chat
export let isDispatched = false;

// Force hide state - used to immediately hide on error
export let forceHide = false;

// Total number of files being uploaded
export let totalFiles = 0;
export let completedFiles = 0;

// Reference to Native helpers
const Native = VencordNative.pluginHelpers.BigFileUpload as any;

// Check if native module is available
function isNativeAvailable(): boolean {
    return Native != null && typeof Native.getLatestProgress === "function";
}

// Store polling interval ID for cleanup
let progressPollingInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start polling for progress updates from the native layer
 * The progress bar component will read from currentProgress
 * Returns a cleanup function to stop polling
 */
export function startProgressPolling(): () => void {
    if (typeof window === "undefined") return () => { };

    // Don't start if native module isn't available (browser extension)
    if (!isNativeAvailable()) {
        log.debug("Native module not available, skipping progress polling");
        return () => { };
    }

    // Don't start multiple polling intervals
    if (progressPollingInterval !== null) {
        log.debug("Progress polling already running, skipping duplicate start");
        return () => stopProgressPolling();
    }

    log.debug("Starting progress polling...");

    // Poll for progress updates every 250ms (quarter second)
    // Matches component polling for responsive progress bar
    progressPollingInterval = setInterval(async () => {
        try {
            if (!isNativeAvailable()) return;
            const progress = await Native.getLatestProgress();

            if (progress) {
                log.debug("Progress poll received:", { uploadId: progress.uploadId, percent: progress.percent });
                const existing = activeUploads.get(progress.uploadId);

                // Optimization: Only update state if progress changed significantly (>1%)
                // or if this is a new upload. This reduces unnecessary re-renders.
                const isNewUpload = !existing;
                const percentChange = existing ? Math.abs(progress.percent - existing.percent) : 100;
                const isSignificantChange = percentChange >= 1;

                // Also update on completion (100%) or when starting (0%)
                const isCompletionOrStart = progress.percent >= 100 || progress.percent === 0;

                if (isNewUpload || isSignificantChange || isCompletionOrStart) {
                    activeUploads.set(progress.uploadId, {
                        ...progress,
                        transferred: progress.loaded
                    });

                    if (isNewUpload) {
                        log.debug(`New upload tracked: ${progress.uploadId}`);
                    }
                }

                // If no current upload is selected, set this as current
                if (!currentUploadId || !activeUploads.has(currentUploadId)) {
                    currentUploadId = progress.uploadId;
                    log.debug("Set currentUploadId to:", currentUploadId);
                }
            } else if (!isComplete && activeUploads.size === 0) {
                // No progress and no active uploads
                currentUploadId = null;
            }
        } catch (pollError) {
            log.error("Progress polling error:", pollError);
        }
    }, 250);

    // Return cleanup function
    return () => stopProgressPolling();
}

/**
 * Stop progress polling (cleanup function)
 */
export function stopProgressPolling(): void {
    if (progressPollingInterval !== null) {
        clearInterval(progressPollingInterval);
        progressPollingInterval = null;
    }
}

/**
 * Complete an upload and show completion state briefly
 */
export function completeUpload(uploadId: string) {
    const before = { active: activeUploads.size, completed: completedFiles, total: totalFiles };

    // Check if already removed (prevent double completion)
    if (!activeUploads.has(uploadId)) {
        log.debug("completeUpload skipped (already completed)", { uploadId });
        return;
    }

    // Remove from active uploads
    activeUploads.delete(uploadId);

    // Increment completed files with validation
    completedFiles++;
    if (completedFiles > totalFiles && totalFiles > 0) {
        log.warn(`completedFiles (${completedFiles}) exceeds totalFiles (${totalFiles}), capping`);
        completedFiles = totalFiles;
    }

    // If all files are complete, show completion state
    if (activeUploads.size === 0) {
        isComplete = true;
        completionLogReported = false;
        // Clear native-side progress immediately to prevent re-polling stale data
        if (isNativeAvailable()) Native.clearProgress();
    } else {
        // Switch to next upload if current one completed
        if (currentUploadId === uploadId) {
            const nextUpload = activeUploads.keys().next().value;
            currentUploadId = nextUpload || null;
        }
    }

    log.debug("completeUpload", { uploadId, before, after: { active: activeUploads.size, completed: completedFiles }, allDone: activeUploads.size === 0 });
}

/**
 * Atomically complete an upload AND mark as dispatched in a single operation.
 * This prevents race conditions where completion and dispatch happen separately,
 * which could leave the progress bar stuck if an error occurs between the two calls.
 * Use this for single-file uploads where the URL is sent to chat immediately after upload.
 */
export function completeAndDispatch(uploadId: string): void {
    const before = { active: activeUploads.size, completed: completedFiles, total: totalFiles };

    // Check if already removed (prevent double completion)
    if (!activeUploads.has(uploadId)) {
        log.debug("completeAndDispatch skipped (already completed)", { uploadId });
        return;
    }

    // Remove from active uploads
    activeUploads.delete(uploadId);

    // Increment completed files with validation
    completedFiles++;
    if (completedFiles > totalFiles && totalFiles > 0) {
        log.warn(`completedFiles (${completedFiles}) exceeds totalFiles (${totalFiles}), capping`);
        completedFiles = totalFiles;
    }

    // Set both states atomically (no timing gap between them)
    if (activeUploads.size === 0) {
        isComplete = true;
        isDispatched = true; // Set dispatch at same time to prevent race condition
        completionLogReported = false;
        // Clear native-side progress immediately
        if (isNativeAvailable()) Native.clearProgress();
    } else {
        // Multiple files: switch to next upload, don't mark dispatched yet
        if (currentUploadId === uploadId) {
            const nextUpload = activeUploads.keys().next().value;
            currentUploadId = nextUpload || null;
        }
    }

    log.debug("completeAndDispatch", { uploadId, before, after: { active: activeUploads.size, completed: completedFiles }, dispatched: isDispatched });
}

// Export for progress bar component to access
export function getCurrentProgress(): UploadProgress | null {
    if (!currentUploadId) {
        // Only log occasionally to avoid spam (every ~2 seconds)
        if (Math.random() < 0.1) {
            log.debug("getCurrentProgress: no currentUploadId, activeUploads.size =", activeUploads.size);
        }
        return null;
    }
    const progress = activeUploads.get(currentUploadId) || null;
    return progress;
}

// Get all active uploads
export function getAllUploads(): UploadProgress[] {
    return Array.from(activeUploads.values());
}

// Export completion state
export function getIsComplete(): boolean {
    if (!isComplete) {
        completionLogReported = false;
        return false;
    }

    if (!completionLogReported) {
        log.debug(`getIsComplete() returning true (activeUploads: ${activeUploads.size}, completedFiles: ${completedFiles}/${totalFiles})`);
        completionLogReported = true;
    }
    return isComplete;
}

// Export dispatched state (URL has been pasted)
export function getIsDispatched(): boolean {
    return isDispatched;
}

// Mark URL as dispatched (pasted into chat)
export function markDispatched(): void {
    log.debug("markDispatched() called - URL has been pasted");
    isDispatched = true;
}

// Export force hide state
export function getForceHide(): boolean {
    return forceHide;
}

// Set force hide immediately (for error handling)
export function setForceHide(value: boolean): void {
    log.debug(`Setting forceHide to ${value}`);
    forceHide = value;
}

// Clear all global state (called when progress bar hides)
export function clearGlobalState(): void {
    log.debug("clearGlobalState() called");
    activeUploads.clear();
    currentUploadId = null;
    isComplete = false;
    isDispatched = false;
    completionLogReported = false;
    forceHide = false; // Don't force hide by default
    totalFiles = 0;
    completedFiles = 0;

    // Also clear native progress to ensure clean state
    if (isNativeAvailable()) Native.clearProgress();
}

// Clear state and force hide (for errors only)
export function clearAndForceHide(): void {
    forceHide = true; // Force immediate hide
    clearGlobalState();

    // Reset forceHide after a short delay to allow component to react
    setTimeout(() => {
        forceHide = false;
    }, 500);
}

// Start a new batch of uploads
export function startUploadBatch(fileCount: number): void {
    const previousState = { totalFiles, completedFiles, activeUploads: activeUploads.size, isComplete };
    const wasComplete = isComplete;

    // Clear any lingering completion state from previous uploads
    if (isComplete) {
        clearGlobalState();
    }

    // If uploads are already in progress, ADD to the batch instead of resetting
    // This handles the case where user drops another file while upload is running
    if (activeUploads.size > 0 && !isComplete) {
        totalFiles += fileCount;
        log.debug("startUploadBatch (adding to existing)", { fileCount, newTotal: totalFiles, previousState });
    } else {
        // Fresh batch - reset counters
        totalFiles = fileCount;
        completedFiles = 0;
        isComplete = false;
        isDispatched = false;
        completionLogReported = false;
        forceHide = false; // Reset force hide when starting new upload
        log.debug("startUploadBatch (fresh)", { fileCount, previousState, clearedPrevious: wasComplete });
    }

    // Immediately poll for progress to eliminate initial delay
    // The native side may already have set initial progress
    void (async () => {
        try {
            if (!isNativeAvailable()) return;
            const progress = await Native.getLatestProgress();
            if (progress) {
                activeUploads.set(progress.uploadId, {
                    ...progress,
                    transferred: progress.loaded
                });
                if (!currentUploadId) {
                    currentUploadId = progress.uploadId;
                }
                log.debug("Immediate progress poll found upload:", progress.uploadId);
            }
        } catch (e) {
            // Ignore errors in immediate poll
        }
    })();
}

// Switch to viewing a different upload
export function switchToUpload(uploadId: string): void {
    if (activeUploads.has(uploadId)) {
        currentUploadId = uploadId;
    }
}

// Cancel an upload
export async function cancelUploadTracking(uploadId: string): Promise<boolean> {
    log.debug(`Cancelling upload: ${uploadId}`);

    // Check if native module is available
    if (!isNativeAvailable()) {
        log.error("Cannot cancel upload: native module not available");
        return false;
    }

    try {
        // Call native cancel function
        const result = await Native.cancelUpload(uploadId);

        if (result.success) {
            // Remove from active uploads
            activeUploads.delete(uploadId);

            // If this was the current upload, switch to next one or clear
            if (currentUploadId === uploadId) {
                const nextUpload = activeUploads.keys().next().value;
                currentUploadId = nextUpload || null;

                // If no more uploads, clear everything immediately
                if (!currentUploadId) {
                    clearGlobalState();
                }
            }

            log.info(`Upload ${uploadId} cancelled successfully`);
            return true;
        } else {
            log.error(`Failed to cancel upload ${uploadId}: ${result.error}`);
            return false;
        }
    } catch (error) {
        log.error(`Error cancelling upload ${uploadId}:`, error);
        return false;
    }
}
