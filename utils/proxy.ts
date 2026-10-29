/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Settings } from "@api/Settings";
import { PluginNative } from "@utils/types";
import { React, showToast } from "@webpack/common";

import { CORS_PROXY, describeProxy, findProxyPreset, isGenericWebdav, isPresetProxy, isPublicProxyUrl, logger, normalizeCorsProxyUrl, proxyAddressProblem, proxyKey, SERVICES, ServiceType, toProxiedUrl } from "../types";
import { getMimeFromExtension, getUrlExtension } from "./media";
import { isProxyReachableHost } from "./shared";

export { needsOriginConfirmation } from "../types";

const synced = () => Settings.plugins.BigFileUpload;

const DUE_KEY = "BigFileUpload_corsPromptDue";

const ANSWER_KEY = "BigFileUpload_corsPromptAnswer";

const LOCAL_KEY = "BigFileUpload_proxyLocal";

const FRESH_KEY = "BigFileUpload_freshPending";

export type ProxyAnswer = "accepted" | "declined" | "dismissed";

export interface StoredAnswer {
    answer: ProxyAnswer;
    proxy: string;
    acceptId?: string;
}

export interface DeviceState {
    primed: boolean;
    unreadable: boolean;
    answer: StoredAnswer | null;
    due: boolean;
    proxyLocal: "on" | "off" | null;
    freshPending: boolean;
}

type Key = "answer" | "due" | "proxyLocal" | "freshPending";

const STORE_KEYS: Record<Key, string> = { answer: ANSWER_KEY, due: DUE_KEY, proxyLocal: LOCAL_KEY, freshPending: FRESH_KEY };

let state: DeviceState = { primed: false, unreadable: false, answer: null, due: false, proxyLocal: null, freshPending: true };

const written = new Set<Key>();

const listeners = new Set<() => void>();

function asAnswer(value: unknown): StoredAnswer | null {
    const v = value as StoredAnswer | null | undefined;
    if (!v || !["accepted", "declined", "dismissed"].includes(v.answer) || typeof v.proxy !== "string") return null;
    return { answer: v.answer, proxy: v.proxy, ...typeof v.acceptId === "string" && { acceptId: v.acceptId } };
}

export const sameAnswer = (a: StoredAnswer | null, b: StoredAnswer | null) =>
    a === b || (a != null && b != null && a.answer === b.answer && a.proxy === b.proxy && a.acceptId === b.acceptId);

function patch(next: Partial<DeviceState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
}

let channel: BroadcastChannel | null = null;

export function openDeviceChannel(): void {
    if (channel || typeof BroadcastChannel !== "function") return;
    try {
        channel = new BroadcastChannel("BigFileUpload");
        channel.onmessage = ({ data }: MessageEvent<{ keys?: Key[]; origins?: boolean; http?: boolean; }>) => {
            for (const key of data?.keys ?? []) written.delete(key);
            if (data?.origins) invalidateOrigins();
            if (data?.http) {
                httpRevision++;
                insecure = null;
                loading = null;
                notifyHttpPrefs();
                void loadHttpOrigins();
            }
            void primeDeviceState();
        };
    } catch (error) {
        logger.warn("Couldn't open the channel to other BigFileUpload tabs", error);
    }
}

function write(key: Key, next: Partial<DeviceState>, value: unknown): Promise<void> {
    written.add(key);
    patch(next);
    return DataStore.set(STORE_KEYS[key], value).then(() => {
        try { channel?.postMessage({ keys: [key] }); } catch { }
    }).catch(error => logger.error(`Couldn't save this device's CORS-proxy state (${key})`, error));
}

export async function primeDeviceState(): Promise<void> {
    try {
        const [answer, due, proxyLocal, freshPending] = await Promise.all([ANSWER_KEY, DUE_KEY, LOCAL_KEY, FRESH_KEY].map(k => DataStore.get<unknown>(k)));
        const next: Partial<DeviceState> = { primed: true, unreadable: false };
        if (!written.has("answer")) {
            const read = asAnswer(answer);
            if (!sameAnswer(read, state.answer)) next.answer = read;
        }
        if (!written.has("due")) next.due = due === true;
        if (!written.has("proxyLocal")) next.proxyLocal = proxyLocal === "on" || proxyLocal === "off" ? proxyLocal : null;
        if (!written.has("freshPending")) next.freshPending = freshPending === true;
        patch(next);
    } catch (error) {
        logger.error("Couldn't read this device's CORS-proxy answer. It counts as unanswered for this session", error);
        patch({
            primed: true,
            unreadable: true,
            ...!written.has("freshPending") && { freshPending: false }
        });
    }
}

export const peekDeviceState = (): DeviceState => state;

export const peekDeviceProxyAnswer = () => state.answer;

export const peekProxyLocal = () => state.proxyLocal ?? "off";

export const peekFreshPending = () => state.freshPending;

export function subscribeDeviceState(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useDeviceState(): DeviceState {
    return React.useSyncExternalStore(subscribeDeviceState, peekDeviceState);
}

const newAcceptId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function setDeviceProxyAnswer(answer: ProxyAnswer, { clearDue }: { clearDue: boolean; }): Promise<void> {
    const key = proxyKey(getActiveCorsProxyUrl());
    if (answer === "accepted" && key == null) {
        logger.error("Not recording a CORS-proxy acceptance: the proxy address is unusable");
        return Promise.resolve();
    }
    const stored: StoredAnswer = { answer, proxy: key ?? "", ...answer === "accepted" && { acceptId: newAcceptId() } };
    if (answer === "declined") dropAlwaysOrigins(() => false);
    else if (stored.acceptId) dropAlwaysOrigins(e => e.acceptId === stored.acceptId);
    const writes = [write("answer", { answer: stored }, stored)];
    if (clearDue) writes.push(setDue(false));
    return Promise.all(writes).then(() => { });
}

export function setDue(due: boolean): Promise<void> {
    if (due) dropAlwaysOrigins(() => false);
    return write("due", { due }, due);
}

export const setProxyLocal = (value: "on" | "off") => write("proxyLocal", { proxyLocal: value }, value);

export const setFreshPending = (value: boolean) => write("freshPending", { freshPending: value }, value);

export function initDeviceState(fresh: boolean | null): void {
    if (fresh) {
        void setProxyLocal("off");
        void setFreshPending(true);
        return;
    }
    if (state.proxyLocal != null) return;
    void setProxyLocal(fresh === false && corsProxyAllowed() ? "on" : "off");
    if (fresh === null) void setFreshPending(true);
}

export function answerProxyHere(accept: boolean, proxyUrl?: string): void {
    asLocalProxyWrite(() => {
        try {
            const s = synced();
            s.disableCorsProxy = !accept;
            if (accept) {
                if (proxyUrl !== undefined && proxyKey(proxyUrl) != null) {
                    if (proxyKey(proxyUrl) !== proxyKey(getActiveCorsProxyUrl())) s.corsProxyUrl = proxyUrl;
                } else if (proxyInvalid() || synced().corsProxyUrl?.trim() === "none") s.corsProxyUrl = CORS_PROXY;
            }
        } catch (error) {
            logger.error("Couldn't save the CORS-proxy setting", error);
        }
    });
    void setProxyLocal(accept ? "on" : "off");
    void setFreshPending(false);
    void setDeviceProxyAnswer(accept ? "accepted" : "declined", { clearDue: true });
}

let localWrites = 0;

function asLocalProxyWrite<T>(run: () => T): T {
    localWrites++;
    try {
        return run();
    } finally {
        localWrites--;
    }
}

export function setProxyUrlHere(url: string): void {
    asLocalProxyWrite(() => {
        try {
            synced().corsProxyUrl = url;
        } catch (error) {
            logger.error("Couldn't save the CORS proxy address", error);
        }
    });
    const key = answerKey();
    const s = state.answer;
    if (s?.answer !== "accepted" || key == null || s.proxy === key) return;
    if (key !== "") {
        void setDeviceProxyAnswer("accepted", { clearDue: false });
        return;
    }
    const stored: StoredAnswer = { answer: "accepted", proxy: "" };
    dropAlwaysOrigins(() => false);
    void write("answer", { answer: stored }, stored);
}

export function restoreProxyUrlHere(url: string): { ask: boolean; dueBefore: boolean; } {
    const dueBefore = state.due;
    asLocalProxyWrite(() => {
        try {
            synced().corsProxyUrl = url;
        } catch (error) {
            logger.error("Couldn't restore the CORS proxy address", error);
        }
    });
    const s = state.answer;
    const ask = s?.answer === "accepted" && answerKey() !== s.proxy;
    if (ask) void setDue(true);
    return { ask, dueBefore };
}

export function confirmRestoredProxy(dueBefore: boolean): void {
    if (state.answer?.answer !== "accepted" || proxyKey(getActiveCorsProxyUrl()) == null) return;
    void setDeviceProxyAnswer("accepted", { clearDue: !dueBefore });
}

function answerKey(): string | null {
    return proxyKey(getActiveCorsProxyUrl()) ?? (rawProxyUrl() === "none" ? "" : null);
}

let proxyChangeNotifier: (host: string) => void = () => { };

export function setProxyChangeNotifier(notify: (host: string) => void): void {
    proxyChangeNotifier = notify;
}

export function noticeProxyChange(): void {
    if (localWrites || !state.primed || state.due) return;
    const s = state.answer;
    if (s?.answer !== "accepted") return;
    const url = getActiveCorsProxyUrl();
    const k = proxyKey(url);
    if (s.proxy === answerKey()) return;
    void setDue(true);
    if (k !== null) {
        try {
            proxyChangeNotifier(describeProxy(url).host);
        } catch (error) {
            logger.error("Couldn't announce the CORS-proxy change", error);
        }
    }
}

export const recordDismissal = () => void setDeviceProxyAnswer("dismissed", { clearDue: false });

const rawProxyUrl = () => (synced().corsProxyUrl as string | undefined)?.trim() ?? "";

export function proxyInvalid(): boolean {
    const raw = rawProxyUrl();
    return raw !== "" && raw !== "none" && proxyKey(raw) == null;
}

export const proxyInvalidReason = () => proxyInvalid() ? proxyAddressProblem(rawProxyUrl()) : null;

export function redirectTickFor(url: string | undefined): boolean {
    const s = synced();
    const key = proxyKey(url);
    return s.corsProxyNoRedirects === true && key != null && s.corsProxyNoRedirectsFor === key;
}

export function setRedirectTick(url: string | undefined, on: boolean): void {
    const s = synced();
    const key = on ? proxyKey(url) ?? "" : "";
    const tick = key !== "";
    if ((s.corsProxyNoRedirects === true) !== tick) s.corsProxyNoRedirects = tick;
    if ((s.corsProxyNoRedirectsFor ?? "") !== key) s.corsProxyNoRedirectsFor = key;
}

export function proxyRedirectsSafe(): boolean {
    const url = getActiveCorsProxyUrl();
    if (url === "none") return false;
    const preset = findProxyPreset(url);
    return preset ? preset.safeRedirects : redirectTickFor(url);
}

export function getActiveCorsProxyUrl(): string {
    const raw = rawProxyUrl();
    if (raw === "") return CORS_PROXY;
    if (raw === "none" || proxyKey(raw) == null) return "none";
    return normalizeCorsProxyUrl(raw);
}

export function corsProxyAllowed(): boolean {
    return !synced().disableCorsProxy && getActiveCorsProxyUrl() !== "none";
}

export function proxyAllowedHere(): boolean {
    return corsProxyAllowed() && peekProxyLocal() !== "off" && state.answer?.answer !== "declined";
}

export function consentPending(): boolean {
    const s = state.answer;
    return !state.primed || state.due || s == null || s.answer === "dismissed" || (s.answer === "accepted" && s.proxy !== answerKey());
}

export function proxyConsentGiven(): boolean {
    const s = state.answer;
    const k = proxyKey(getActiveCorsProxyUrl());
    return state.primed && proxyAllowedHere() && s?.answer === "accepted" && k !== null && s.proxy === k && !state.due;
}

export function proxyOffReason(): string {
    if (proxyInvalid()) return "the CORS proxy address in settings is invalid. Fix it under Network";
    if (!corsProxyAllowed()) return "turned off under Network";
    if (state.answer?.answer === "declined") return "off on this device";
    return "until you answer the CORS-proxy question on this device";
}

let promptBusy = false;

let idleWaiters: (() => void)[] = [];

export function setPromptBusy(busy: boolean): void {
    promptBusy = busy;
    if (busy) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
}

export const whenPromptIdle = (): Promise<void> => promptBusy ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();

const ALWAYS_KEY = "BigFileUpload_alwaysOrigins";

const LAN_KEY = "BigFileUpload_lanOrigins";

export interface AlwaysOrigin {
    service: string;
    origin: string;
    proxy: string;
    acceptId: string;
}

export interface ProxyOrigins {
    always: readonly AlwaysOrigin[];
    lan: readonly string[];
}

let origins: ProxyOrigins = { always: [], lan: [] };

let originsLoaded = false;

let originQueue: Promise<void> = Promise.resolve();

let originsLoading: Promise<void> | null = null;

const originListeners = new Set<() => void>();

const pendingRevocations = new Set<(o: ProxyOrigins) => ProxyOrigins>();

function asAlways(value: unknown): AlwaysOrigin[] {
    if (!Array.isArray(value)) return [];
    return value.filter((e): e is AlwaysOrigin => ["service", "origin", "proxy", "acceptId"].every(k => typeof e?.[k] === "string"))
        .map(({ service, origin, proxy, acceptId }) => ({ service, origin, proxy, acceptId }));
}

const asOrigins = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((o): o is string => typeof o === "string"))] : [];

function setOrigins(next: ProxyOrigins): void {
    origins = [...pendingRevocations].reduce((o, revoke) => revoke(o), next);
    for (const listener of originListeners) listener();
}

export function loadProxyOrigins(): Promise<void> {
    openDeviceChannel();
    return originsLoading ??= Promise.resolve().then(async () => {
        try {
            const [always, lan] = await DataStore.getMany<unknown>([ALWAYS_KEY, LAN_KEY]);
            originsLoaded = true;
            setOrigins({ always: asAlways(always), lan: asOrigins(lan) });
        } catch (error) {
            originsLoading = null;
            originsLoaded = false;
            logger.warn("Couldn't read this device's CORS-proxy retry choices", error);
        }
    });
}

const originKeys = (o: ProxyOrigins) => [...o.always.map(e => JSON.stringify(e)), ...o.lan];

function invalidateOrigins(): void {
    const before = originKeys(origins);
    originsLoading = null;
    originQueue = originQueue.then(async () => {
        originsLoading = null;
        await loadProxyOrigins();
        const kept = new Set(originKeys(origins));
        if (before.some(k => !kept.has(k))) for (const listener of forgetListeners) listener(null);
    }).catch(error => logger.warn("Couldn't refresh this device's CORS-proxy retry choices", error));
}

function changeOrigins(change: (o: ProxyOrigins) => ProxyOrigins, revoke = false): void {
    if (revoke) {
        pendingRevocations.add(change);
        setOrigins(change(origins));
    }
    originQueue = originQueue.then(async () => {
        await loadProxyOrigins();
        if (!originsLoaded) throw new Error("Stored retry choices couldn't be read, so they weren't replaced");
        const next = change(origins);
        if (!revoke && next.always === origins.always && next.lan === origins.lan) return;
        const writes = await Promise.allSettled([
            DataStore.update<unknown>(ALWAYS_KEY, old => change({ always: asAlways(old), lan: [] }).always),
            DataStore.update<unknown>(LAN_KEY, old => change({ always: [], lan: asOrigins(old) }).lan)
        ]);
        try { channel?.postMessage({ origins: true }); } catch { }
        for (const write of writes) if (write.status === "rejected") throw write.reason;
        pendingRevocations.delete(change);
        originsLoading = null;
        await loadProxyOrigins();
    }).catch(error => {
        logger.warn("Couldn't save this device's CORS-proxy retry choices", error);
        showToast({ text: "Couldn't save this device's proxy choices. Other tabs may still use the previous choices", variant: "critical", duration: 8000 });
    });
}

function dropAlwaysOrigins(keep: (e: AlwaysOrigin) => boolean): void {
    changeOrigins(o => ({ ...o, always: o.always.filter(keep) }), true);
}

export function addAlwaysOrigin(service: string, origin: string): void {
    const proxy = proxyKey(getActiveCorsProxyUrl());
    const acceptId = state.answer?.answer === "accepted" ? state.answer.acceptId : undefined;
    if (proxy == null || !acceptId) return;
    const entry: AlwaysOrigin = { service, origin, proxy, acceptId };
    changeOrigins(o => ({ ...o, always: [...o.always.filter(e => e.service !== service || e.origin !== origin || e.proxy !== proxy), entry] }));
}

const forgetListeners = new Set<(entry: AlwaysOrigin | null) => void>();

export function onAlwaysOriginsForgotten(listener: (entry: AlwaysOrigin | null) => void): () => void {
    forgetListeners.add(listener);
    return () => forgetListeners.delete(listener);
}

export function removeAlwaysOrigin(entry: AlwaysOrigin): void {
    const same = (e: AlwaysOrigin) => e.service === entry.service && e.origin === entry.origin && e.proxy === entry.proxy && e.acceptId === entry.acceptId;
    changeOrigins(o => ({ ...o, always: o.always.filter(e => !same(e)) }), true);
    for (const listener of forgetListeners) listener(entry);
}

export function alwaysRetryAllowed(service: string, origin: string): boolean {
    const proxy = proxyKey(getActiveCorsProxyUrl());
    const acceptId = state.answer?.answer === "accepted" ? state.answer.acceptId : undefined;
    return proxy != null && acceptId !== undefined && origins.always.some(e => e.service === service && e.origin === origin && e.proxy === proxy && e.acceptId === acceptId);
}

export const isLanOrigin = (origin: string) => origins.lan.includes(origin);

export function rememberLanOrigin(origin: string): void {
    if (originsLoaded && origins.lan.includes(origin)) return;
    changeOrigins(o => o.lan.includes(origin) ? o : { ...o, lan: [...o.lan, origin] });
}

export function forgetLanOrigin(origin: string): void {
    changeOrigins(o => ({ ...o, lan: o.lan.filter(x => x !== origin) }), true);
}

export function forgetProxyOrigins(): void {
    changeOrigins(() => ({ always: [], lan: [] }), true);
    for (const listener of forgetListeners) listener(null);
}

function subscribeProxyOrigins(listener: () => void): () => void {
    originListeners.add(listener);
    return () => originListeners.delete(listener);
}

export const peekProxyOrigins = () => origins;

export function useAlwaysOrigins(): ProxyOrigins {
    if (!originsLoading) void loadProxyOrigins();
    return React.useSyncExternalStore(subscribeProxyOrigins, peekProxyOrigins);
}

const KEY = "BigFileUpload_httpOrigins";

const INSECURE_KEY = "BigFileUpload_insecureHttpOrigins";

export interface InsecureHttpEntry {
    service: string;
    origin: string;
}

let cache: Set<string> | null = null;

let insecure: InsecureHttpEntry[] | null = null;

const earlyChanges: ((list: InsecureHttpEntry[]) => InsecureHttpEntry[])[] = [];

let loading: Promise<void> | null = null;

let httpRevision = 0;

const listenersHttpOrigins = new Set<() => void>();

let version = 0;

export function subscribeHttpPrefs(listener: () => void): () => void {
    listenersHttpOrigins.add(listener);
    return () => listenersHttpOrigins.delete(listener);
}

export function notifyHttpPrefs(): void {
    version++;
    for (const listener of listenersHttpOrigins) listener();
}

export function useDevicePrefs(): number {
    return React.useSyncExternalStore(subscribeHttpPrefs, () => version);
}

function asEntries(value: unknown): InsecureHttpEntry[] {
    if (!Array.isArray(value)) return [];
    return value.filter((e): e is InsecureHttpEntry => typeof e?.service === "string" && typeof e?.origin === "string")
        .map(({ service, origin }) => ({ service, origin }));
}

export function loadHttpOrigins(): Promise<void> {
    openDeviceChannel();
    return loading ??= Promise.resolve().then(async () => {
        const revision = httpRevision;
        try {
            const stored = await DataStore.get<unknown>(KEY);
            const origins = Array.isArray(stored) ? stored.filter((o): o is string => typeof o === "string") : [];
            cache = new Set([...origins, ...(cache ?? [])]);
        } catch (error) {
            logger.warn("Couldn't read the http origins used on this device", error);
            cache ??= new Set();
        }
        try {
            const stored = asEntries(await DataStore.get<unknown>(INSECURE_KEY));
            if (revision === httpRevision) insecure = earlyChanges.splice(0).reduce((list, change) => change(list), stored);
        } catch (error) {
            logger.warn("Couldn't read this device's \"Allow Insecure HTTP\" choices", error);
            insecure ??= [];
        }
        notifyHttpPrefs();
    });
}

export function hasUploadedToHttpOrigin(origin: string): boolean {
    return cache?.has(origin) ?? false;
}

export function rememberHttpOrigin(origin: string): void {
    if (cache?.has(origin)) return;
    (cache ??= new Set()).add(origin);
    DataStore.update<unknown>(KEY, old => [...new Set([...(Array.isArray(old) ? old : []), origin])])
        .then(() => { try { channel?.postMessage({ http: true }); } catch { } })
        .catch(error => logger.warn("Couldn't save an http origin used on this device", error));
}

export function isInsecureHttpAllowed(service: string, origin: string): boolean {
    return insecure?.some(e => e.service === service && e.origin === origin) ?? false;
}

export function insecureHttpEntries(): readonly InsecureHttpEntry[] {
    if (!loading) void loadHttpOrigins();
    return insecure ?? [];
}

export function setInsecureHttp(service: string, origin: string, allowed: boolean): void {
    httpRevision++;
    const change = (list: InsecureHttpEntry[]) => {
        const rest = list.filter(e => e.service !== service || e.origin !== origin);
        return allowed ? [...rest, { service, origin }] : rest;
    };
    if (!insecure) earlyChanges.push(change);
    insecure = change(insecure ?? []);
    notifyHttpPrefs();
    DataStore.update<unknown>(INSECURE_KEY, old => change(asEntries(old)))
        .then(() => {
            loading = null;
            void loadHttpOrigins();
            try { channel?.postMessage({ http: true }); } catch { }
        })
        .catch(error => logger.warn("Couldn't save this device's \"Allow Insecure HTTP\" choice", error));
}

const DOWN_MS = 5 * 60 * 1000;

const PROXY_FIRST_MS = 10 * 60 * 1000;

type HostState = { kind: "down"; until: number; } | { kind: "proxy-first"; until: number; proxy: string; };

const states = new Map<string, HostState>();

export function markHostDown(origin: string, now = Date.now()): void {
    const state = states.get(origin);
    if (state?.kind === "proxy-first" && state.until > now) return;
    states.set(origin, { kind: "down", until: now + DOWN_MS });
}

export function markProxyFirst(origin: string, proxy: string, now = Date.now()): void {
    states.set(origin, { kind: "proxy-first", until: now + PROXY_FIRST_MS, proxy });
}

export function proxyFirstEntry(origin: string, now = Date.now()): string | null {
    const state = states.get(origin);
    if (state?.kind !== "proxy-first") return null;
    if (state.until <= now) {
        states.delete(origin);
        return null;
    }
    return state.proxy;
}

export function dropProxyFirst(origin?: string): void {
    for (const [key, state] of states) if (state.kind === "proxy-first" && (origin === undefined || key === origin)) states.delete(key);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", () => {
        dropProxyFirst();
        clearEmbedFailures();
    });
    window.addEventListener("offline", () => dropProxyFirst());
}

export function isHostDown(origin: string, now = Date.now()): boolean {
    const state = states.get(origin);
    if (!state) return false;
    if (state.until <= now) {
        states.delete(origin);
        return false;
    }
    return state.kind === "down";
}

export const ROUTING_KEYS = [
    "serviceType", "fallbackActive", "disableFallbacks", "corsProxyUrl", "disableCorsProxy",
    "serviceUrl", "ziplineToken", "nestToken", "ezHostKey", "encryptingHostKey",
    "s3Endpoint", "s3Bucket", "s3Region", "s3ForcePathStyle", "s3AccessKeyId", "s3SecretAccessKey", "s3SessionToken", "s3PublicUrl",
    "catboxUserhash", "gofileToken", "pixelVaultKey", "pixelDrainKey", "sharexConfig",
    "webdavUrl", "webdavUsername", "webdavPassword"
] as const;

let routing: string | undefined;

export const routingSnapshot = (values: Readonly<Record<string, unknown>>) => JSON.stringify(ROUTING_KEYS.map(key => values[key] ?? null));

export function checkRoutingSettings(values: Readonly<Record<string, unknown>>): boolean {
    const current = routingSnapshot(values);
    const changed = routing !== undefined && current !== routing;
    if (changed) states.clear();
    routing = current;
    return changed;
}

interface EmbedSettings {
    embedProxyEnabled?: boolean;
    embedProxyService?: string;
    embedUseCustomProxy?: boolean;
    embedCustomProxyFor?: string;
    embedProxyPrivateHosts?: boolean;
    embedSkipNative?: boolean;
    s3PublicUrl?: string;
    webdavServerType?: string;
    webdavUrl?: string;
}

const syncedEmbedProxy = () => Settings.plugins.BigFileUpload as EmbedSettings;

const Native = IS_WEB
    ? null
    : (VencordNative.pluginHelpers.BigFileUpload as PluginNative<typeof import("../native")> | undefined) ?? null;

export const NATIVE_EMBED_MAX = 45 * 1024 * 1024;

export const EMBED_SAMPLE = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

const WRAPPER_IMAGE = {
    autocompressor: "https://autocompressor.net/images/av1-dt/default_thumbnail_16_9.png",
    x266: "https://x266.mov/images/thumb.jpg"
} as const;

const LINK_WAIT_MS = 4000;

const WAIT_NOTICE_MS = 300;

const PROBE_TIMEOUT_MS = 5000;

const PROBE_BODY_MAX = 64 * 1024;

const UP_TTL_MS = 30 * 60 * 1000;

const DOWN_TTL_MS = 5 * 60 * 1000;

const VIDEO_DIMS_WAIT_MS = 3000;

export type EmbedService = "cors" | "autocompressor" | "x266";

export type EmbedTarget = { kind: "cors"; proxy: string; } | { kind: "autocompressor" | "x266"; };

export type Health = "up" | "down" | "pending" | "unknown";

type Probed = "up" | "down" | "unknown";

export interface VideoDims { w: number; h: number; }

export function getEmbedProxyService(): EmbedService {
    const service = syncedEmbedProxy().embedProxyService;
    return service === "autocompressor" || service === "x266" ? service : "cors";
}

export const strictPending = () => peekDeviceState().freshPending;

export function customProxyOptedIn(active = getActiveCorsProxyUrl()): boolean {
    const s = syncedEmbedProxy();
    const key = proxyKey(active);
    return Boolean(s.embedUseCustomProxy) && key != null && s.embedCustomProxyFor === key && !isPresetProxy(active) && isPublicProxyUrl(active);
}

export function corsProxyWrapsVideo(): boolean {
    if (!proxyAllowedHere()) return false;
    const active = getActiveCorsProxyUrl();
    return isPresetProxy(active) || customProxyOptedIn(active);
}

export function embedTarget(): EmbedTarget | null {
    const service = getEmbedProxyService();
    if (strictPending()) return null;
    if (service !== "cors") return { kind: service };
    const active = getActiveCorsProxyUrl();
    if (proxyAllowedHere()) {
        if (isPresetProxy(active)) return { kind: "cors", proxy: findProxyPreset(active)!.url };
        if (customProxyOptedIn(active)) return { kind: "cors", proxy: active };
    }
    return { kind: "autocompressor" };
}

const targetKey = (t: EmbedTarget) => t.kind === "cors" ? `cors:${proxyKey(t.proxy)}` : t.kind;

export function embedTargetName(t: EmbedTarget): string {
    if (t.kind !== "cors") return t.kind === "autocompressor" ? "autocompressor.net" : "x266.mov";
    return describeProxy(t.proxy).host;
}

export function embedTargetLabel(t: EmbedTarget): string {
    if (t.kind !== "cors") return embedTargetName(t);
    const d = describeProxy(t.proxy);
    return d.preset ? `the CORS proxy (${d.host}, run by ${d.operator})` : `your proxy (${d.host})`;
}

export function wrapUrl(t: EmbedTarget, url: string, dims?: VideoDims): string | null {
    switch (t.kind) {
        case "cors":
            return toProxiedUrl(url, t.proxy);
        case "autocompressor":
            return `https://autocompressor.net/av1?v=${encodeURIComponent(url)}${dims ? `&w=${dims.w}&h=${dims.h}` : ""}`;
        case "x266":
            return /[?#]/.test(url) ? null : `https://x266.mov/e/${url}`;
    }
}

export function isVideoLink(url: string, contentType?: string): boolean {
    const ext = getUrlExtension(url);
    return ext ? getMimeFromExtension(ext).startsWith("video/") : Boolean(contentType?.toLowerCase().startsWith("video/"));
}

function wrappableLink(url: string, service: ServiceType, contentType?: string): boolean {
    if (service === ServiceType.ENCRYPTINGHOST || /[?#]/.test(url) || !URL.canParse(url)) return false;
    const u = new URL(url);
    if (u.username || u.password || u.search || u.hash) return false;
    if (service === ServiceType.S3 && !syncedEmbedProxy().s3PublicUrl?.trim()) return false;
    if (service === ServiceType.WEBDAV && !isGenericWebdav(syncedEmbedProxy().webdavServerType, syncedEmbedProxy().webdavUrl)) return false;
    if (!getUrlExtension(url) && SERVICES[service]?.directMedia !== true && service !== ServiceType.S3) return false;
    return isVideoLink(url, contentType);
}

async function privateLinkReachable(url: string): Promise<boolean> {
    if (!syncedEmbedProxy().embedProxyPrivateHosts || !URL.canParse(url)) return false;
    const u = new URL(url);
    if (u.search || u.protocol !== "https:" || !isProxyReachableHost(u.hostname)) return false;
    await loadProxyOrigins();
    return !isLanOrigin(u.origin);
}

const NATIVE_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

export function isNativelyEmbeddable(url: string, service: ServiceType, size: number): boolean {
    if (!URL.canParse(url) || !(size <= NATIVE_EMBED_MAX)) return false;
    const ext = getUrlExtension(url)?.toLowerCase();
    if (!ext || !NATIVE_EXTENSIONS.has(ext) || !new URL(url).pathname.toLowerCase().endsWith(`.${ext}`)) return false;
    const direct = SERVICES[service]?.directMedia;
    if (direct === true) return true;
    if (direct !== "user") return false;
    return service !== ServiceType.WEBDAV || isGenericWebdav(syncedEmbedProxy().webdavServerType, syncedEmbedProxy().webdavUrl);
}

export interface EmbedContext {
    service: ServiceType;
    size: number;
    contentType?: string;
    dims?: Promise<VideoDims | undefined>;
}

export interface EmbedWait {
    onWait?(name: string): void;
    stop?: Promise<unknown>;
}

export async function wrapForEmbed(url: string, ctx: EmbedContext, wait?: EmbedWait): Promise<string> {
    const s = syncedEmbedProxy();
    if (!s.embedProxyEnabled) return url;
    if (!wrappableLink(url, ctx.service, ctx.contentType)) return url;
    if (SERVICES[ctx.service]?.privacy === "private" && !await privateLinkReachable(url)) return url;
    if (s.embedSkipNative !== false && isNativelyEmbeddable(url, ctx.service, ctx.size)) return url;
    const target = embedTarget();
    if (!target) return url;
    const health = await embedServiceHealthy(target, LINK_WAIT_MS, wait);
    if (health === "up") return wrapUrl(target, url, target.kind === "autocompressor" ? await ctx.dims : undefined) ?? url;
    if (health !== "down") return url;
    for (const alt of embedFallbacks(target)) {
        if (await embedServiceHealthy(alt, LINK_WAIT_MS, wait) !== "up") continue;
        const wrapped = wrapUrl(alt, url, alt.kind === "autocompressor" ? await ctx.dims : undefined);
        if (!wrapped) continue;
        noteEmbedFallback(target, alt);
        return wrapped;
    }
    noteEmbedDown(target);
    return url;
}

export function embedFallbacks(primary: EmbedTarget): EmbedTarget[] {
    const active = getActiveCorsProxyUrl();
    const cors: EmbedTarget | null = corsProxyWrapsVideo() ? { kind: "cors", proxy: isPresetProxy(active) ? findProxyPreset(active)!.url : active } : null;
    const all: (EmbedTarget | null)[] = [cors, { kind: "autocompressor" }, { kind: "x266" }];
    return all.filter((t): t is EmbedTarget => t != null && targetKey(t) !== targetKey(primary));
}

export interface EmbedPrediction {
    fileName: string;
    contentType?: string;
    size: number;
    service: ServiceType;
    endpoint?: string;
    outputsCanEmbed: boolean;
}

export async function predictEmbedTarget(p: EmbedPrediction): Promise<EmbedTarget | null> {
    const s = syncedEmbedProxy();
    if (!s.embedProxyEnabled || !p.outputsCanEmbed) return null;
    if (!isVideoLink(`https://link.invalid/${encodeURIComponent(p.fileName)}`, p.contentType)) return null;
    const info = SERVICES[p.service];
    if (!info || info.directMedia === false || p.service === ServiceType.ENCRYPTINGHOST) return null;
    if (p.service === ServiceType.S3 && !s.s3PublicUrl?.trim()) return null;
    if (p.service === ServiceType.WEBDAV && !isGenericWebdav(s.webdavServerType, s.webdavUrl)) return null;
    if (info.privacy === "private") {
        const endpoint = p.service === ServiceType.S3 ? s.s3PublicUrl : p.endpoint;
        if (!endpoint || !await privateLinkReachable(endpoint.trim())) return null;
    }
    if (s.embedSkipNative !== false && isNativelyEmbeddable(`https://link.invalid/${encodeURIComponent(p.fileName)}`, p.service, p.size)) return null;
    return embedTarget();
}

interface HealthEntry { health: Probed; at: number; }

const results = new Map<string, HealthEntry>();

const inflight = new Map<string, { generation: number; probe: Promise<Probed>; }>();

const listenersEmbedProxy = new Set<() => void>();

let healthVersion = 0;

let healthGeneration = 0;

function clearEmbedFailures(): void {
    healthGeneration++;
    for (const [key, result] of results) if (result.health !== "up") results.delete(key);
    downNoted.clear();
    fallbackNoted.clear();
    notifyHealth();
}

function notifyHealth(): void {
    healthVersion++;
    for (const listener of listenersEmbedProxy) listener();
}

function freshResult(key: string, now = Date.now()): HealthEntry | null {
    const e = results.get(key);
    if (!e) return null;
    return now - e.at < (e.health === "down" ? DOWN_TTL_MS : UP_TTL_MS) ? e : null;
}

export function probeEmbedTarget(target: EmbedTarget, force = false): Promise<Probed> {
    const key = targetKey(target);
    const cached = force ? null : freshResult(key);
    if (cached) return Promise.resolve(cached.health);
    const generation = healthGeneration;
    const running = inflight.get(key);
    if (running?.generation === generation) return running.probe;
    const probe = runProbe(target)
        .catch(error => {
            logger.warn(`Couldn't check ${embedTargetName(target)}`, error);
            return "down" as const;
        })
        .then(health => {
            if (generation === healthGeneration) results.set(key, { health, at: Date.now() });
            if (inflight.get(key)?.probe === probe) inflight.delete(key);
            notifyHealth();
            return health;
        });
    inflight.set(key, { generation, probe });
    notifyHealth();
    return probe;
}

export async function embedServiceHealthy(target: EmbedTarget, waitMs: number, wait?: EmbedWait): Promise<Health> {
    const cached = freshResult(targetKey(target));
    if (cached) return cached.health;
    const probe = probeEmbedTarget(target);
    const shown = setTimeout(() => wait?.onWait?.(embedTargetName(target)), WAIT_NOTICE_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"pending">(resolve => { timer = setTimeout(() => resolve("pending"), waitMs); });
    try {
        return await Promise.race([probe, late, ...wait?.stop ? [wait.stop.then(() => "pending" as const)] : []]);
    } finally {
        clearTimeout(shown);
        clearTimeout(timer);
    }
}

const downNoted = new Set<string>();

function noteEmbedDown(target: EmbedTarget): void {
    const key = targetKey(target);
    if (downNoted.has(key)) return;
    downNoted.add(key);
    const label = embedTargetLabel(target);
    const subject = target.kind === "cors" ? label[0].toUpperCase() + label.slice(1) : label;
    showToast({ text: `${subject} isn't responding, so the plain link was posted`, duration: 8000 });
}

const fallbackNoted = new Set<string>();

function noteEmbedFallback(down: EmbedTarget, used: EmbedTarget): void {
    const key = `${targetKey(down)}>${targetKey(used)}`;
    if (fallbackNoted.has(key)) return;
    fallbackNoted.add(key);
    const label = embedTargetLabel(down);
    const subject = down.kind === "cors" ? label[0].toUpperCase() + label.slice(1) : label;
    showToast({ text: `${subject} isn't responding, so video links use ${embedTargetLabel(used)} for now`, duration: 8000 });
}

export function checkEmbedNow(): void {
    const target = embedTarget();
    if (target) void probeEmbedTarget(target, true);
}

export type EmbedHealthView = { health: Health | "unchecked"; at?: number; };

export function peekEmbedHealth(target: EmbedTarget): EmbedHealthView {
    const key = targetKey(target);
    if (inflight.has(key)) return { health: "pending" };
    const e = results.get(key);
    return e ? { health: e.health, at: e.at } : { health: "unchecked" };
}

function subscribeHealth(listener: () => void): () => void {
    listenersEmbedProxy.add(listener);
    return () => listenersEmbedProxy.delete(listener);
}

export function useEmbedHealth(): number {
    return React.useSyncExternalStore(subscribeHealth, () => healthVersion);
}

let staleLogged = false;

function nativeProbe(): NonNullable<typeof Native> | null {
    if (!Native) return null;
    if (typeof Native.probeUrl !== "function") {
        if (!staleLogged) logger.info("Fully restart Discord to finish updating BigFileUpload (the embed service can't be checked until then)");
        staleLogged = true;
        return null;
    }
    return Native;
}

function withinProbeTime<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), PROBE_TIMEOUT_MS + 1000); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runProbe(target: EmbedTarget): Promise<Probed> {
    if (target.kind === "cors") return probeRelay(toProxiedUrl(EMBED_SAMPLE, target.proxy));
    return probeWrapper(target.kind);
}

const isVideoType = (type: string | null | undefined) => /^video\//i.test(type ?? "");

async function probeRelay(url: string): Promise<Probed> {
    if (!IS_WEB) {
        const native = nativeProbe();
        if (!native) return "unknown";
        const r = await withinProbeTime(native.probeUrl(url, "HEAD", undefined, PROBE_TIMEOUT_MS));
        return r.ok && r.status! >= 200 && r.status! < 300 && isVideoType(r.contentType) ? "up" : "down";
    }
    try {
        const res = await fetch(url, webProbeInit("HEAD"));
        return res.ok && isVideoType(res.headers.get("content-type")) ? "up" : "down";
    } catch {
        return "down";
    }
}

const webProbeInit = (method: "HEAD" | "GET"): RequestInit => ({
    method,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
});

async function probeWrapper(kind: "autocompressor" | "x266"): Promise<Probed> {
    const page = wrapUrl({ kind }, EMBED_SAMPLE)!;
    if (!IS_WEB) {
        const native = nativeProbe();
        if (!native) return "unknown";
        const r = await withinProbeTime(native.probeUrl(page, "GET", navigator.userAgent, PROBE_TIMEOUT_MS));
        return r.ok && servesEmbed(kind, r.status!, r.contentType, r.body ?? "") ? "up" : "down";
    }
    const active = getActiveCorsProxyUrl();
    if (proxyAllowedHere() && freshResult(`cors:${proxyKey(active)}`)?.health === "up") {
        try {
            const res = await fetch(toProxiedUrl(page, active), webProbeInit("GET"));
            return servesEmbed(kind, res.status, res.headers.get("content-type"), await readCapped(res)) ? "up" : "down";
        } catch {
            return "down";
        }
    }
    return probeImage(WRAPPER_IMAGE[kind]);
}

function probeImage(src: string): Promise<Probed> {
    if (typeof Image !== "function") return Promise.resolve("unknown");
    return new Promise(resolve => {
        const img = new Image();
        let settled = false;
        const done = (health: Probed) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            img.onload = img.onerror = null;
            img.removeAttribute("src");
            resolve(health);
        };
        const timer = setTimeout(() => done("down"), PROBE_TIMEOUT_MS);
        img.referrerPolicy = "no-referrer";
        img.onload = () => done("up");
        img.onerror = () => done("down");
        img.src = src;
    });
}

export async function readCapped(res: Response, max = PROBE_BODY_MAX): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let text = "";
    try {
        while (text.length < max) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.cancel().catch(() => { });
    }
    return text.slice(0, max);
}

const ENTITIES: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" };

function decodeEntities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] !== "#") return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

function tagAttr(tag: string, name: string): string | null {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

export function metaContents(html: string, prop: string): string[] {
    const found: string[] = [];
    for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
        const p = tagAttr(tag, "property") ?? tagAttr(tag, "name");
        if (p?.toLowerCase() !== prop) continue;
        const content = tagAttr(tag, "content");
        if (content != null) found.push(content.trim());
    }
    return found;
}

export function servesEmbed(kind: "autocompressor" | "x266", status: number, contentType: string | null | undefined, body: string): boolean {
    if (status !== 200 || !/^text\/html/i.test(contentType ?? "")) return false;
    const video = ["og:video:url", "og:video", "og:video:secure_url"].flatMap(p => metaContents(body, p));
    return video.includes(EMBED_SAMPLE) && metaContents(body, "og:image").includes(WRAPPER_IMAGE[kind]);
}

export function readVideoDims(file: Blob): Promise<VideoDims | undefined> {
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(undefined);
    return new Promise(resolve => {
        let url: string;
        try {
            url = URL.createObjectURL(file);
        } catch {
            resolve(undefined);
            return;
        }
        const video = document.createElement("video");
        let settled = false;
        const done = (dims?: VideoDims) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.onloadedmetadata = video.onerror = null;
            video.removeAttribute("src");
            try {
                video.load();
            } catch { }
            URL.revokeObjectURL(url);
            resolve(dims);
        };
        const timer = setTimeout(() => done(), VIDEO_DIMS_WAIT_MS);
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => done(video.videoWidth > 0 && video.videoHeight > 0 ? { w: video.videoWidth, h: video.videoHeight } : undefined);
        video.onerror = () => done();
        video.src = url;
    });
}
