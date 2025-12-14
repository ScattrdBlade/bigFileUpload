/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function formatFileSize(bytes: number): string {
    // Handle edge cases
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}

export function formatETA(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        if (minutes > 0) {
            return `${hours} hour${hours !== 1 ? "s" : ""} and ${minutes} min`;
        }
        return `${hours} hour${hours !== 1 ? "s" : ""}`;
    }

    if (minutes > 0) {
        if (secs > 0 && minutes < 5) {
            return `${minutes} min and ${secs} sec`;
        }
        return `${minutes} min`;
    }

    return `${secs} sec`;
}

function isVideoFile(filename: string): boolean {
    const videoExtensions = [
        ".mp4", ".webm", ".mkv", ".flv", ".mov", ".avi", ".wmv", ".m4v",
        ".mpg", ".mpeg", ".3gp", ".ogv", ".ts", ".m2ts", ".mts"
    ];
    const lowerName = filename.toLowerCase();
    return videoExtensions.some(ext => lowerName.endsWith(ext));
}

export function wrapWithEmbedsVideo(url: string, filename: string, enabled: boolean): string {
    if (!enabled || !isVideoFile(filename)) {
        return url;
    }

    // Only official embeds.video shorthands (per docs)
    const shorthandMap: Record<string, string> = {
        "fileditch.com": "fd",
        "cdn.discordapp.com": "disc",
        "catbox.moe": "cat",
        "0x0.st": "0x0",
    };

    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname.replace("www.", "");

        for (const [domainKey, code] of Object.entries(shorthandMap)) {
            if (domain.includes(domainKey)) {
                const path = urlObj.pathname + urlObj.search;
                return `https://embeds.video/${code}${path}`;
            }
        }

        return `https://embeds.video/${url}`;
    } catch {
        return `https://embeds.video/${url}`;
    }
}
