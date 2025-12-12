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

            // Safety check: If progress is stuck at 100% for too long, force completion
            if (current && current.percent >= 100 && !complete) {
                if (!stuckAt100Timer) {
                    log.debug("Progress at 100%, starting safety timer");
                    stuckAt100Timer = setTimeout(() => {
                        log.debug("Progress stuck at 100% for 3s, forcing completion");
                        setIsComplete(true);
                        clearGlobalState();
                    }, 3000); // Wait 3 seconds before forcing completion
                }
            } else if (stuckAt100Timer && (!current || current.percent < 100 || complete)) {
                // Clear the timer if progress changes or completes normally
                clearTimeout(stuckAt100Timer);
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

    // Don't show until dimensions are properly calculated (not default "50%")
    const isDimensionsReady = barWidth !== "50%";

    // Calculate if we should show the component (visible AND dimensions ready)
    const shouldShow = isVisible && isDimensionsReady;

    // Wrapper div to match chat input container positioning
    return (
        <div
            id="upload-progress-wrapper"
            style={{
                position: "relative",
                width: "100%",
                display: shouldShow ? "flex" : "none",
                justifyContent: "flex-start",
            }}
        >
            <div
                style={{
                    position: "relative",
                    width: barWidth,
                    // Use computed background color from scrollableContainer (adapts to all themes)
                    backgroundColor: bgColor,
                    borderRadius: "8px 8px 0 0", // Round both top corners (matches scrollableContainer)
                    overflow: "hidden",
                    marginBottom: "4px",
                    // Match channelTextArea border (the parent wrapper has the border, not scrollableContainer)
                    border: "1px solid var(--border-faint)",
                    borderBottom: "none",
                    transition: "border-color 0.2s ease, background-color 0.2s ease",
                    // Match font family and size from chat input
                    fontFamily: "var(--font-primary)",
                    fontSize: "var(--font-size-md)",
                    // Keep z-index low to not block typing indicator
                    zIndex: 1
                }}
            >
                {/* Collapsed view - just progress bar */}
                {!isExpanded && (
                    <div
                        style={{
                            paddingTop: "8px",
                            paddingBottom: "10px",
                            paddingLeft: "16px",
                            paddingRight: "16px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px"
                        }}
                        onClick={() => setIsExpanded(true)}
                    >
                        {/* Up arrow icon */}
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            style={{ color: "var(--interactive-normal)" }}
                        >
                            <path d="M7 14l5-5 5 5H7z" />
                        </svg>

                        {/* Progress bar */}
                        <div
                            style={{
                                flex: 1,
                                height: "10px",
                                backgroundColor: "var(--background-secondary-alt)",
                                borderRadius: "5px",
                                overflow: "hidden",
                                border: "1px solid var(--background-modifier-accent)",
                                boxShadow: "inset 0 1px 3px rgba(0, 0, 0, 0.2)"
                            }}
                        >
                            <div
                                style={{
                                    width: `${percent}%`,
                                    height: "100%",
                                    backgroundColor: isComplete ? "var(--green-360)" : "var(--brand-500)",
                                    // Smooth transition over 1 second for visual continuity between updates
                                    transition: "width 1s linear, background-color 0.3s ease",
                                    boxShadow: isComplete ? "0 0 10px var(--green-360)" : "0 0 10px var(--brand-500)"
                                }}
                            />
                        </div>

                        {/* Percentage text */}
                        <span style={{
                            fontSize: "12px",
                            color: "var(--text-muted)",
                            minWidth: "45px",
                            textAlign: "right"
                        }}>
                            {isComplete ? "Done!" : `${percent.toFixed(0)}%`}
                        </span>

                        {/* Multiple file indicator */}
                        {allUploads.length > 1 && (
                            <span style={{
                                marginLeft: "8px",
                                padding: "2px 6px",
                                backgroundColor: "var(--background-secondary)",
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "var(--header-primary)"
                            }}>
                                {allUploads.findIndex(u => u.uploadId === progress?.uploadId) + 1}/{allUploads.length}
                            </span>
                        )}

                        {/* Cancel button */}
                        {!isComplete && progress?.uploadId && (
                            <button
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
                                style={{
                                    marginLeft: "4px",
                                    padding: "4px",
                                    backgroundColor: "transparent",
                                    border: "none",
                                    borderRadius: "4px",
                                    cursor: isCancelling ? "not-allowed" : "pointer",
                                    opacity: isCancelling ? 0.5 : 1,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    color: "var(--status-danger)",
                                    transition: "background-color 0.2s"
                                }}
                                onMouseEnter={e => {
                                    e.currentTarget.style.backgroundColor = "var(--background-modifier-hover)";
                                }}
                                onMouseLeave={e => {
                                    e.currentTarget.style.backgroundColor = "transparent";
                                }}
                                title="Cancel upload"
                            >
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                >
                                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                                </svg>
                            </button>
                        )}
                    </div>
                )}

                {/* Expanded view - detailed stats */}
                {isExpanded && (
                    <div style={{
                        paddingTop: "8px",
                        paddingBottom: "32px",
                        paddingLeft: "16px",
                        paddingRight: "16px"
                    }}>
                        {/* Header with down arrow */}
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                marginBottom: "8px",
                                cursor: "pointer"
                            }}
                            onClick={() => setIsExpanded(false)}
                        >
                            {/* Down arrow icon */}
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                style={{ color: "var(--interactive-normal)" }}
                            >
                                <path d="M7 10l5 5 5-5H7z" />
                            </svg>

                            <span style={{
                                fontSize: "14px",
                                fontWeight: 600,
                                color: "var(--header-primary)",
                                flex: 1
                            }}>
                                {isComplete ? "Upload Complete" : "Uploading File"}
                                {allUploads.length > 1 && (
                                    <span style={{
                                        marginLeft: "8px",
                                        fontSize: "12px",
                                        color: "var(--text-muted)",
                                        fontWeight: "normal"
                                    }}>
                                        ({allUploads.findIndex(u => u.uploadId === progress?.uploadId) + 1} of {allUploads.length})
                                    </span>
                                )}
                            </span>

                            {/* Navigation and cancel buttons */}
                            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                                {/* Navigation buttons for multiple uploads */}
                                {allUploads.length > 1 && (
                                    <>
                                        <button
                                            onClick={e => {
                                                e.stopPropagation();
                                                const currentIndex = allUploads.findIndex(u => u.uploadId === progress?.uploadId);
                                                if (currentIndex > 0) {
                                                    switchToUpload(allUploads[currentIndex - 1].uploadId);
                                                }
                                            }}
                                            disabled={allUploads.findIndex(u => u.uploadId === progress?.uploadId) === 0}
                                            style={{
                                                padding: "4px 8px",
                                                backgroundColor: "var(--background-secondary)",
                                                border: "1px solid var(--background-modifier-accent)",
                                                borderRadius: "4px",
                                                color: "var(--interactive-normal)",
                                                cursor: allUploads.findIndex(u => u.uploadId === progress?.uploadId) === 0 ? "not-allowed" : "pointer",
                                                opacity: allUploads.findIndex(u => u.uploadId === progress?.uploadId) === 0 ? 0.5 : 1,
                                                fontSize: "12px"
                                            }}
                                        >
                                            ←
                                        </button>
                                        <button
                                            onClick={e => {
                                                e.stopPropagation();
                                                const currentIndex = allUploads.findIndex(u => u.uploadId === progress?.uploadId);
                                                if (currentIndex < allUploads.length - 1) {
                                                    switchToUpload(allUploads[currentIndex + 1].uploadId);
                                                }
                                            }}
                                            disabled={allUploads.findIndex(u => u.uploadId === progress?.uploadId) === allUploads.length - 1}
                                            style={{
                                                padding: "4px 8px",
                                                backgroundColor: "var(--background-secondary)",
                                                border: "1px solid var(--background-modifier-accent)",
                                                borderRadius: "4px",
                                                color: "var(--interactive-normal)",
                                                cursor: allUploads.findIndex(u => u.uploadId === progress?.uploadId) === allUploads.length - 1 ? "not-allowed" : "pointer",
                                                opacity: allUploads.findIndex(u => u.uploadId === progress?.uploadId) === allUploads.length - 1 ? 0.5 : 1,
                                                fontSize: "12px"
                                            }}
                                        >
                                            →
                                        </button>
                                    </>
                                )}

                                {/* Cancel button */}
                                {!isComplete && progress?.uploadId && (
                                    <button
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
                                        style={{
                                            padding: "4px 8px",
                                            backgroundColor: "var(--background-secondary)",
                                            border: "1px solid var(--status-danger)",
                                            borderRadius: "4px",
                                            cursor: isCancelling ? "not-allowed" : "pointer",
                                            opacity: isCancelling ? 0.5 : 1,
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            color: "var(--status-danger)",
                                            transition: "background-color 0.2s"
                                        }}
                                        onMouseEnter={e => {
                                            e.currentTarget.style.backgroundColor = "var(--status-danger)";
                                            e.currentTarget.style.color = "white";
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.backgroundColor = "var(--background-secondary)";
                                            e.currentTarget.style.color = "var(--status-danger)";
                                        }}
                                        title="Cancel upload"
                                    >
                                        <svg
                                            width="16"
                                            height="16"
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                        >
                                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Progress bar */}
                        <div
                            style={{
                                width: "100%",
                                height: "12px",
                                backgroundColor: "var(--background-secondary-alt)",
                                borderRadius: "6px",
                                overflow: "hidden",
                                marginBottom: "8px",
                                border: "1px solid var(--background-modifier-accent)",
                                boxShadow: "inset 0 1px 3px rgba(0, 0, 0, 0.1)"
                            }}
                        >
                            <div
                                style={{
                                    width: `${percent}%`,
                                    height: "100%",
                                    backgroundColor: isComplete ? "var(--green-360)" : "var(--brand-500)",
                                    // Smooth transition over 1 second for visual continuity between updates
                                    transition: "width 1s linear, background-color 0.3s ease",
                                    boxShadow: isComplete ? "0 0 10px var(--green-360)" : "0 0 10px var(--brand-500)"
                                }}
                            />
                        </div>

                        {/* Stats in one horizontal line */}
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "16px",
                            fontSize: "12px",
                            color: "var(--text-muted)"
                        }}>
                            {/* Progress percentage */}
                            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                <span>Progress:</span>
                                <span style={{ color: "var(--header-primary)", fontWeight: 600 }}>
                                    {percent.toFixed(1)}%
                                </span>
                            </div>

                            {/* Separator */}
                            <span style={{ color: "var(--text-muted)", opacity: 0.3 }}>•</span>

                            {/* Speed */}
                            {!isComplete && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                        <span>Speed:</span>
                                        <span style={{ color: "var(--header-primary)", fontWeight: 600 }}>
                                            {formatFileSize(speed)}/s
                                        </span>
                                    </div>
                                    <span style={{ color: "var(--text-muted)", opacity: 0.3 }}>•</span>
                                </>
                            )}

                            {/* ETA */}
                            {!isComplete && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                        <span>ETA:</span>
                                        <span style={{ color: "var(--header-primary)", fontWeight: 600 }}>
                                            {formatETA(eta)}
                                        </span>
                                    </div>
                                    <span style={{ color: "var(--text-muted)", opacity: 0.3 }}>•</span>
                                </>
                            )}

                            {/* Data transferred */}
                            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                <span>Transferred:</span>
                                <span style={{ color: "var(--header-primary)", fontWeight: 600 }}>
                                    {formatFileSize(transferred)} / {formatFileSize(total)}
                                </span>
                            </div>
                        </div>

                        {/* File name */}
                        {progress?.fileName && (
                            <div style={{
                                marginTop: "8px",
                                fontSize: "11px",
                                color: "var(--text-muted)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap"
                            }}>
                                {progress.fileName}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
