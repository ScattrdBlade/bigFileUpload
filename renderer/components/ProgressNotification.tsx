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
            <div style={{ padding: "8px 0" }}>
                <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--green-360)"
                }}>
                    <span>✓</span>
                    <span>Upload Complete!</span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
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
        <div style={{ padding: "8px 0" }}>
            <div style={{ marginBottom: "6px", fontSize: "14px", fontWeight: 600 }}>
                {progress.fileName}
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                {percent}% • {loadedMB}MB / {totalMB}MB • {speedMBps} MB/s • ETA: {etaFormatted}
            </div>
            <div style={{
                width: "100%",
                height: "6px",
                backgroundColor: "var(--background-secondary)",
                borderRadius: "3px",
                overflow: "hidden"
            }}>
                <div style={{
                    width: `${progressBarWidth}%`,
                    height: "100%",
                    backgroundColor: "var(--brand-500)",
                    transition: "width 0.3s ease"
                }} />
            </div>
        </div>
    );
}
