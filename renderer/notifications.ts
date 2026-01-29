/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { showToast, Toasts } from "@webpack/common";

import { settings } from "../index";

/**
 * Show upload notification or toast based on user preference
 * Consolidated from index.tsx and UploadProgressBar.tsx to avoid duplication
 */
export function showUploadNotification(message: string, type: any = Toasts.Type.MESSAGE) {
    const useNotifications = settings.store.useNotifications === "Yes";

    if (useNotifications) {
        const color = type === Toasts.Type.FAILURE
            ? "var(--red-360)"
            : type === Toasts.Type.SUCCESS
                ? "var(--green-360)"
                : undefined;

        showNotification({
            title: "BigFileUpload",
            body: message,
            color,
            noPersist: true
        });
    } else {
        showToast(message, type);
    }
}
