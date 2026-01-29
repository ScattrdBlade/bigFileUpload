/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Upload progress bar component that appears above the chat input
 * Shows collapsed progress bar by default, expandable to show detailed stats
 */

import { PluginNative } from "@utils/types";
import { React, Toasts, useEffect, useState } from "@webpack/common";

import { pluginLogger as log } from "../../logging";
import { formatETA, formatFileSize } from "../formatting";
import { showUploadNotification } from "../notifications";
import { cancelUploadTracking, clearGlobalState, getAllUploads, getCurrentProgress, getForceHide, getIsComplete, getIsDispatched, switchToUpload, UploadProgress } from "../progress";

const Native = VencordNative.pluginHelpers.BigFileUpload as PluginNative<typeof import("../../native")>;

export function UploadProgressBar() {

    const [progress, setProgress] = useState<UploadProgress | null>(getCurrentProgress());
    const [allUploads, setAllUploads] = useState<UploadProgress[]>(getAllUploads());
    const [isComplete, setIsComplete] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isVisible, setIsVisible] = useState(false);
    const [barWidth, setBarWidth] = useState("50%");
    const [bgColor, setBgColor] = useState<string>("var(--input-background)");
    const [isCancelling, setIsCancelling] = useState(false);

    // Store updateWidth function ref so it can be called from visibility effect
    const updateWidthRef = React.useRef<(() => void) | null>(null);

    // On mount, clear any stale upload state from before Discord reload
    useEffect(() => {
        log.debug("UploadProgressBar component mounted");
        const currentProgress = getCurrentProgress();
        const isComplete = getIsComplete();

        if (currentProgress && !isComplete) {
            // If there's incomplete upload progress when component mounts,
            // it means Discord was reloaded mid-upload - clear it
            log.debug("Clearing stale upload state from before reload");
            clearGlobalState();
        }
    }, []); // Empty deps = runs once on mount

    // Note: Force hide check consolidated into main 250ms polling interval below
    // Removed separate 50ms polling to reduce CPU usage (was checking 20x/second unnecessarily)

    useEffect(() => {
        let hideTimer: NodeJS.Timeout | null = null;
        let stuckAt100Timer: NodeJS.Timeout | null = null;
        let lastReadyToHideState = false;

        const interval = setInterval(() => {
            const current = getCurrentProgress();
            const all = getAllUploads();
            const complete = getIsComplete();
            const dispatched = getIsDispatched();
            const shouldForceHide = getForceHide();

            // Debug: log when we have progress data
            if (current) {
                log.debug("Component poll found progress:", { uploadId: current.uploadId, percent: current.percent, isVisible });
            }

            // Force hide immediately if error occurred
            if (shouldForceHide) {
                log.debug("Force hiding progress bar due to error");
                setIsVisible(false);
                setIsExpanded(false);
                setProgress(null);
                setAllUploads([]);
                setIsComplete(false);
                // Also hide the DOM element directly as a fallback
                const wrapper = document.getElementById("upload-progress-wrapper");
                if (wrapper) {
                    wrapper.style.display = "none";
                }
                return; // Skip rest of logic
            }

            setProgress(current ? { ...current } : null);
            setAllUploads(all);
            setIsComplete(complete);

            // At 100%, we're waiting for server response - don't force completion
            // The upload will complete naturally when we receive the URL back
            if (current && current.percent >= 100 && !complete) {
                if (!stuckAt100Timer) {
                    log.debug("Progress at 100%, waiting for server response...");
                    stuckAt100Timer = true as any; // Just mark that we've logged, don't set a timer
                }
            } else if (stuckAt100Timer && (!current || current.percent < 100 || complete)) {
                stuckAt100Timer = null;
            }

            // Show bar when there's progress or completion
            if (current || complete) {
                // Update dimensions right before showing to ensure perfect alignment
                if (updateWidthRef.current) {
                    updateWidthRef.current();
                }
                setIsVisible(true);
            } else if (!current && !complete) {
                // No progress and not complete = cancelled or cleared
                setIsVisible(false);
                setIsExpanded(false);
            }

            // Ready to hide when both complete AND dispatched (URL pasted into chat)
            const readyToHide = complete && dispatched;

            // Auto-hide after completion - only set timer when transitioning to ready
            if (readyToHide && !lastReadyToHideState) {
                // Just became ready to hide - set hide timer
                log.debug("Upload complete and URL dispatched, setting hide timer");

                // Clear any existing timer first (shouldn't exist but just in case)
                if (hideTimer) {
                    clearTimeout(hideTimer);
                }

                hideTimer = setTimeout(() => {
                    log.debug("Hide timer fired, clearing progress bar");
                    setIsVisible(false);
                    setIsExpanded(false);
                    setIsComplete(false);
                    setProgress(null);
                    // Also clear the global state
                    clearGlobalState();
                    // Clear the timer reference
                    hideTimer = null;
                    // Reset last ready state
                    lastReadyToHideState = false;
                }, 1500); // Hide 1.5 seconds after URL is pasted
            }

            // Clear hide timer if transitioning from ready to not ready
            if (!readyToHide && lastReadyToHideState) {
                log.debug("Upload restarted, clearing hide timer");
                if (hideTimer) {
                    clearTimeout(hideTimer);
                    hideTimer = null;
                }
            }

            // Track the ready state for next iteration
            lastReadyToHideState = readyToHide;
        }, 250); // Poll every 250ms - balance between responsiveness and performance

        return () => {
            clearInterval(interval);
            if (hideTimer) clearTimeout(hideTimer);
            if (stuckAt100Timer) clearTimeout(stuckAt100Timer);
        };
    }, []);

    // Update bar width and position to match chat input area
    useEffect(() => {
        const updateWidthAndPosition = () => {
            // Find both elements - we need channelTextArea for positioning but scrollableContainer for width
            const channelTextArea = document.querySelector('[class*="channelTextArea"]') as HTMLElement;
            const scrollableContainer = document.querySelector('[class*="scrollableContainer"]') as HTMLElement;

            if (channelTextArea && scrollableContainer) {
                // Get dimensions from both elements
                const textAreaRect = channelTextArea.getBoundingClientRect();
                const containerRect = scrollableContainer.getBoundingClientRect();

                // Use channelTextArea position (which has the border) for left alignment
                const leftPosition = textAreaRect.left;

                // Use scrollableContainer width (which is the actual content width without margin issues)
                const contentWidth = containerRect.width;

                // Get the computed background color from scrollableContainer
                const { backgroundColor } = window.getComputedStyle(scrollableContainer);
                if (backgroundColor) {
                    setBgColor(backgroundColor);
                }

                // Get the left offset from the parent form for precise alignment
                const form = channelTextArea.closest("form");
                if (form) {
                    const formRect = form.getBoundingClientRect();
                    const leftOffset = leftPosition - formRect.left;

                    // Store the width from scrollableContainer
                    setBarWidth(`${contentWidth}px`);

                    // Update the wrapper's padding for precise alignment
                    const wrapper = document.getElementById("upload-progress-wrapper");
                    if (wrapper) {
                        wrapper.style.paddingLeft = `${leftOffset}px`;
                    }
                } else {
                    setBarWidth(`${contentWidth}px`);
                }
            } else {
                // Fallback to old method if we can't find both elements
                const targetElement = channelTextArea || scrollableContainer;
                if (targetElement) {
                    const rect = targetElement.getBoundingClientRect();
                    setBarWidth(`${rect.width}px`);

                    const form = targetElement.closest("form");
                    if (form) {
                        const formRect = form.getBoundingClientRect();
                        const wrapper = document.getElementById("upload-progress-wrapper");
                        if (wrapper) {
                            wrapper.style.paddingLeft = `${rect.left - formRect.left}px`;
                        }
                    }
                } else {
                    // Fallback to form if we can't find the input area
                    const chatForm = document.querySelector("form[class*=\"form\"]") as HTMLElement;
                    if (chatForm) {
                        const computedStyle = window.getComputedStyle(chatForm);
                        const fullWidth = parseFloat(computedStyle.width);
                        const adjustedWidth = fullWidth - 32; // Full width minus padding
                        setBarWidth(`${adjustedWidth}px`);
                        // Fallback width applied
                    }
                }
            }
        };

        const updateWidth = updateWidthAndPosition;

        // Store in ref so it can be called from visibility effect
        updateWidthRef.current = updateWidth;

        // Track all timeouts for cleanup
        const timeoutIds: NodeJS.Timeout[] = [];

        // Update immediately and a few times at start to catch dimensions quickly
        updateWidth();
        timeoutIds.push(setTimeout(updateWidth, 50));
        timeoutIds.push(setTimeout(updateWidth, 200));

        // Update on window resize with debouncing
        let resizeTimeout: NodeJS.Timeout | null = null;
        const handleResize = () => {
            if (resizeTimeout) clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(updateWidth, 50);
        };

        window.addEventListener("resize", handleResize);

        // Watch for chat input size changes
        const chatInput = document.querySelector('[class*="channelTextArea"]') as HTMLElement;
        const chatForm = document.querySelector("form[class*=\"form\"]") as HTMLElement;
        const targetElement = chatInput || chatForm;
        let resizeObserver: ResizeObserver | null = null;

        if (targetElement) {
            resizeObserver = new ResizeObserver(() => {
                updateWidth();
            });
            resizeObserver.observe(targetElement);
        }

        // Also watch for any parent container changes
        if (chatForm && chatForm.parentElement) {
            const parentObserver = new ResizeObserver(() => {
                updateWidth();
            });
            parentObserver.observe(chatForm.parentElement);

            // Add mutation observer to catch when Discord modifies the chat area
            let mutationTimeout: NodeJS.Timeout | null = null;
            const mutationObserver = new MutationObserver(() => {
                // Debounce mutation updates to prevent spam
                if (mutationTimeout) clearTimeout(mutationTimeout);
                mutationTimeout = setTimeout(() => {
                    updateWidth();
                }, 100);
            });

            // Observe the chat form and its parent for any changes
            mutationObserver.observe(chatForm.parentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style"]
            });

            return () => {
                // Clear all tracked timeouts
                timeoutIds.forEach(id => clearTimeout(id));
                if (resizeTimeout) clearTimeout(resizeTimeout);
                if (mutationTimeout) clearTimeout(mutationTimeout);
                window.removeEventListener("resize", handleResize);
                if (resizeObserver) {
                    resizeObserver.disconnect();
                }
                parentObserver.disconnect();
                mutationObserver.disconnect();
            };
        }

        return () => {
            // Clear all tracked timeouts
            timeoutIds.forEach(id => clearTimeout(id));
            if (resizeTimeout) clearTimeout(resizeTimeout);
            window.removeEventListener("resize", handleResize);
            if (resizeObserver) {
                resizeObserver.disconnect();
            }
        };
    }, []);

    // Always render the component but hide it with visibility/opacity when not needed
    // This ensures positioning calculations work correctly even when resizing

    const percent = progress?.percent ?? 100;
    const speed = progress?.speed ?? 0;
    const eta = progress?.eta ?? 0;
    const transferred = progress?.transferred ?? 0;
    const total = progress?.total ?? 0;

    // Show the component when visible - use default width if dimensions not calculated yet
    // This ensures the progress bar appears even if DOM selectors fail to find elements
    const shouldShow = isVisible;

    const currentIndex = allUploads.findIndex(u => u.uploadId === progress?.uploadId);
    const isFirstUpload = currentIndex === 0;
    const isLastUpload = currentIndex === allUploads.length - 1;

    // Wrapper div to match chat input container positioning
    return (
        <div
            id="upload-progress-wrapper"
            className={`vc-bfu-progress-wrapper ${!shouldShow ? "vc-bfu-progress-wrapper-hidden" : ""}`}
        >
            <div
                className="vc-bfu-progress-bar-container"
                style={{ width: barWidth, backgroundColor: bgColor }}
            >
                {/* Collapsed view - just progress bar */}
                {!isExpanded && (
                    <div className="vc-bfu-collapsed" onClick={() => setIsExpanded(true)}>
                        {/* Up arrow icon */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="vc-bfu-collapse-icon">
                            <path d="M7 14l5-5 5 5H7z" />
                        </svg>

                        {/* Progress bar */}
                        <div className="vc-bfu-progress-track">
                            <div
                                className={`vc-bfu-progress-fill ${isComplete ? "vc-bfu-progress-fill-complete" : "vc-bfu-progress-fill-active"}`}
                                style={{ width: `${percent}%` }}
                            />
                        </div>

                        {/* Percentage text */}
                        <span className="vc-bfu-percent-text">
                            {isComplete ? "Done!" : `${percent.toFixed(0)}%`}
                        </span>

                        {/* Multiple file indicator */}
                        {allUploads.length > 1 && (
                            <span className="vc-bfu-multi-badge">
                                {currentIndex + 1}/{allUploads.length}
                            </span>
                        )}

                        {/* Cancel button */}
                        {!isComplete && progress?.uploadId && (
                            <button
                                className="vc-bfu-cancel-btn"
                                disabled={isCancelling}
                                onClick={async e => {
                                    e.stopPropagation();
                                    const uploadId = progress?.uploadId;
                                    const fileName = progress?.fileName || "current upload";
                                    if (!uploadId || isCancelling) return;

                                    setIsCancelling(true);
                                    try {
                                        const success = await cancelUploadTracking(uploadId);
                                        if (success) {
                                            showUploadNotification(`Upload cancelled: ${fileName}`, Toasts.Type.MESSAGE);
                                        } else {
                                            showUploadNotification("Couldn't cancel - upload may have already completed", Toasts.Type.FAILURE);
                                        }
                                    } finally {
                                        setIsCancelling(false);
                                    }
                                }}
                                title="Cancel upload"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                                </svg>
                            </button>
                        )}
                    </div>
                )}

                {/* Expanded view - detailed stats */}
                {isExpanded && (
                    <div className="vc-bfu-expanded">
                        {/* Header with down arrow */}
                        <div className="vc-bfu-expanded-header" onClick={() => setIsExpanded(false)}>
                            {/* Down arrow icon */}
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="vc-bfu-expand-icon">
                                <path d="M7 10l5 5 5-5H7z" />
                            </svg>

                            <span className="vc-bfu-title">
                                {isComplete ? "Upload Complete" : "Uploading File"}
                                {allUploads.length > 1 && (
                                    <span className="vc-bfu-title-count">
                                        ({currentIndex + 1} of {allUploads.length})
                                    </span>
                                )}
                            </span>

                            {/* Navigation and cancel buttons */}
                            <div className="vc-bfu-nav-buttons">
                                {/* Navigation buttons for multiple uploads */}
                                {allUploads.length > 1 && (
                                    <>
                                        <button
                                            className="vc-bfu-nav-btn"
                                            onClick={e => {
                                                e.stopPropagation();
                                                if (currentIndex > 0) {
                                                    switchToUpload(allUploads[currentIndex - 1].uploadId);
                                                }
                                            }}
                                            disabled={isFirstUpload}
                                        >
                                            ←
                                        </button>
                                        <button
                                            className="vc-bfu-nav-btn"
                                            onClick={e => {
                                                e.stopPropagation();
                                                if (currentIndex < allUploads.length - 1) {
                                                    switchToUpload(allUploads[currentIndex + 1].uploadId);
                                                }
                                            }}
                                            disabled={isLastUpload}
                                        >
                                            →
                                        </button>
                                    </>
                                )}

                                {/* Cancel button */}
                                {!isComplete && progress?.uploadId && (
                                    <button
                                        className="vc-bfu-cancel-btn"
                                        disabled={isCancelling}
                                        onClick={async e => {
                                            e.stopPropagation();
                                            if (progress?.uploadId && !isCancelling) {
                                                setIsCancelling(true);
                                                try {
                                                    const success = await cancelUploadTracking(progress.uploadId);
                                                    if (success) {
                                                        showUploadNotification("Upload cancelled", Toasts.Type.MESSAGE);
                                                    } else {
                                                        showUploadNotification("Couldn't cancel - upload may have already completed", Toasts.Type.FAILURE);
                                                    }
                                                } finally {
                                                    setIsCancelling(false);
                                                }
                                            }
                                        }}
                                        title="Cancel upload"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Progress bar */}
                        <div className="vc-bfu-expanded-track">
                            <div
                                className={`vc-bfu-expanded-fill ${isComplete ? "vc-bfu-progress-fill-complete" : "vc-bfu-progress-fill-active"}`}
                                style={{ width: `${percent}%` }}
                            />
                        </div>

                        {/* Stats in one horizontal line */}
                        <div className="vc-bfu-stats-row">
                            {/* Progress percentage */}
                            <div className="vc-bfu-stat">
                                <span>Progress:</span>
                                <span className="vc-bfu-stat-value">{percent.toFixed(1)}%</span>
                            </div>

                            {/* Separator */}
                            <span className="vc-bfu-stat-separator">•</span>

                            {/* Speed */}
                            {!isComplete && (
                                <>
                                    <div className="vc-bfu-stat">
                                        <span>Speed:</span>
                                        <span className="vc-bfu-stat-value">{formatFileSize(speed)}/s</span>
                                    </div>
                                    <span className="vc-bfu-stat-separator">•</span>
                                </>
                            )}

                            {/* ETA */}
                            {!isComplete && (
                                <>
                                    <div className="vc-bfu-stat">
                                        <span>ETA:</span>
                                        <span className="vc-bfu-stat-value">{formatETA(eta)}</span>
                                    </div>
                                    <span className="vc-bfu-stat-separator">•</span>
                                </>
                            )}

                            {/* Data transferred */}
                            <div className="vc-bfu-stat">
                                <span>Transferred:</span>
                                <span className="vc-bfu-stat-value">{formatFileSize(transferred)} / {formatFileSize(total)}</span>
                            </div>
                        </div>

                        {/* File name */}
                        {progress?.fileName && (
                            <div className="vc-bfu-filename">{progress.fileName}</div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
