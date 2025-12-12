/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

export type LoggingLevel = "errors" | "info" | "debug";

const levelPriority: Record<LoggingLevel, number> = {
    errors: 0,
    info: 1,
    debug: 2
};

let levelProvider: () => LoggingLevel = () => "errors";

export function setLoggingLevelProvider(provider: () => LoggingLevel) {
    levelProvider = provider;
}

const baseLogger = new Logger("BigFileUpload", "#8caaee");

function shouldLog(level: Exclude<LoggingLevel, "errors">) {
    const current = levelProvider();
    return levelPriority[current] >= levelPriority[level];
}

export const pluginLogger = {
    info: (...args: any[]) => {
        if (shouldLog("info")) baseLogger.info(...args);
    },
    debug: (...args: any[]) => {
        if (shouldLog("debug")) baseLogger.log("[debug]", ...args);
    },
    warn: (...args: any[]) => {
        // Warnings shown at info level or above (not on "errors only" mode)
        if (shouldLog("info")) baseLogger.warn(...args);
    },
    error: (...args: any[]) => {
        baseLogger.error(...args);
    }
};

export type PluginLogger = typeof pluginLogger;
