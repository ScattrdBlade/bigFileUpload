/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { isPluginEnabled, plugins } from "@api/PluginManager";
import ErrorBoundary from "@components/ErrorBoundary";
import { CloudUploadIcon, OpenExternalIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { Channel, CloudUpload } from "@vencord/discord-types";
import { findByCode, findByCodeLazy, findByProps, findByPropsLazy, findModuleId, wreq } from "@webpack";
import { ChannelStore, DraftType, EditMessageStore, FluxDispatcher, Menu, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, UploadAttachmentStore, UploadManager, useEffect, UserStore, useState, useStateFromStores } from "@webpack/common";

import { migrateSettings, settings } from "./settings";
import { listNames, serviceLabel, ServiceType } from "./types";
import { askToUseHost, copyKeptLink, initCorsProxyPrompt, openPluginSettings, startCorsProxyPrompt } from "./utils/dialogs";
import { getMediaUrls } from "./utils/media";
import { loadHttpOrigins } from "./utils/proxy";
import { canAnyHostAccept, cancelAllUploads, cancelCurrentUpload, dismissUploadState, formatSize, getUploadState, hasNativeHelper, isFileTypeAllowed, isPrimaryReady, logger, noHostText, offerHost, primaryNotReadyReason, primaryNotReadyText, removeQueuedUpload, subscribeUploadState, uploadBlocker, uploadFile, uploadPickedFile, uploadProvidedFiles, UploadTarget } from "./utils/upload";

const cl = classNameFactory("vc-file-upload-");

const { getUserMaxFileSize } = findByPropsLazy("getUserMaxFileSize");

const discordFilesExceedLimit = findByCodeLazy("canDeferSizeChecks:", "Array.from(", ".size>") as (options: { files: readonly File[]; guildId?: string | null; canDeferSizeChecks?: boolean; }) => boolean;

const discordGuildMaxFileSize = findByCodeLazy(".getUserMaxFileSize(", "features.has(") as (guildId?: string | null) => number;

const discordUploadSumTooLarge = findByCodeLazy('location:"uploadSumTooLarge"') as (files: readonly File[]) => boolean;

const patchHits = { gate: false, progress: false, paste: false, drop: false };

function markHit(name: keyof typeof patchHits, replace: string) {
    return (_match: string, ...groups: string[]) => {
        patchHits[name] = true;
        return replace.replace(/\$(\d)/g, (_, i: string) => groups[Number(i) - 1] ?? "");
    };
}

let uploadAddFilesInterceptor: ((event: unknown) => void) | null = null;

let declinedBatch: { channelId: string; count: number; at: number; } | null = null;

const DECLINED_BATCH_WINDOW_MS = 10000;

function isDeclinedBatch(channelId: string | undefined, count: number, consume: boolean): boolean {
    if (!declinedBatch || declinedBatch.channelId !== channelId || declinedBatch.count !== count || Date.now() - declinedBatch.at > DECLINED_BATCH_WINDOW_MS) return false;
    if (consume) declinedBatch = null;
    return true;
}

let pluginActive = false;

let interceptorHealthy = true;

let interceptorWarned = false;

let lastUploadDispatchAt = 0;

let lastBypassAt = 0;

let lastBypassChannelId: string | null = null;

let pendingInterceptorHealthCheck: ReturnType<typeof setTimeout> | null = null;

const bypassedFiles = new WeakSet<File>();

const INTERCEPTOR_HEALTH_WINDOW_MS = 5000;

const DISCORD_MAX_ATTACHMENTS = 10;

function scheduleInterceptorHealthCheck(): void {
    lastBypassAt = Date.now();
    if (pendingInterceptorHealthCheck) return;

    const runHealthCheck = () => {
        pendingInterceptorHealthCheck = null;
        if (!pluginActive) return;

        if (lastUploadDispatchAt >= lastBypassAt) return;

        const remaining = INTERCEPTOR_HEALTH_WINDOW_MS - (Date.now() - lastBypassAt);
        if (remaining > 0) {
            pendingInterceptorHealthCheck = setTimeout(runHealthCheck, remaining);
            return;
        }

        interceptorHealthy = false;
        logger.error("Discord's size gate was bypassed but no UPLOAD_ATTACHMENT_ADD_FILES dispatch followed. Upload interception appears broken. Re-enabling Discord's size checks.");
        if (!interceptorWarned) {
            interceptorWarned = true;
            showToast({ text: "BigFileUpload: upload interception appears broken (Discord update?). Discord's size limits were re-enabled", variant: "critical" });
        }
    };

    pendingInterceptorHealthCheck = setTimeout(runHealthCheck, INTERCEPTOR_HEALTH_WINDOW_MS);
}

const INTEGRATION_CHECK_DELAY_MS = 15000;

let integrationCheckTimer: ReturnType<typeof setTimeout> | null = null;

const integrationCheck: { problems: string[] | null; } = { problems: null };

function checkIntegration(): void {
    integrationCheckTimer = null;
    if (!pluginActive) return;
    const problems: string[] = [];
    const checks = [
        ["gate", "Unexpected mismatch between files and file metadata", "attach-button size gate"],
        ["progress", ".CREATE_FORUM_POST||", "progress bar"],
        ["paste", '{requireConfirm:!0,origin:"clipboard"}', "paste hook"]
    ] as const;
    let gateModuleRan = patchHits.gate;
    for (const [hit, find, what] of checks) {
        if (patchHits[hit]) continue;
        try {
            const id = findModuleId(find);
            if (id == null) problems.push(`${what}: module not found`);
            else if (wreq.c[id]) {
                problems.push(`${what}: patch had no effect`);
                if (hit === "gate") gateModuleRan = true;
            }
        } catch {
            problems.push(`${what}: module not found`);
        }
    }
    if (gateModuleRan) {
        const finds: [string, () => unknown][] = [
            ["Discord size check (fJ)", () => findByCode("canDeferSizeChecks:", "Array.from(", ".size>")],
            ["guild limit (o2)", () => findByCode(".getUserMaxFileSize(", "features.has(")],
            ["total-size check (Aw)", () => findByCode('location:"uploadSumTooLarge"')],
            ["getUserMaxFileSize", () => findByProps("getUserMaxFileSize")]
        ];
        for (const [what, resolve] of finds) {
            try {
                if (!resolve()) problems.push(`${what}: not found`);
            } catch {
                problems.push(`${what}: not found`);
            }
        }
    }
    integrationCheck.problems = problems;
    if (!problems.length) return;
    logger.error("Discord integration check failed (Discord update?):", problems);
    showToast({ text: "BigFileUpload: part of its Discord integration failed (Discord update?). See the console", variant: "critical" });
}

type UploadAddFilesEvent = {
    type: string;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
    draftType?: unknown;
    channelId?: string;
};

function getGuildIdForChannel(channelId: string | null | undefined): string | null {
    if (!channelId) return null;
    try {
        const channel = ChannelStore.getChannel(channelId) as { getGuildId?: () => string | null; guild_id?: string | null; } | null;
        return channel?.getGuildId?.() ?? channel?.guild_id ?? null;
    } catch {
        return null;
    }
}

const DISCORD_MIN_FILE_SIZE = 20 * 1024 * 1024;

const DISCORD_FALLBACK_TOTAL_SIZE = 500 * 1024 * 1024;

function readDiscordUploadLimit(guildId: string | null): { limit: number; source: "o2" | "getUserMaxFileSize" | "constant"; } {
    const readers = [
        ["o2", () => discordGuildMaxFileSize(guildId)],
        ["getUserMaxFileSize", () => getUserMaxFileSize(UserStore.getCurrentUser())]
    ] as const;
    for (const [source, read] of readers) {
        try {
            const limit = Number(read());
            if (Number.isFinite(limit) && limit > 0) return { limit: Math.max(DISCORD_MIN_FILE_SIZE, limit), source };
        } catch { }
    }
    return { limit: DISCORD_MIN_FILE_SIZE, source: "constant" };
}

const toMiB = (bytes: number) => Math.round(bytes / 1048576 * 10) / 10;

function filesExceedDiscordLimit(files: readonly File[], guildId: string | null): boolean {
    const { limit, source } = readDiscordUploadLimit(guildId);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const summary = `${files.length} files, ${toMiB(total)} MiB, per-file limit ${toMiB(limit)} MiB from ${source}`;
    try {
        const result: unknown = discordFilesExceedLimit({ files, guildId, canDeferSizeChecks: false });
        if (typeof result === "boolean") {
            logger.debug(`Limit check by fJ: ${result ? "over" : "within"} (${summary})`);
            return result;
        }
        logger.warn("Discord file size check returned a non-boolean, using the manual size check instead", result);
    } catch (error) {
        logger.warn("Discord file size check unavailable, falling back to a manual size check", error);
    }

    if (files.some(file => file.size > limit)) {
        logger.debug(`Limit check by ${source}: over (${summary})`);
        return true;
    }
    try {
        const tooLarge: unknown = discordUploadSumTooLarge(files);
        if (typeof tooLarge === "boolean") {
            logger.debug(`Limit check by Aw: ${tooLarge ? "over" : "within"} (${summary})`);
            return tooLarge;
        }
    } catch { }
    const over = total > DISCORD_FALLBACK_TOTAL_SIZE;
    logger.debug(`Limit check by the ${toMiB(DISCORD_FALLBACK_TOTAL_SIZE)} MiB fallback total: ${over ? "over" : "within"} (${summary})`);
    return over;
}

function manualLimitBytes(): number {
    const { bypassDiscordUploadOnlyOverLimit, customDiscordFileSizeLimitMB } = settings.store;
    const mb = Number(customDiscordFileSizeLimitMB);
    return bypassDiscordUploadOnlyOverLimit && mb > 0 ? mb * 1024 * 1024 : 0;
}

function exceedsTakeLimit(files: readonly File[], guildId: string | null): boolean {
    const manual = manualLimitBytes();
    return (manual > 0 && files.some(f => f.size > manual)) || filesExceedDiscordLimit(files, guildId);
}

const DISCORD_GENERATED_ORIGINS = new Set(["unknown:clip_share"]);

const ACTIVITY_SHARE_ORIGIN = "unknown:activity_share";

function isDiscordGeneratedFile(file: File, origin: unknown): boolean {
    return (typeof origin === "string" && DISCORD_GENERATED_ORIGINS.has(origin))
        || (file.type.startsWith("text/plain") && /^message\.\w+$/i.test(file.name));
}

function skipInAlwaysInterceptMode(file: File, origin: unknown, overLimit: (f: File) => boolean): boolean {
    return settings.store.skipDiscordGeneratedFiles && isDiscordGeneratedFile(file, origin) && !overLimit(file);
}

function pickFilesToTake(files: readonly File[], existing: readonly File[], guildId: string | null, draftType: unknown, origin: unknown): File[] {
    if (draftType !== DraftType.ChannelMessage && draftType !== DraftType.FirstThreadMessage) return [];
    const allowed = files.filter(f => isFileTypeAllowed(f) && canAnyHostAccept(f));
    if (!allowed.length) return [];
    const { bypassDiscordUploadOnlyOverLimit: respectLimit, uploadWholeBatch } = settings.store;
    if (!respectLimit && draftType === DraftType.ChannelMessage)
        return allowed.filter(f => !skipInAlwaysInterceptMode(f, origin, x => filesExceedDiscordLimit([x], guildId)));

    const draft = existing.length && filesExceedDiscordLimit(existing, guildId) ? [] : existing;
    if (!exceedsTakeLimit(files, guildId) && !(draft.length && filesExceedDiscordLimit([...draft, ...files], guildId))) return [];
    if (respectLimit && uploadWholeBatch) return allowed;
    const take = new Set(allowed.filter(f => exceedsTakeLimit([f], guildId)));
    if (files.some(f => !allowed.includes(f) && filesExceedDiscordLimit([f], guildId))) return allowed.filter(f => take.has(f));
    for (const f of [...allowed].sort((a, b) => b.size - a.size)) {
        if (take.has(f)) continue;
        if (!filesExceedDiscordLimit([...draft, ...files.filter(x => !take.has(x))], guildId)) break;
        take.add(f);
    }
    return allowed.filter(f => take.has(f));
}

function filesNoHostAccepts(files: readonly File[], guildId: string | null): File[] {
    return files.filter(f => isFileTypeAllowed(f) && filesExceedDiscordLimit([f], guildId) && !canAnyHostAccept(f));
}

function showNoHostToast(files: readonly File[]): void {
    const text = noHostText(files[0]);
    if (text === null) return;
    const more = files.length > 1 ? ` (and ${files.length - 1} more)` : "";
    showToast({ text: `BigFileUpload: ${text}${more}`, variant: "critical", duration: 10000 });
}

function showPrimaryNotReadyToast(files: readonly File[], guildId: string | null): void {
    if (!files.some(f => isFileTypeAllowed(f) && filesExceedDiscordLimit([f], guildId))) return;
    showToast({ text: `BigFileUpload: ${primaryNotReadyText()}. Until then, files over Discord's limit are left to Discord`, variant: "critical", duration: 10000 });
}

function isOriginEnabled(origin: unknown): boolean {
    if (origin === ACTIVITY_SHARE_ORIGIN) return false;
    if (origin === "clipboard") return settings.store.autoUploadPastedFiles;
    if (origin === "drag_drop") return settings.store.bypassDragDrop;
    return settings.store.bypassDiscordUpload;
}

function getDraftFiles(channelId: string | undefined, draftType: unknown): File[] {
    if (!channelId || typeof draftType !== "number") return [];
    try {
        return (UploadAttachmentStore.getUploads(channelId, draftType) ?? []).map(u => u.item?.file).filter((f): f is File => f instanceof File);
    } catch {
        return [];
    }
}

function entryField(entry: unknown, key: "origin" | "isThumbnail" | "id"): unknown {
    return entry && typeof entry === "object" && key in entry ? (entry as Record<string, unknown>)[key] : undefined;
}

function discordShowsSizeModal(files: readonly File[], guildId: string | null): boolean {
    try {
        return discordFilesExceedLimit({ files, guildId }) !== false;
    } catch {
        return true;
    }
}

function offerExcludedFiles(files: readonly File[], gid: string | null, discordGuildId: string | null, channelId: string, draftType: number): void {
    const over = files.filter(f => filesExceedDiscordLimit([f], gid) && canAnyHostAccept(f));
    if (!over.some(f => !isFileTypeAllowed(f)) || !discordShowsSizeModal(files, discordGuildId)) return;
    offerUploadWith(over, { channelId, draftType }, "excluded");
}

interface GateCall {
    files?: File[];
    guildId?: string | null;
    channel?: Channel;
    draftType?: number;
    origin?: string;
    isThumbnail?: boolean;
}

function decideGateBypass({ files, guildId, channel, draftType, origin, isThumbnail }: GateCall): boolean {
    if (!pluginActive || isThumbnail || !isOriginEnabled(origin) || !interceptorHealthy) return false;
    if (!Array.isArray(files) || !files.length || !channel || draftType == null) return false;
    if (draftType !== DraftType.ChannelMessage && draftType !== DraftType.FirstThreadMessage) return false;
    if (isDeclinedBatch(channel.id, files.length, false)) return false;

    const gid = guildId ?? channel.guild_id ?? null;
    if (!filesExceedDiscordLimit(files, gid)) return false;
    if (!isPrimaryReady()) {
        if (discordShowsSizeModal(files, guildId ?? null)) {
            showPrimaryNotReadyToast(files, gid);
            const wanted = files.filter(f => isFileTypeAllowed(f) && filesExceedDiscordLimit([f], gid));
            if (wanted.length) offerUploadWith(wanted, { channelId: channel.id, draftType }, "notReady");
        }
        return false;
    }
    const homeless = filesNoHostAccepts(files, gid);
    if (homeless.length) {
        if (discordShowsSizeModal(files, guildId ?? null)) showNoHostToast(homeless);
        return false;
    }
    if (UploadAttachmentStore.getUploadCount(channel.id, draftType) + files.length > DISCORD_MAX_ATTACHMENTS) return false;
    const existing = getDraftFiles(channel.id, draftType);
    const taken = pickFilesToTake(files, existing, gid, draftType, origin);
    const rest = files.filter(f => !taken.includes(f));
    if (!taken.length || (rest.length && filesExceedDiscordLimit([...existing, ...rest], gid))) {
        offerExcludedFiles(files, gid, guildId ?? null, channel.id, draftType);
        return false;
    }

    taken.forEach(f => bypassedFiles.add(f));
    lastBypassChannelId = channel.id;
    scheduleInterceptorHealthCheck();
    return true;
}

function extractFilesFromValue(value: unknown): File[] {
    if (value instanceof File) return [value];

    if (!Array.isArray(value)) return [];

    return value.flatMap(entry => {
        if (entry instanceof File) return [entry];

        if (!entry || typeof entry !== "object") return [];

        const entryFile = "file" in entry ? entry.file : null;
        if (entryFile instanceof File) return [entryFile];

        const item = "item" in entry && entry.item && typeof entry.item === "object" ? entry.item : null;
        if (!item || !("file" in item)) return [];

        return item.file instanceof File ? [item.file] : [];
    });
}

function removeFilesFromValue(value: unknown, toRemove: ReadonlySet<File>): unknown {
    if (value instanceof File) return toRemove.has(value) ? [] : value;
    if (!Array.isArray(value)) return value;

    return value.filter(entry => {
        const [file] = extractFilesFromValue([entry]);
        return !file || !toRemove.has(file);
    });
}

function collectPayloadFiles(payload: UploadAddFilesEvent): File[] {
    return [
        ...extractFilesFromValue(payload.files),
        ...extractFilesFromValue(payload.uploads),
        ...extractFilesFromValue(payload.items)
    ];
}

function removeFilesFromPayload(payload: UploadAddFilesEvent, toRemove: ReadonlySet<File>): void {
    for (const key of ["files", "uploads", "items"] as const) {
        if (payload[key] !== undefined) payload[key] = removeFilesFromValue(payload[key], toRemove);
    }
}

function interceptUploadAddFiles(event: unknown): void {
    try {
        if (!pluginActive) return;
        if (!event || typeof event !== "object" || !("type" in event)) return;

        const payload = event as UploadAddFilesEvent;
        if (payload.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;

        const dispatched = collectPayloadFiles(payload);
        const now = Date.now();
        if (dispatched.some(f => bypassedFiles.has(f)) || (dispatched.length > 0 && payload.channelId != null && payload.channelId === lastBypassChannelId && now - lastBypassAt <= INTERCEPTOR_HEALTH_WINDOW_MS)) {
            lastUploadDispatchAt = now;
        }
        if (!interceptorHealthy && dispatched.length) {
            interceptorHealthy = true;
            interceptorWarned = false;
            logger.info("Upload interception is working again. Resuming the size-gate bypass.");
        }

        const entries = Array.isArray(payload.files) ? payload.files : [];
        if (isDeclinedBatch(payload.channelId, entries.length, true)) return;
        if (!isOriginEnabled(entryField(entries[0], "origin"))) return;
        if (!isPrimaryReady()) {
            if (payload.draftType === DraftType.ChannelMessage || payload.draftType === DraftType.FirstThreadMessage) {
                const thumbnails = new Set(extractFilesFromValue(entries.filter(e => entryField(e, "isThumbnail") === true)));
                showPrimaryNotReadyToast(dispatched.filter(f => !thumbnails.has(f)), getGuildIdForChannel(payload.channelId));
            }
            return;
        }

        if (payload.draftType !== DraftType.ChannelMessage && payload.draftType !== DraftType.FirstThreadMessage) {
            if (dispatched.length && filesExceedDiscordLimit(dispatched, getGuildIdForChannel(payload.channelId))) {
                showToast({ text: "BigFileUpload can't take this kind of upload (such as a poll). The file is over your Discord limit and may fail to send" });
            }
            return;
        }

        const thumbnails = new Set(extractFilesFromValue(entries.filter(e => entryField(e, "isThumbnail") === true)));
        const allFiles = Array.from(new Set(dispatched)).filter(f => !thumbnails.has(f));
        if (!allFiles.length) return;
        const pinned = new Set(extractFilesFromValue(entries.filter(e => entryField(e, "id") != null)));

        const guildId = getGuildIdForChannel(payload.channelId);
        const excludedFiles = allFiles.filter(f => !isFileTypeAllowed(f));

        if (excludedFiles.length && filesExceedDiscordLimit(excludedFiles, guildId)) {
            showToast({ text: "Some files are over your Discord limit but excluded under Allowed File Types. Discord may refuse them when you send", variant: "critical" });
        }

        const homeless = new Set(filesNoHostAccepts(allFiles.filter(f => !pinned.has(f)), guildId));
        if (homeless.size) {
            removeFilesFromPayload(payload, homeless);
            showNoHostToast([...homeless]);
        }

        const origin = entryField(entries[0], "origin");
        const toTake = pickFilesToTake(allFiles.filter(f => !pinned.has(f) && !homeless.has(f)), [...getDraftFiles(payload.channelId, payload.draftType), ...allFiles.filter(f => pinned.has(f))], guildId, payload.draftType, origin);
        if (!toTake.length) return;

        removeFilesFromPayload(payload, new Set(toTake));
        void uploadProvidedFiles(toTake, { channelId: payload.channelId ?? null, draftType: typeof payload.draftType === "number" ? payload.draftType : undefined, automatic: true });
    } catch (error) {
        logger.error("Failed to intercept upload", error);
    }
}

type IncomingFilesDecision = "take" | "decline" | "pass";

function decideIncomingFiles(files: File[], channel: Channel, draftType: number, origin: "clipboard" | "drag_drop"): IncomingFilesDecision {
    if (!pluginActive || !channel?.id || !files.length || !files.every(f => f instanceof File)) return "pass";
    if (!isPrimaryReady()) return "pass";
    if (!isOriginEnabled(origin)) return "decline";
    if (origin === "clipboard" && EditMessageStore.getEditingMessage(channel.id)) return "decline";
    const guildId = channel.guild_id ?? null;
    if (origin === "clipboard" && files.length === 1 && draftType === DraftType.ChannelMessage && !settings.store.bypassDiscordUploadOnlyOverLimit
        && skipInAlwaysInterceptMode(files[0], origin, f => filesExceedDiscordLimit([f], guildId))) return "decline";
    return pickFilesToTake(files, getDraftFiles(channel.id, draftType), guildId, draftType, origin).length === files.length ? "take" : "pass";
}

function handleIncomingFiles(list: ArrayLike<File>, channel: Channel, draftType: number, origin: "clipboard" | "drag_drop", composer?: unknown): boolean {
    try {
        const files = Array.from(list);
        const decision = decideIncomingFiles(files, channel, draftType, origin);
        if (decision === "decline") declinedBatch = { channelId: channel.id, count: files.length, at: Date.now() };
        if (decision !== "take") return false;
        void uploadProvidedFiles(files, { channelId: channel.id, draftType, automatic: true, ...typeof composer === "string" && { composer } });
        return true;
    } catch (error) {
        logger.error(`The ${origin === "clipboard" ? "paste" : "drop"} hook failed, leaving the files to Discord`, error);
        return false;
    }
}

const PROGRESS_COMPOSERS = new Set(["normal", "sidebar", "thread_creation", "create_forum_post", "create_announcement_post"]);

const mountedBars = new Map<string, number>();

const mountedBarListeners = new Set<() => void>();

function trackMountedBar(key: string, delta: number) {
    const n = (mountedBars.get(key) ?? 0) + delta;
    if (n > 0) mountedBars.set(key, n);
    else mountedBars.delete(key);
    mountedBarListeners.forEach(l => l());
}

const composerKey = (channelId: string, composer: string) => `${channelId}|${composer}`;

const ProgressBarInner = ({ channelId, draftType, composer }: { channelId: string; draftType: unknown; composer: string; }) => {
    const [state, setState] = useState(getUploadState);
    const [, setMountedTick] = useState(0);
    const [queueOpen, setQueueOpen] = useState(false);
    const selectedId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());

    useEffect(() => {
        const unsubscribe = subscribeUploadState(() => setState(getUploadState()));
        setState(getUploadState());
        return unsubscribe;
    }, []);

    useEffect(() => {
        const listener = () => setMountedTick(n => n + 1);
        mountedBarListeners.add(listener);
        return () => void mountedBarListeners.delete(listener);
    }, []);

    useEffect(() => {
        if (typeof draftType !== "number") return;
        const key = `${channelId}:${draftType}`;
        trackMountedBar(key, 1);
        return () => trackMountedBar(key, -1);
    }, [channelId, draftType]);

    useEffect(() => {
        const key = composerKey(channelId, composer);
        trackMountedBar(key, 1);
        return () => trackMountedBar(key, -1);
    }, [channelId, composer]);

    if (state.phase === "idle" || (state.channelId ?? selectedId) !== channelId) return null;
    if (state.composer && mountedBars.has(composerKey(channelId, state.composer))) {
        if (composer !== state.composer) return null;
    } else if (state.draftType != null && typeof draftType === "number" && draftType !== state.draftType
        && (draftType !== DraftType.ChannelMessage || mountedBars.has(`${channelId}:${state.draftType}`))) return null;

    const percentage = Math.max(0, Math.min(100, state.percent));
    const indeterminate = state.indeterminate && (state.phase === "uploading" || state.phase === "retrying" || state.phase === "downloading");
    const progressLabel = indeterminate
        ? formatSize(state.totalBytes)
        : state.totalBytes > 0
            ? `${Math.round(percentage)}% - ${formatSize(state.transferredBytes)} of ${formatSize(state.totalBytes)}`
            : `${Math.round(percentage)}%`;
    const attempt = (state.phase === "uploading" || state.phase === "retrying") && state.attempt > 0 && state.totalAttempts > 1
        ? { text: `Attempt ${state.attempt}/${state.totalAttempts}`, spoken: `attempt ${state.attempt} of ${state.totalAttempts}` }
        : null;

    return (
        <div
            className={cl("progress-wrap")}
            data-phase={state.phase}
        >
            <div className={cl("progress-head")}>
                <div className={cl("progress-label")}>
                    {state.status || "Uploading..."}
                </div>
                <div className={cl("progress-meta")}>
                    <span className={cl("progress-percent")}>
                        {progressLabel}
                    </span>
                    {attempt && (
                        <span className={cl("progress-attempt")}>
                            {attempt.text}
                        </span>
                    )}
                    {state.queued > 0 && (
                        <button
                            className={cl("progress-queue-toggle")}
                            type="button"
                            aria-expanded={queueOpen}
                            onClick={() => setQueueOpen(open => !open)}
                        >
                            {`+${state.queued} queued ${queueOpen ? "▴" : "▾"}`}
                        </button>
                    )}
                    {state.canCancel && (
                        <button
                            className={cl("progress-cancel")}
                            type="button"
                            title={state.lateWait ? "Gives up on the link. The host may keep the file" : undefined}
                            onClick={cancelCurrentUpload}
                        >
                            {state.lateWait ? "Stop waiting" : state.queued > 0 ? "Cancel current" : "Cancel"}
                        </button>
                    )}
                    {state.queued > 0 && (
                        <button
                            className={cl("progress-cancel")}
                            type="button"
                            title={state.lateWait ? "Drops the queued uploads. The current file keeps waiting for its link" : undefined}
                            onClick={cancelAllUploads}
                        >
                            Cancel all
                        </button>
                    )}
                    {state.keptLink && (
                        <button
                            className={cl("progress-copy")}
                            type="button"
                            title={`Copies the link of ${state.keptLink.fileName}`}
                            onClick={() => copyKeptLink(state.keptLink!)}
                        >
                            Copy link
                        </button>
                    )}
                    {(state.phase === "failed" || state.phase === "cancelled") && (
                        <button
                            className={cl("progress-cancel")}
                            type="button"
                            onClick={dismissUploadState}
                        >
                            Dismiss
                        </button>
                    )}
                </div>
            </div>
            <div
                className={cl("progress-track")}
                role="progressbar"
                aria-label={state.fileName ? `Uploading ${state.fileName}` : "Upload progress"}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={indeterminate ? undefined : Math.round(percentage)}
                aria-valuetext={attempt ? `${progressLabel}, ${attempt.spoken}` : progressLabel}
            >
                <div
                    className={cl("progress-fill")}
                    data-indeterminate={indeterminate || undefined}
                    style={indeterminate ? undefined : { width: `${percentage}%` }}
                />
            </div>
            <div className={cl("progress-file")}>
                {state.fileName || ""}{state.currentServiceLabel ? ` • ${state.currentServiceLabel}` : ""}
            </div>
            {queueOpen && state.queuedItems.length > 0 && (
                <ul className={cl("progress-queue")} aria-label="Queued uploads">
                    {state.queuedItems.map(item => (
                        <li key={item.id} className={cl("progress-queue-item")}>
                            <span className={cl("progress-queue-name")}>{item.name}</span>
                            {item.size != null && <span className={cl("progress-queue-size")}>{formatSize(item.size)}</span>}
                            <button
                                className={cl("progress-queue-remove")}
                                type="button"
                                aria-label={`Remove ${item.name} from the queue`}
                                title="Remove from the queue"
                                onClick={() => removeQueuedUpload(item.id)}
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

const ProgressBar = ErrorBoundary.wrap(ProgressBarInner, { noop: true });

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    const { itemSrc, itemHref, target } = props;
    const media = getMediaUrls({ src: itemSrc, href: itemHref, target });

    if (!media) return;

    const group = findGroupChildrenByChildId("open-native-link", children)
        ?? findGroupChildrenByChildId("copy-link", children);

    if (group && !group.some(child => child?.props?.id === "file-upload")) {
        const serviceType = settings.store.serviceType as ServiceType;
        const serviceName = serviceLabel(serviceType);

        group.push(
            <Menu.MenuItem
                label={`Upload to ${serviceName}`}
                key="file-upload"
                id="file-upload"
                iconLeft={CloudUploadIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: CloudUploadIcon
                }}
                action={() => uploadFile(media.url, undefined, media.discordProxyUrl)}
            />
        );
    }
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    if ("href" in props && !props.src) return;

    const media = getMediaUrls(props);
    if (!media) return;

    if (children.some(child => child?.props?.id === "file-upload-group")) return;

    const serviceType = settings.store.serviceType as ServiceType;
    const serviceName = serviceLabel(serviceType);

    children.push(
        <Menu.MenuGroup id="file-upload-group">
            <Menu.MenuItem
                label={`Upload to ${serviceName}`}
                key="file-upload"
                id="file-upload"
                iconLeft={CloudUploadIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: CloudUploadIcon
                }}
                action={() => uploadFile(media.url, undefined, media.discordProxyUrl)}
            />
        </Menu.MenuGroup>
    );
};

async function handleUploadFileFromDraft(upload: CloudUpload, channelId: string, draftType: number, composer?: string) {
    const file = upload.item?.file;
    if (!file) return;

    if (!isFileTypeAllowed(file)) {
        showToast({ text: "This file type is excluded under Allowed File Types", variant: "critical" });
        return;
    }

    const blocked = uploadBlocker();
    if (blocked) {
        showToast({ text: blocked, variant: "critical", duration: 8000 });
        return;
    }

    try {
        const stillWanted = () => (UploadAttachmentStore.getUploads(channelId, draftType) ?? []).some((u: CloudUpload) => u.id === upload.id);
        const uploaded = await uploadProvidedFiles([file], { channelId, draftType, composer, forceSend: true, stillWanted, ...upload.spoiler === true && { spoiler: true } });
        if (uploaded) {
            UploadManager.remove(channelId, upload.id, draftType);
        }
    } catch (e) {
        logger.warn("Draft upload encountered an unexpected error", e);
    }
}

const ExternalIcon = () => <OpenExternalIcon height={24} width={24} />;

const channelAttachMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!channel) return;
    if (channel.guild_id && !PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel)) return;
    if (children.some(child => child?.props?.id === "file-upload-manual" || child?.props?.id === "file-upload-uploads")) return;

    const draftType: number = props?.draftType ?? DraftType.ChannelMessage;
    const name = props?.chatInputType?.analyticsName;
    const composer = typeof name === "string" ? name : undefined;
    const uploads = UploadAttachmentStore.getUploads(channel.id, draftType);
    const draftUploads = Array.isArray(uploads) ? uploads.filter((u: CloudUpload) => u.item?.file && isFileTypeAllowed(u.item.file)) : [];

    if (draftUploads.length > 0) {
        children.splice(1, 0,
            <Menu.MenuItem
                id="file-upload-uploads"
                key="file-upload-uploads"
                label="Upload to Host"
                iconLeft={ExternalIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: ExternalIcon
                }}
            >
                {draftUploads.map((upload: CloudUpload) => (
                    <Menu.MenuItem
                        id={`file-upload-draft-${upload.id}`}
                        key={upload.id}
                        label={upload.filename}
                        action={() => handleUploadFileFromDraft(upload, channel.id, draftType, composer)}
                    />
                ))}
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="file-upload-manual"
                    key="file-upload-manual"
                    label="Choose File..."
                    action={() => uploadPickedFile({ channelId: channel.id, draftType, composer })}
                />
            </Menu.MenuItem>
        );
    } else {
        children.splice(1, 0,
            <Menu.MenuItem
                id="file-upload-manual"
                key="file-upload-manual"
                label="Upload to Host"
                iconLeft={ExternalIcon}
                leadingAccessory={{
                    type: "icon",
                    icon: ExternalIcon
                }}
                action={() => uploadPickedFile({ channelId: channel.id, draftType, composer })}
            />
        );
    }
};

function safely(what: string, run: () => void): void {
    try {
        run();
    } catch (error) {
        logger.error(`${what} failed`, error);
    }
}

initCorsProxyPrompt();

export default definePlugin({
    name: "BigFileUpload",
    description: "Bypass Discord's upload limit by uploading to external file hosts.",
    tags: ["Media"],
    authors: [Devs.ScattrdBlade, Devs.creations, { name: "keircn", id: 1230319937155760131n }],
    settings,
    patches: [
        {
            find: ".CREATE_FORUM_POST||",
            replacement: {
                match: /(?<=type:(\i),targetRef:\i,editorRef:\i,.{0,300}?textValue:\i,editorHeight:\i,channelId:(\i)\.id\}\))/,
                replace: markHit("progress", ",($self.renderUploadProgress($2,$1))")
            }
        },
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(async function \i\(\i,(\i),(\i)\)\{let\{(?=(?:[^}]*?isThumbnail:(\i))?)(?=(?:[^}]*?origin:(\i))?)[^}]*?requireConfirm:(\i)=!0.{0,1500}?if\()(?=\(0,\i\.\i\)\(\{files:(\i),guildId:(\i)[^}]*\}\)\)return void \i\(\i,\i\))/,
                replace: (_, head: string, channel: string, draftType: string, isThumbnail: string | undefined, origin: string | undefined, requireConfirm: string, files: string, guildId: string) => {
                    patchHits.gate = true;
                    return `${head}!(${requireConfirm}&&$self.shouldBypassDiscordUploadSizeCheck({files:${files},guildId:${guildId},channel:${channel},draftType:${draftType},origin:${origin ?? "void 0"},isThumbnail:${isThumbnail ?? "!1"}}))&&`;
                }
            }
        },
        {
            find: '{requireConfirm:!0,origin:"clipboard"}',
            replacement: {
                match: /if\(null==(\i)\)return (\i)\((\i),(\i),(\i)\.drafts\.type,\{requireConfirm:!0,origin:"clipboard"\}\)/,
                replace: markHit("paste", 'if(null==$1){if($self.onDiscordPaste($3,$4,$5.drafts.type,$5.analyticsName))return;return $2($3,$4,$5.drafts.type,{requireConfirm:!0,origin:"clipboard"})}')
            }
        },
        {
            find: 'origin:"drag_drop"',
            replacement: {
                match: /onDrop:function\((\i)\)\{if\((\i)\)return!1;(\i)&&null!=(\i)&&(?=\(\(0,\i\.\i\)\(\1,\4,(\i),\{requireConfirm:)/,
                replace: markHit("drop", "onDrop:function($1){if($2)return!1;if($3&&null!=$4&&$self.onDiscordDrop($1,$4,$5))return;$3&&null!=$4&&")
            }
        },
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "channel-attach": channelAttachMenuPatch
    },
    start() {
        let fresh: boolean | null = null;
        try {
            fresh = migrateSettings();
        } catch (error) {
            logger.error("Settings migration failed", error);
        }
        safely("The CORS-proxy start check", () => startCorsProxyPrompt(fresh));

        if (uploadAddFilesInterceptor) {
            return;
        }

        pluginActive = true;
        interceptorHealthy = true;
        interceptorWarned = false;
        lastUploadDispatchAt = 0;
        lastBypassAt = 0;
        lastBypassChannelId = null;
        integrationCheck.problems = null;
        declinedBatch = null;
        uploadAddFilesInterceptor = event => interceptUploadAddFiles(event);
        FluxDispatcher.addInterceptor(uploadAddFilesInterceptor);

        safely("Scheduling the integration check", () => { integrationCheckTimer = setTimeout(checkIntegration, INTEGRATION_CHECK_DELAY_MS); });
        safely("The native-helper check", () => {
            if (IS_WEB || hasNativeHelper) return;
            logger.error("Native helper is not loaded. Uploads will use the CSP-restricted renderer path. Rebuild Vencord (pnpm build) and fully restart the app.");
            showToast({ text: "BigFileUpload: native helper not loaded. Rebuild Vencord and fully restart the app", variant: "critical", duration: 10000 });
        });
        safely("The conflicting-plugins check", warnConflictingPlugins);
        safely("The progress announcer", startProgressAnnouncer);
        void loadHttpOrigins();
    },
    stop() {
        if (!uploadAddFilesInterceptor) {
            return;
        }

        pluginActive = false;
        stopProgressAnnouncer();
        if (pendingInterceptorHealthCheck) {
            clearTimeout(pendingInterceptorHealthCheck);
            pendingInterceptorHealthCheck = null;
        }
        if (integrationCheckTimer) {
            clearTimeout(integrationCheckTimer);
            integrationCheckTimer = null;
        }

        try {
            // _interceptors is a private Flux field with no removal API
            const interceptors = FluxDispatcher._interceptors;
            if (Array.isArray(interceptors)) {
                for (let i = interceptors.length - 1; i >= 0; i--) {
                    if (interceptors[i] === uploadAddFilesInterceptor) {
                        interceptors.splice(i, 1);
                    }
                }
            }
        } catch (error) {
            logger.error("Failed to remove the upload interceptor", error);
        }

        uploadAddFilesInterceptor = null;
    },
    patchHits,
    integrationCheck,
    shouldBypassDiscordUploadSizeCheck(call: GateCall = {}): boolean {
        try {
            return decideGateBypass(call);
        } catch (error) {
            logger.error("Size gate decision failed, leaving the batch to Discord", error);
            return false;
        }
    },
    onDiscordPaste(files: File[], channel: Channel, draftType: number, composer?: unknown): boolean {
        return handleIncomingFiles(files, channel, draftType, "clipboard", composer);
    },
    onDiscordDrop(files: FileList, channel: Channel, draftType: number): boolean {
        return handleIncomingFiles(files, channel, draftType, "drag_drop");
    },
    renderUploadProgress(channel: Channel | undefined, chatInputType: { analyticsName?: string; drafts?: { type?: unknown; }; } | undefined) {
        const composer = chatInputType?.analyticsName ?? "";
        if (!channel?.id || !PROGRESS_COMPOSERS.has(composer)) return null;
        return <ProgressBar channelId={channel.id} draftType={chatInputType?.drafts?.type} composer={composer} />;
    }
});

const CONFLICTING_PLUGINS: Record<string, string> = {
    FileUpload: "Equicord's copy of this plugin, which takes the same uploads",
    AutoZipper: "zips dropped and pasted files in its own listeners before Discord's handlers run",
    Encryptcord: "handles the same uploads"
};

export function warnConflictingPlugins(): void {
    const found = Object.keys(CONFLICTING_PLUGINS).filter(name => name in plugins && isPluginEnabled(name));
    if (!found.length) return;
    logger.warn("Plugins that conflict with BigFileUpload are enabled:", found.map(name => `${name} (${CONFLICTING_PLUGINS[name]})`).join("; "));
    const many = found.length > 1;
    showToast({ text: `BigFileUpload: ${listNames(found)} ${many ? "are" : "is"} also enabled and may take the same uploads. Turn ${many ? "them" : "it"} off if uploads go wrong`, variant: "critical", duration: 10000 });
}

let region: HTMLElement | null = null;

let unsubscribe: (() => void) | null = null;

let lastPhase = "idle";

let lastKind = "";

function ensureRegion(): HTMLElement | null {
    if (region || !document.body) return region;
    region = document.createElement("div");
    region.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    document.body.appendChild(region);
    return region;
}

function announce(text: string): void {
    const el = ensureRegion();
    if (!el) return;
    el.textContent = el.textContent === text ? text + String.fromCharCode(0xA0) : text;
}

function onUploadState(): void {
    try {
        const { phase, status } = getUploadState();
        if (phase === "idle") {
            lastPhase = phase;
            lastKind = "";
            return;
        }
        const text = status || "Uploading...";
        const kind = text.replace(/\d+/g, "#");
        if (phase === lastPhase && kind === lastKind) return;
        lastPhase = phase;
        lastKind = kind;
        announce(text);
    } catch (error) {
        logger.warn("Couldn't announce the upload status", error);
    }
}

export function startProgressAnnouncer(): void {
    if (unsubscribe) return;
    lastPhase = getUploadState().phase;
    lastKind = "";
    ensureRegion();
    unsubscribe = subscribeUploadState(onUploadState);
}

export function stopProgressAnnouncer(): void {
    unsubscribe?.();
    unsubscribe = null;
    region?.remove();
    region = null;
}

export type OfferReason = "notReady" | "excluded";

const MAX_ASKS = 3;

const countFiles = (n: number) => n > 1 ? `${n} files` : "a file";

const describeFiles = (files: readonly File[]) => files.length > 1 ? `${files.length} files` : files[0].name || "this file";

const nameFiles = (files: readonly File[]) => files.length > 3 ? `${files.length} files` : listNames(files.map(f => f.name || "a file"));

const them = (files: readonly File[]) => files.length > 1 ? "them" : "it";

type OfferedHost = NonNullable<ReturnType<typeof offerHost>>;

function offerGroups(files: readonly File[]): { host: OfferedHost; files: File[]; }[] | null {
    const groups: { host: OfferedHost; files: File[]; }[] = [];
    for (const file of files) {
        const host = offerHost(file);
        if (!host) return null;
        const group = groups.find(g => g.host.service === host.service && g.host.description === host.description);
        if (group) group.files.push(file);
        else groups.push({ host, files: [file] });
    }
    return groups;
}

const routeKey = (groups: readonly { host: OfferedHost; files: File[]; }[], files: readonly File[]) =>
    JSON.stringify(files.map(f => {
        const { host } = groups.find(g => g.files.includes(f))!;
        return [host.service, host.description];
    }));

export function offerUploadWith(files: readonly File[], target: UploadTarget, reason: OfferReason): void {
    if (!files.length) return;
    const what = countFiles(files.length);
    const notReady = reason === "notReady";
    if (!notReady && !offerGroups(files)) return;
    const excluded = files.filter(f => !isFileTypeAllowed(f)).length;
    const why = excluded === files.length ? them(files) : `${excluded} of them`;
    const body = notReady
        ? `Discord can't send ${what} over its upload limit, and ${primaryNotReadyReason()}. Click to open BigFileUpload's settings.`
        : `Discord can't send ${what} over its upload limit, and BigFileUpload's allowed file types exclude ${why}. Click to upload ${them(files)} with BigFileUpload anyway.`;
    try {
        void Promise.resolve(showNotification({
            title: notReady ? "BigFileUpload isn't set up" : "Upload with BigFileUpload?",
            body,
            noPersist: true,
            onClick: notReady ? openPluginSettings : () => void confirmOffer(files, target)
        })).catch(error => logger.error("Couldn't show the upload offer", error));
    } catch (error) {
        logger.error("Couldn't show the upload offer", error);
    }
}

async function confirmOffer(files: readonly File[], target: UploadTarget): Promise<void> {
    try { window.focus(); } catch { }
    const what = describeFiles(files);
    let named: string | null = null;
    for (let asked = 0; ; asked++) {
        if (!isPrimaryReady()) {
            showToast({ text: primaryNotReadyText(), variant: "critical", duration: 8000 });
            openPluginSettings();
            return;
        }
        const blocked = uploadBlocker();
        if (blocked) {
            showToast({ text: blocked, variant: "critical", duration: 8000 });
            return;
        }
        const groups = offerGroups(files);
        if (!groups) {
            showToast({ text: `No active upload host can take ${what}`, variant: "critical", duration: 8000 });
            return;
        }
        const route = routeKey(groups, files);
        if (named === route) {
            await uploadProvidedFiles(files, { ...target, confirmed: true });
            return;
        }
        if (asked === MAX_ASKS) {
            showToast({ text: "BigFileUpload's upload host kept changing while it asked, so nothing was uploaded", variant: "critical", duration: 8000 });
            return;
        }
        const where = groups.length === 1
            ? `Upload ${them(files)} to ${groups[0].host.description} instead?`
            : `Upload them with BigFileUpload instead? ${groups.map(g => `${nameFiles(g.files)} to ${g.host.description}`).join("; ")}.`;
        const ok = await askToUseHost({
            title: "Upload with BigFileUpload?",
            question: `Discord can't send ${what} over its upload limit. ${where}`,
            confirmText: `Upload to ${listNames([...new Set(groups.map(g => g.host.label))])}`,
            cancelText: "Cancel"
        }).answer;
        if (!ok) return;
        named = route;
    }
}
