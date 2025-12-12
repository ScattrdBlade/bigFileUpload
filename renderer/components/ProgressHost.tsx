/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Manages the upload progress bar injection into the chat input area
 */

import { createRoot, React } from "@webpack/common";
import type { Root } from "react-dom/client";

import { startProgressPolling, stopProgressPolling } from "../progress";
import { UploadProgressBar } from "./UploadProgressBar";

let progressBarRoot: Root | null = null;
let progressBarContainer: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;

/**
 * Initialize the progress bar by injecting it into the DOM above the chat input
 */
export function initProgressBar() {
    // Start polling for progress updates
    startProgressPolling();

    // Run on DOM ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", injectProgressBar);
    } else {
        injectProgressBar();
    }

    // Also watch for navigation changes (channel switching)
    // Store reference for cleanup to prevent memory leak
    mutationObserver = new MutationObserver(() => {
        if (!progressBarContainer || !document.contains(progressBarContainer)) {
            injectProgressBar();
        }
    });

    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

/**
 * Update the progress bar container to match chat form dimensions
 */
function updateProgressBarDimensions() {
    if (!progressBarContainer) return;

    // Target the specific Discord chat form element
    const chatForm = document.querySelector("form.form_f75fb0") as HTMLElement ||
        document.querySelector('form[class*="form_"]') as HTMLElement ||
        document.querySelector('form[class*="form"]') as HTMLElement;

    if (!chatForm) return;

    // Get the computed style to match dimensions
    const computedStyle = window.getComputedStyle(chatForm);

    // Parse the width to get 1/2 of it
    const fullWidth = parseFloat(computedStyle.width);
    const halfWidth = fullWidth * 0.5;

    // Set to 1/2 width, aligned to left side
    progressBarContainer.style.width = `${halfWidth}px`;
    progressBarContainer.style.marginLeft = computedStyle.marginLeft;
    progressBarContainer.style.paddingLeft = computedStyle.paddingLeft;
    progressBarContainer.style.left = computedStyle.left;

    // No right margin/padding since we're only 1/4 width
    progressBarContainer.style.marginRight = "0";
    progressBarContainer.style.paddingRight = "0";
}

/**
 * Inject the progress bar container into the chat area
 */
function injectProgressBar() {
    // Don't inject multiple times
    if (progressBarContainer && document.contains(progressBarContainer)) {
        updateProgressBarDimensions();
        return;
    }

    // Target the specific Discord chat form element
    const chatForm = document.querySelector("form.form_f75fb0") as HTMLElement ||
        document.querySelector('form[class*="form_"]') as HTMLElement ||
        document.querySelector('form[class*="form"]') as HTMLElement;

    if (!chatForm) {
        // Chat area not found yet, will retry on next mutation
        return;
    }

    // Clean up any existing root before creating new one to prevent memory leak
    if (progressBarRoot) {
        try {
            progressBarRoot.unmount();
        } catch {
            // Ignore unmount errors
        }
        progressBarRoot = null;
    }

    // Clean up old container if it exists but was removed from DOM
    if (progressBarContainer) {
        progressBarContainer.remove();
        progressBarContainer = null;
    }

    // Clean up old resize observer
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }

    // Remove old resize listener before adding new one to prevent accumulation
    window.removeEventListener("resize", updateProgressBarDimensions);

    // Create container for progress bar
    progressBarContainer = document.createElement("div");
    progressBarContainer.id = "vc-bigfileupload-progress-bar";
    progressBarContainer.style.cssText = `
        position: relative;
        box-sizing: border-box;
        z-index: 10;
    `;

    // Set initial dimensions
    updateProgressBarDimensions();

    // Insert before the chat form (above chat input)
    chatForm.parentElement?.insertBefore(progressBarContainer, chatForm);

    // Render React component into container
    progressBarRoot = createRoot(progressBarContainer);
    progressBarRoot.render(React.createElement(UploadProgressBar));

    // Watch for chat form resize to update dimensions
    resizeObserver = new ResizeObserver(() => {
        updateProgressBarDimensions();
    });
    resizeObserver.observe(chatForm);

    // Also update on window resize
    window.addEventListener("resize", updateProgressBarDimensions);

    console.log("[BigFileUpload] Progress bar injected into chat area");
}

/**
 * Clean up the progress bar when plugin is disabled
 */
export function cleanupProgressBar() {
    if (progressBarRoot) {
        progressBarRoot.unmount();
        progressBarRoot = null;
    }

    if (progressBarContainer) {
        progressBarContainer.remove();
        progressBarContainer = null;
    }

    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }

    // Disconnect mutation observer to prevent memory leak
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    // Remove window resize listener
    window.removeEventListener("resize", updateProgressBarDimensions);

    // Stop progress polling to prevent memory leak
    stopProgressPolling();

    console.log("[BigFileUpload] Progress bar cleaned up");
}
