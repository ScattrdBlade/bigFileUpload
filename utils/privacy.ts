/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { React } from "@webpack/common";

import { settings } from "../settings";
import { CredentialValues, isFilled, logger, readShareXConfig, serviceLabel, SERVICES, ServiceType, shareXSecretParts } from "../types";
import { isCredentialQueryKey, randomHexBytes } from "./shared";

const REDACTED = "[redacted]";

const MAX_LINE = 200;

const MAX_SCAN = 64 * 1024;

const SECRET_KEYS = [
    "ziplineToken", "nestToken", "ezHostKey", "encryptingHostKey", "s3AccessKeyId", "s3SecretAccessKey", "s3SessionToken",
    "catboxUserhash", "gofileToken", "gofileGuestToken", "pixelVaultKey", "pixelDrainKey", "webdavPassword"
];

const MIN_SECRET_LENGTH = 6;

const PLAIN_HEADERS = new Set(["accept", "content-type", "user-agent", "x-requested-with", "origin", "referer"]);

function basicToken(user: string, pass: string): string | undefined {
    try {
        return btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)));
    } catch {
        return undefined;
    }
}

export function configuredSecrets(values: CredentialValues): string[] {
    const found: string[] = [];
    const add = (value: unknown) => {
        if (isFilled(value)) found.push(value.trim());
    };
    const addUrlLogin = (raw: unknown) => {
        if (!isFilled(raw) || !URL.canParse(raw.trim())) return;
        const { username, password } = new URL(raw.trim());
        const decoded = [username, password].map(part => {
            try {
                return decodeURIComponent(part);
            } catch {
                return part;
            }
        });
        for (const part of [username, password, ...decoded]) add(part);
        if (username || password) add(basicToken(decoded[0], decoded[1]));
    };
    for (const key of SECRET_KEYS) add(values[key]);
    if (isFilled(values.webdavUsername) && isFilled(values.webdavPassword)) add(basicToken(values.webdavUsername.trim(), values.webdavPassword.trim()));
    if (isFilled(values.pixelDrainKey)) add(basicToken("", values.pixelDrainKey.trim()));
    for (const key of ["serviceUrl", "s3Endpoint", "webdavUrl"]) addUrlLogin(values[key]);
    if (isFilled(values.sharexConfig)) {
        try {
            const config = readShareXConfig(values.sharexConfig);
            for (const [name, value] of Object.entries(config.Headers ?? {})) {
                if (PLAIN_HEADERS.has(name.toLowerCase())) continue;
                add(value);
                if (typeof value === "string") add(/^\S+\s+(\S+)$/.exec(value.trim())?.[1]);
            }
            for (const record of [config.Arguments, config.Parameters]) for (const value of Object.values(record ?? {})) add(value);
            for (const part of shareXSecretParts(config, name => PLAIN_HEADERS.has(name.toLowerCase()))) add(part);
            addUrlLogin(config.RequestURL);
        } catch { }
    }
    return [...new Set(found.flatMap(s => [s, encodeURIComponent(s)]))].filter(s => s.length >= MIN_SECRET_LENGTH);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join(REDACTED);
    return out
        .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
        .replace(/(x-amz-security-token["']?\s*[:=]\s*["']?)[^\s&"'<>,;]+/gi, `$1${REDACTED}`)
        .replace(/\b(Bearer|Basic)(\s+)(?=[\w\-.~+/]*[\d\-.~+/=])[\w\-.~+/]{6,}=*/gi, `$1$2${REDACTED}`)
        .replace(/(authorization["']?\s*[:=]\s*["']?(?:basic|bearer)\s+)[\w\-.~+/]+=*/gi, `$1${REDACTED}`)
        .replace(/(:\/\/)[^\s/?#@"'<>]+@/g, `$1${REDACTED}@`)
        .replace(/(^|[?&;\s"'(,])([\w.-]+)=([^&\s"'<>#;,]+)/g, (match, before: string, key: string) =>
            isCredentialQueryKey(key) ? `${before}${key}=${REDACTED}` : match);
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&", nbsp: " " };

function decodeEntities(text: string): string {
    return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/gi, (match, dec: string, hex: string, name: string) => {
        const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : NaN;
        if (Number.isInteger(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
        return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : match;
    });
}

function oneLine(text: string): string {
    const line = text.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
    const chars = [...line];
    return chars.length > MAX_LINE ? `${chars.slice(0, MAX_LINE - 1).join("").trimEnd()}…` : line;
}

function jsonMessage(value: unknown, depth = 0): string | null {
    if (!value || typeof value !== "object" || depth > 2) return null;
    const record = value as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
        const field = record[key];
        if (typeof field === "string" && field.trim()) return field;
        const nested = jsonMessage(field, depth + 1);
        if (nested) return nested;
    }
    return Array.isArray(record.errors) ? jsonMessage(record.errors[0], depth + 1) : null;
}

const xmlTag = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]?.trim();

const looksLikeMarkup = (body: string, type: string) => /html|xml/.test(type) || body.startsWith("<") || /<!doctype|<html|<body|<\/[a-z][^<>]*>/i.test(body);

export function summarizeBody(text: string, contentType?: string | null): string {
    const body = text.trim();
    if (!body) return "";
    const type = (contentType ?? "").toLowerCase();
    if (type.includes("json") || /^[[{]/.test(body)) {
        let message: string | null = null;
        try {
            message = jsonMessage(JSON.parse(body));
        } catch { }
        if (message) return oneLine(message);
    }
    if (type.includes("xml") || /^<\?xml|<Error>/i.test(body)) {
        const parts = [xmlTag(body, "Code"), xmlTag(body, "Message")].filter(Boolean).map(part => decodeEntities(part!));
        if (parts.length) return oneLine(parts.join(": "));
    }
    if (!looksLikeMarkup(body, type)) return oneLine(body);
    const open = /<title[^<>]*>/i.exec(body);
    const close = open ? body.toLowerCase().indexOf("</title>", open.index + open[0].length) : -1;
    const title = open && close >= 0 ? body.slice(open.index + open[0].length, close) : undefined;
    const titled = title ? oneLine(decodeEntities(title.replace(/<[^<>]*>/g, " "))) : "";
    if (titled) return titled;
    return oneLine(decodeEntities(body.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^<>]*>/g, " ")));
}

const sessionSecrets = new Set<string>();

const transientSecrets = new Set<string>();

const MAX_SESSION_SECRETS = 32;

const MAX_TRANSIENT_SECRETS = 8;

export function rememberSessionSecret(value: string, transient = false): void {
    const [set, max] = transient ? [transientSecrets, MAX_TRANSIENT_SECRETS] : [sessionSecrets, MAX_SESSION_SECRETS];
    for (const form of new Set([value.trim(), encodeURIComponent(value.trim())])) {
        if (form.length < MIN_SECRET_LENGTH || set.has(form)) continue;
        if (set.size >= max) set.delete(set.values().next().value!);
        set.add(form);
    }
}

export function forgetSessionSecret(value: string): void {
    for (const form of [value.trim(), encodeURIComponent(value.trim())]) sessionSecrets.delete(form);
}

const deviceSecrets = new Map<string, string>();

export function setDeviceSecret(name: string, value: string): void {
    if (value.trim()) deviceSecrets.set(name, value.trim());
    else deviceSecrets.delete(name);
}

const deviceSecretForms = () => [...deviceSecrets.values()].flatMap(s => [s, encodeURIComponent(s)]).filter(s => s.length >= MIN_SECRET_LENGTH);

let historySecrets: string[] = [];

export function setHistorySecrets(values: readonly string[]): void {
    historySecrets = [...new Set(values.map(v => v.trim()).flatMap(v => [v, encodeURIComponent(v)]))].filter(s => s.length >= MIN_SECRET_LENGTH);
}

const secretsNow = () => [...configuredSecrets((settings.plain ?? {}) as CredentialValues), ...deviceSecretForms(), ...historySecrets, ...sessionSecrets, ...transientSecrets];

function redactCapped(text: string, secrets: readonly string[]): string {
    if (text.length <= MAX_SCAN) return redactSecrets(text, secrets);
    const tail = Math.max(64, ...secrets.map(s => s.length));
    return `${redactSecrets(text.slice(0, MAX_SCAN), secrets).slice(0, -tail)}… (cut from ${text.length} characters)`;
}

export const redactText = (text: string) => redactCapped(text, secretsNow());

export function cleanHostText(text: string): string {
    const secrets = secretsNow();
    return redactSecrets(oneLine(redactCapped(text, secrets)), secrets);
}

export function describeBody(text: string, contentType?: string | null): string {
    const secrets = secretsNow();
    return redactSecrets(summarizeBody(redactCapped(text, secrets), contentType), secrets);
}

export function describeHttpFailure(service: ServiceType | null, status: number, text: string, contentType?: string | null): string {
    const secrets = secretsNow();
    const body = redactCapped(text, secrets);
    if (body.trim()) logger.debug(`${service ? serviceLabel(service) : "The host"} answered ${status}:`, body);
    const summary = redactSecrets(summarizeBody(body, contentType), secrets);
    return summary ? `${status} ${summary}` : String(status);
}

const KEY = "BigFileUpload_uploadHistory";

export const MAX_HISTORY = 50;

export type Deletion =
    | { kind: "catbox"; file: string; }
    | { kind: "0x0"; url: string; token: string; }
    | { kind: "sharex"; url: string; }
    | { kind: "pixeldrain"; id: string; }
    | { kind: "webdav"; url: string; }
    | { kind: "s3"; url: string; };

export interface HistoryEntry {
    id: string;
    url: string;
    service: ServiceType;
    time: number;
    size: number;
    endpoint: { service: ServiceType; origin: string | null; };
    s3?: { endpoint: string; bucket: string; };
    deletion?: Deletion;
    anonymous?: true;
    cancelled?: true;
}

const str = (v: unknown): v is string => typeof v === "string" && v !== "";

function asDeletion(v: unknown): Deletion | undefined {
    const d = v as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return undefined;
    switch (d.kind) {
        case "catbox": return str(d.file) ? { kind: "catbox", file: d.file } : undefined;
        case "0x0": return str(d.url) && str(d.token) ? { kind: "0x0", url: d.url, token: d.token } : undefined;
        case "sharex": case "webdav": case "s3": return str(d.url) ? { kind: d.kind, url: d.url } : undefined;
        case "pixeldrain": return str(d.id) ? { kind: "pixeldrain", id: d.id } : undefined;
        default: return undefined;
    }
}

function asEntries(value: unknown): HistoryEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: HistoryEntry[] = [];
    for (const raw of value) {
        const e = raw as Record<string, unknown> | null;
        if (!e || !str(e.id) || !str(e.url) || !Object.hasOwn(SERVICES, e.service as string)) continue;
        const service = e.service as ServiceType;
        const endpoint = e.endpoint as Record<string, unknown> | undefined;
        const s3 = e.s3 as Record<string, unknown> | undefined;
        const deletion = asDeletion(e.deletion);
        entries.push({
            id: e.id,
            url: e.url,
            service,
            time: typeof e.time === "number" && Number.isFinite(e.time) ? e.time : 0,
            size: typeof e.size === "number" && Number.isFinite(e.size) ? e.size : 0,
            endpoint: { service, origin: str(endpoint?.origin) ? endpoint.origin : null },
            ...s3 && typeof s3.endpoint === "string" && typeof s3.bucket === "string" && { s3: { endpoint: s3.endpoint, bucket: s3.bucket } },
            ...deletion && e.anonymous !== true && { deletion },
            ...e.anonymous === true && { anonymous: true as const },
            ...e.cancelled === true && { cancelled: true as const }
        });
    }
    return entries.slice(0, MAX_HISTORY);
}

const secretsOf = (e: HistoryEntry): string[] => e.deletion?.kind === "0x0" ? [e.deletion.token] : e.deletion?.kind === "sharex" ? [e.deletion.url] : [];

let cache: HistoryEntry[] = [];

let loading: Promise<void> | null = null;

let loaded = false;

let queue: Promise<void> = Promise.resolve();

const deleting = new Set<string>();

const forgetLater = new Map<string, string[]>();

const listeners = new Set<() => void>();

let version = 0;

function notify(): void {
    version++;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useUploadHistory(): number {
    return React.useSyncExternalStore(subscribe, () => version);
}

function setCache(entries: HistoryEntry[]): void {
    for (const gone of cache.filter(e => deleting.has(e.id) && !entries.some(next => next.id === e.id))) {
        const secrets = secretsOf(gone);
        for (const secret of secrets) rememberSessionSecret(secret);
        forgetLater.set(gone.id, secrets);
    }
    cache = entries;
    setHistorySecrets(entries.flatMap(secretsOf));
    notify();
}

export function loadUploadHistory(): Promise<void> {
    openHistoryChannel();
    return loading ??= Promise.resolve().then(async () => {
        try {
            setCache(asEntries(await DataStore.get<unknown>(KEY)));
            loaded = true;
        } catch (error) {
            loading = null;
            logger.warn("Couldn't read this device's upload history", error);
        }
    });
}

async function loadForWrite(): Promise<void> {
    await loadUploadHistory();
    if (!loaded) throw new Error("the stored history couldn't be read, so it wasn't written over");
}

let historyChannel: BroadcastChannel | null = null;

function invalidateHistory(): void {
    queue = queue.then(async () => {
        loading = null;
        await loadUploadHistory();
    }).catch(error => logger.warn("Couldn't refresh this device's upload history", error));
}

function openHistoryChannel(): void {
    if (historyChannel || typeof BroadcastChannel !== "function") return;
    try {
        historyChannel = new BroadcastChannel("BigFileUpload_history");
        historyChannel.onmessage = invalidateHistory;
    } catch (error) {
        logger.warn("Couldn't watch upload history in other tabs", error);
    }
}

function change(edit: (entries: HistoryEntry[]) => HistoryEntry[], forgetRemoved = false): Promise<boolean> {
    let saved = false;
    queue = queue.then(async () => {
        await loadForWrite();
        let before: HistoryEntry[] = [], next: HistoryEntry[] = [];
        await DataStore.update<unknown>(KEY, stored => {
            before = asEntries(stored);
            next = edit(before).slice(0, MAX_HISTORY);
            return next;
        });
        for (const gone of before.filter(e => !next.includes(e))) {
            const secrets = secretsOf(gone);
            if (forgetRemoved && !deleting.has(gone.id)) {
                for (const secret of secrets) forgetSessionSecret(secret);
            } else {
                for (const secret of secrets) rememberSessionSecret(secret);
                if (forgetRemoved) forgetLater.set(gone.id, secrets);
            }
        }
        setCache(next);
        saved = true;
        try { historyChannel?.postMessage(null); } catch { }
    }).catch(error => logger.warn("Couldn't save this device's upload history", error));
    return queue.then(() => saved);
}

export function uploadHistory(): readonly HistoryEntry[] {
    if (!loading) void loadUploadHistory();
    return cache;
}

export const historyEntry = (id: string) => cache.find(e => e.id === id);

export const newHistoryId = () => `${Date.now().toString(36)}-${randomHexBytes(4)}`;

export function addHistoryEntry(entry: HistoryEntry): Promise<void> {
    for (const s of secretsOf(entry)) rememberSessionSecret(s);
    return change(entries => [entry, ...entries.filter(e => e.id !== entry.id)]).then(() => {});
}

export function removeHistoryEntry(id: string): Promise<void> {
    return change(entries => entries.filter(e => e.id !== id)).then(() => {});
}

function forget(drop: (e: HistoryEntry) => boolean): Promise<boolean> {
    return change(entries => entries.filter(e => !drop(e)), true);
}

export const forgetHistoryEntry = (id: string) => forget(e => e.id === id);

export const clearUploadHistory = () => forget(() => true);

export const isDeleting = (id: string) => deleting.has(id);

export function setDeleting(id: string, on: boolean): void {
    if (on) deleting.add(id);
    else {
        deleting.delete(id);
        for (const s of forgetLater.get(id) ?? []) forgetSessionSecret(s);
        forgetLater.delete(id);
    }
    notify();
}

export interface DeleteAction {
    label: string;
    problem: string | null;
    run(): Promise<boolean>;
}

let deleteActionFor: ((entry: HistoryEntry) => DeleteAction | null) | null = null;

export function setDeleteActions(make: (entry: HistoryEntry) => DeleteAction | null): void {
    deleteActionFor = make;
}

export function deleteAction(id: string): DeleteAction | null {
    const entry = historyEntry(id);
    return entry?.deletion && deleteActionFor ? deleteActionFor(entry) : null;
}
