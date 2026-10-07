/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CORS_PROXY = "https://cors.keiran0.workers.dev";
export const DEFAULT_DISCORD_UPLOAD_LIMIT = 20 * 1024 * 1024;

export function normalizeCorsProxyUrl(url?: string): string {
    return (url?.trim() || CORS_PROXY).replace(/\/+$/, "");
}

export function toProxiedUrl(url: string, corsProxyUrl = CORS_PROXY): string {
    if (corsProxyUrl === "none") {
        return url;
    }
    return `${normalizeCorsProxyUrl(corsProxyUrl)}?url=${encodeURIComponent(url)}`;
}
