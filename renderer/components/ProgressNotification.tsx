/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Progress notification component with animated progress bar
 * Self-updates by polling global progress state
 */

import { useEffect, useState } from "@webpack/common";

import { formatETA } from "../formatting";
import { getCurrentProgress, getIsComplete, UploadProgress } from "../progress";

export function ProgressNotification({ onComplete }: { onComplete?: () => void; }) {
    const [progress, setProgress] = useState<UploadProgress | null>(getCurrentProgress());
    const [isComplete, setIsComplete] = useState(false);
    const [completionHandled, setCompletionHandled] = useState(false);

    useEffect(() => {
        const interval = setInterval(() => {
            const current = getCurrentProgress();
            const complete = getIsComplete();

            setProgress(current ? { ...current } : null);
            setIsComplete(complete);
        }, 100);

        return () => clearInterval(interval);
    }, []);

    // Handle auto-dismiss when upload completes
    useEffect(() => {
        if (isComplete && !completionHandled && onComplete) {
            setCompletionHandled(true);
            // Show "Upload Complete!" for 2 seconds, then dismiss
            setTimeout(() => {
                onComplete();
            }, 2000);
        }
    }, [isComplete, completionHandled, onComplete]);

    // If no progress and not complete, hide notification
    if (!progress && !isComplete) return null;

    // Show completion message
    if (isComplete) {
        return (
            <div className="vc-bfu-notification">
                <div className="vc-bfu-notification-complete">
                    <span>✓</span>
                    <span>Upload Complete!</span>
                </div>
                <div className="vc-bfu-notification-dismiss">
                    This notification will close automatically
                </div>
            </div>
        );
    }

    // No progress data yet
    if (!progress) return null;

    const loadedMB = (progress.loaded / 1024 / 1024).toFixed(1);
    const totalMB = (progress.total / 1024 / 1024).toFixed(1);
    const speedMBps = progress.speed.toFixed(2);
    const etaFormatted = formatETA(progress.eta);
    const percent = progress.percent.toFixed(1);
    const progressBarWidth = Math.min(progress.percent, 100);

    return (
        <div className="vc-bfu-notification">
            <div className="vc-bfu-notification-filename">
                {progress.fileName}
            </div>
            <div className="vc-bfu-notification-stats">
                {percent}% • {loadedMB}MB / {totalMB}MB • {speedMBps} MB/s • ETA: {etaFormatted}
            </div>
            <div className="vc-bfu-notification-track">
                <div
                    className="vc-bfu-notification-fill"
                    style={{ width: `${progressBarWidth}%` }}
                />
            </div>
        </div>
    );
}
