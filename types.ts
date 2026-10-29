/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { hasSecretQuery, isProxyReachableHost, PROXY_MAX_BODY_BYTES } from "./utils/shared";

export enum ServiceType {
    ZIPLINE = "zipline",
    NEST = "nest",
    EZHOST = "ezhost",
    ENCRYPTINGHOST = "encryptinghost",
    S3 = "s3",
    CATBOX = "catbox",
    ZEROX0 = "0x0",
    LITTERBOX = "litterbox",
    SHAREX = "sharex",
    GOFILE = "gofile",
    TMPFILES = "tmpfiles",
    BUZZHEAVIER = "buzzheavier",
    TEMPSH = "tempsh",
    FILEBIN = "filebin",
    PIXELVAULT = "pixelvault",
    PIXELDRAIN = "pixeldrain",
    WEBDAV = "webdav"
}

export interface RetentionOptions {
    litterboxExpiry?: string;
    zeroX0Expiry?: string;
    tmpfilesExpiry?: string;
}

const LITTERBOX_KEPT: Record<string, string> = { "1h": "1 hour", "12h": "12 hours", "24h": "24 hours", "72h": "72 hours" };

export const ZEROX0_KEPT: Record<string, string> = { 1: "1 hour", 24: "24 hours", 72: "3 days", 168: "7 days", 720: "30 days" };

export const TMPFILES_KEPT: Record<string, string> = { 21600: "6 hours", 86400: "24 hours", 172800: "48 hours" };

// 0x0's published rule: min_age + (min_age - max_age) * (size / max_size - 1)^3
const ZEROX0_MAX_SIZE = 536_870_912;

export function zeroX0RetentionDays(size: number): number {
    const days = 30 + (30 - 365) * (size / ZEROX0_MAX_SIZE - 1) ** 3;
    return Math.min(365, Math.max(30, Math.round(days)));
}

export interface ServiceInfo {
    label: string;
    pickerLabel?: string;
    apiHost?: string;
    body: "multipart" | "binary";
    maxBytes: number | null;
    blockedExtensions?: RegExp;
    blocks?(file: { name: string; size: number; }): string | null;
    needsAuth: boolean;
    privacy: "public" | "private";
    confidential?: true;
    web: "direct" | "direct-simple" | "proxy" | "unsupported" | "user";
    directMedia: boolean | "user";
    retention?(size?: number, opts?: RetentionOptions): string;
    verified: string;
}

export const SERVICES: Record<ServiceType, ServiceInfo> = {
    [ServiceType.CATBOX]: {
        label: "Catbox",
        pickerLabel: "Catbox",
        apiHost: "catbox.moe",
        body: "multipart",
        maxBytes: 200_000_000,
        blockedExtensions: /^(exe|scr|cpl|jar|doc\w*)$/,
        blocks: file => /\.gif$/i.test(file.name) && file.size > 20_000_000 ? "Catbox accepts GIFs up to 20 MB" : null,
        needsAuth: false,
        privacy: "public",
        web: "proxy",
        directMedia: true,
        retention: () => "public, deleted after 2 idle years (anonymous)",
        verified: "2026-10-16; web 2026-10-18"
    },
    [ServiceType.LITTERBOX]: {
        label: "Litterbox",
        apiHost: "litterbox.catbox.moe",
        body: "multipart",
        maxBytes: 1_000_000_000,
        blockedExtensions: /^(exe|scr|cpl|jar|doc\w*)$/,
        needsAuth: false,
        privacy: "public",
        web: "direct-simple",
        directMedia: true,
        retention: (_, opts) => `public, deleted after ${LITTERBOX_KEPT[opts?.litterboxExpiry ?? ""] ?? "24 hours"}`,
        verified: "2026-10-16; web 2026-10-18"
    },
    [ServiceType.ZEROX0]: {
        label: "0x0.st",
        apiHost: "0x0.st",
        body: "multipart",
        maxBytes: ZEROX0_MAX_SIZE,
        blockedExtensions: /^(exe|jar)$/,
        needsAuth: false,
        privacy: "public",
        web: "unsupported",
        directMedia: true,
        retention: (size, opts) => Object.hasOwn(ZEROX0_KEPT, opts?.zeroX0Expiry ?? "") ? `public, deleted after ${ZEROX0_KEPT[opts!.zeroX0Expiry!]}`
            : size === undefined ? "public, kept 30 days to 1 year" : `public, kept about ${zeroX0RetentionDays(size)} days`,
        verified: "2026-10-16"
    },
    [ServiceType.TMPFILES]: {
        label: "tmpfiles.org",
        apiHost: "tmpfiles.org",
        body: "multipart",
        maxBytes: 104_857_600,
        needsAuth: false,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        retention: (_, opts) => `public, deleted after ${Object.hasOwn(TMPFILES_KEPT, opts?.tmpfilesExpiry ?? "") ? TMPFILES_KEPT[opts!.tmpfilesExpiry!] : "1 hour"}`,
        verified: "2026-10-16; web unanswered 2026-10-18"
    },
    [ServiceType.GOFILE]: {
        label: "GoFile",
        apiHost: "upload.gofile.io",
        body: "multipart",
        maxBytes: null,
        needsAuth: false,
        privacy: "public",
        web: "direct",
        directMedia: false,
        retention: () => "public, deleted after 10 days unused",
        verified: "2026-10-16; web 2026-10-18"
    },
    [ServiceType.BUZZHEAVIER]: {
        label: "buzzheavier.com",
        apiHost: "w.buzzheavier.com",
        body: "binary",
        maxBytes: null,
        needsAuth: false,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        retention: () => "public",
        verified: "2026-10-16"
    },
    [ServiceType.TEMPSH]: {
        label: "temp.sh",
        apiHost: "temp.sh",
        body: "multipart",
        maxBytes: 4_000_000_000,
        needsAuth: false,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        retention: () => "public, deleted after 3 days",
        verified: "2026-10-16"
    },
    [ServiceType.FILEBIN]: {
        label: "filebin.net",
        apiHost: "filebin.net",
        body: "binary",
        maxBytes: null,
        needsAuth: false,
        privacy: "public",
        web: "direct",
        directMedia: false,
        retention: () => "public, deleted after about 6 days",
        verified: "2026-10-16; web 2026-10-18"
    },
    [ServiceType.ZIPLINE]: {
        label: "Zipline",
        body: "multipart",
        maxBytes: null,
        needsAuth: true,
        privacy: "private",
        web: "user",
        directMedia: "user",
        verified: "2026-10-16"
    },
    [ServiceType.EZHOST]: {
        label: "E-Z Host",
        apiHost: "api.e-z.host",
        body: "multipart",
        maxBytes: null,
        needsAuth: true,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        verified: "2026-10-16"
    },
    [ServiceType.NEST]: {
        label: "Nest",
        apiHost: "nest.rip",
        body: "multipart",
        maxBytes: 45_000_000,
        needsAuth: true,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        verified: "2026-10-16"
    },
    [ServiceType.ENCRYPTINGHOST]: {
        label: "Encrypting.host",
        apiHost: "encrypting.host",
        body: "multipart",
        maxBytes: null,
        needsAuth: true,
        privacy: "public",
        confidential: true,
        web: "proxy",
        directMedia: false,
        verified: "2026-10-16"
    },
    [ServiceType.S3]: {
        label: "S3-Compatible",
        body: "binary",
        maxBytes: null,
        needsAuth: true,
        privacy: "private",
        web: "user",
        directMedia: "user",
        verified: "2026-10-16"
    },
    [ServiceType.PIXELVAULT]: {
        label: "PixelVault",
        apiHost: "pixelvault.co",
        body: "multipart",
        maxBytes: 25_000_000,
        needsAuth: true,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        verified: "2026-10-16"
    },
    [ServiceType.PIXELDRAIN]: {
        label: "PixelDrain",
        apiHost: "pixeldrain.com",
        body: "binary",
        maxBytes: 10_000_000_000,
        needsAuth: true,
        privacy: "public",
        web: "proxy",
        directMedia: false,
        retention: () => "public, deleted after 60 days unused",
        verified: "2026-10-16"
    },
    [ServiceType.WEBDAV]: {
        label: "WebDAV",
        pickerLabel: "WebDAV (Nextcloud/ownCloud)",
        body: "binary",
        maxBytes: null,
        needsAuth: true,
        privacy: "private",
        web: "user",
        directMedia: "user",
        verified: "2026-10-16"
    },
    [ServiceType.SHAREX]: {
        label: "ShareX/Custom Uploader",
        body: "multipart",
        maxBytes: null,
        needsAuth: false,
        privacy: "private",
        web: "user",
        directMedia: "user",
        verified: "2026-10-16"
    }
};

export const fallbackServiceOrder = Object.keys(SERVICES) as ServiceType[];

export function isR2Endpoint(endpoint: unknown): boolean {
    if (typeof endpoint !== "string" || !URL.canParse(endpoint.trim())) return false;
    return new URL(endpoint.trim()).hostname.toLowerCase().endsWith(".r2.cloudflarestorage.com");
}

export function isGenericWebdav(serverType: unknown, url: unknown): boolean {
    if (serverType === "generic") return true;
    if (typeof url !== "string" || url.trim() === "") return false;
    const value = url.trim();
    return !(URL.canParse(value) ? new URL(value).pathname : value).includes("/remote.php/");
}

export function serviceLabel(service: string): string {
    return SERVICES[service as ServiceType]?.label ?? service;
}

export function directWebHostNames(last: "and" | "or"): string {
    const names = fallbackServiceOrder.filter(s => SERVICES[s].web === "direct" || SERVICES[s].web === "direct-simple").map(serviceLabel);
    return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${last} ${names[names.length - 1]}`;
}

export function requiresCredentials(service: ServiceType): boolean {
    return SERVICES[service].needsAuth || SERVICES[service].privacy === "private";
}

export const needsOriginConfirmation = requiresCredentials;

export function fallsBackToPublic(service: ServiceType): boolean {
    return SERVICES[service].privacy === "public" && !SERVICES[service].confidential;
}

export function isPrivateFallbackTarget(service: ServiceType): boolean {
    return SERVICES[service].privacy === "private" && service !== ServiceType.SHAREX;
}

const MULTIPART_OVERHEAD_BYTES = 1024;

export function bodySize(file: { name: string; size: number; }, service: ServiceType): number {
    if (SERVICES[service].body === "binary") return file.size;
    return file.size + MULTIPART_OVERHEAD_BYTES + 3 * new TextEncoder().encode(file.name).length;
}

export const LEGACY_FALLBACK_ORDER: readonly ServiceType[] = [
    ServiceType.CATBOX, ServiceType.LITTERBOX, ServiceType.ZEROX0, ServiceType.TMPFILES, ServiceType.GOFILE,
    ServiceType.BUZZHEAVIER, ServiceType.TEMPSH, ServiceType.FILEBIN, ServiceType.PIXELDRAIN, ServiceType.ZIPLINE,
    ServiceType.EZHOST, ServiceType.NEST, ServiceType.ENCRYPTINGHOST, ServiceType.S3, ServiceType.PIXELVAULT,
    ServiceType.WEBDAV, ServiceType.SHAREX
];

export function normalizeLegacyFallbackOrder(configured?: string): ServiceType[] {
    const merged = new Set<ServiceType>();
    for (const entry of [...(configured || "").split(/[\n,]/).map(e => e.trim()), ...LEGACY_FALLBACK_ORDER]) {
        if (LEGACY_FALLBACK_ORDER.includes(entry as ServiceType)) merged.add(entry as ServiceType);
    }
    return [...merged];
}

export function normalizeActiveFallbacks(raw?: string): ServiceType[] {
    const active = new Set<ServiceType>();
    for (const entry of (raw ?? "").split(/[\n,]/)) {
        const s = entry.trim() as ServiceType;
        if (fallbackServiceOrder.includes(s)) active.add(s);
    }
    return [...active];
}

export const inactiveFallbacks = (active: readonly ServiceType[]) => fallbackServiceOrder.filter(s => !active.includes(s));

export const DEFAULT_ACTIVE_FALLBACKS = fallbackServiceOrder.filter(s => !requiresCredentials(s)).join(",");

export interface ShareXUploaderConfig {
    Version?: string;
    Name?: string;
    DestinationType?: string;
    RequestMethod?: string;
    RequestURL?: string;
    Headers?: Record<string, string | number | boolean>;
    Body?: string;
    FileFormName?: string;
    Arguments?: Record<string, string | number | boolean>;
    Parameters?: Record<string, string | number | boolean>;
    Data?: string;
    URL?: string;
    ThumbnailURL?: string;
    DeletionURL?: string;
    ErrorMessage?: string;
    RegexList?: string[];
}

export const logger = new Logger("BigFileUpload", "#7cb7ff");

export const listNames = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";

export const CORS_PROXY = "https://cors.keiran0.workers.dev";

export const PROXY_GUIDE_URL = "https://github.com/ScattrdBlade/bigFileUpload/blob/main/SELF-HOSTING.md";

export const PROXY_QUESTION_URL = "https://github.com/ScattrdBlade/bigFileUpload#the-cors-proxy-question";

export interface ProxyPreset {
    id: string;
    url: string;
    host: string;
    operator: string;
    source: string;
    maxBodyBytes: number | null;
    safeRedirects: boolean;
}

export const CORS_PROXY_PRESETS: readonly ProxyPreset[] = [
    { id: "default", url: CORS_PROXY, host: "cors.keiran0.workers.dev", operator: "keircn", source: "https://codeberg.org/key/corsproxy", maxBodyBytes: PROXY_MAX_BODY_BYTES, safeRedirects: false }
];

export const DEFAULT_PROXY = CORS_PROXY_PRESETS[0];

const PLACEHOLDER = "{url}";

export const isTemplateAttempt = (raw: string | undefined) => /[{}]|%7b|%7d/i.test(raw ?? "");

const stripDot = (hostname: string) => hostname.replace(/\.$/, "");

const isPresetHost = (hostname: string) => CORS_PROXY_PRESETS.some(p => p.host === stripDot(hostname.toLowerCase()));

export const PROXY_REASONS = {
    notUrl: "Not an http(s) URL yet",
    placeholder: "Write the placeholder as {url}",
    position: "{url} must come last, right after a /, with no ? or # in the address",
    userInfo: "Remove the user name and password from the address (it would be posted in video links)",
    preset: "keircn's worker supports only its root ?url= form. Choose the default",
    query: "Remove the ?query: BigFileUpload adds ?url= itself"
} as const;

export type ProxyTemplate = { prefix: string; } | { reason: string; };

export function parseProxyTemplate(raw: string | undefined): ProxyTemplate {
    const value = raw?.trim() ?? "";
    if (!value.includes(PLACEHOLDER)) return { reason: PROXY_REASONS.placeholder };
    const before = value.slice(0, -PLACEHOLDER.length);
    if (!value.endsWith("/" + PLACEHOLDER) || isTemplateAttempt(before) || /[?#]/.test(before)) return { reason: PROXY_REASONS.position };
    let u: URL;
    try {
        u = new URL(before);
    } catch {
        return { reason: PROXY_REASONS.notUrl };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { reason: PROXY_REASONS.notUrl };
    if (u.username || u.password) return { reason: PROXY_REASONS.userInfo };
    if (isPresetHost(u.hostname)) return { reason: PROXY_REASONS.preset };
    return { prefix: `${u.protocol}//${u.host}${u.pathname}` };
}

const templatePrefix = (value: string) => {
    if (!isTemplateAttempt(value)) return null;
    const t = parseProxyTemplate(value);
    return "prefix" in t ? t.prefix : null;
};

export const isProxyTemplate = (raw: string | undefined) => templatePrefix(raw ?? "") != null;

function parseQueryForm(value: string): { url: URL; path: string; } | { reason: string; } {
    const base = value.replace(/\/?\?url=$/i, "");
    let u: URL;
    try {
        u = new URL(base);
    } catch {
        return { reason: PROXY_REASONS.notUrl };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { reason: PROXY_REASONS.notUrl };
    if (u.username || u.password) return { reason: PROXY_REASONS.userInfo };
    if (/[?#]/.test(base)) return { reason: PROXY_REASONS.query };
    const path = u.pathname.replace(/\/+$/, "");
    if (isPresetHost(u.hostname) && (path || u.port)) return { reason: PROXY_REASONS.preset };
    return { url: u, path };
}

export function proxyAddressProblem(raw: string | undefined): string | null {
    const value = raw?.trim() ?? "";
    if (isTemplateAttempt(value)) {
        const t = parseProxyTemplate(value);
        return "reason" in t ? t.reason : null;
    }
    const q = parseQueryForm(value);
    return "reason" in q ? q.reason : null;
}

export function normalizeCorsProxyUrl(url?: string): string {
    const value = url?.trim() || CORS_PROXY;
    if (isTemplateAttempt(value)) return value;
    return value.replace(/\/?\?url=$/i, "").replace(/\/+$/, "");
}

export function proxyKey(url: string | undefined): string | null {
    const value = url?.trim() ?? "";
    if (!value || value === "none") return null;
    if (isTemplateAttempt(value)) {
        const prefix = templatePrefix(value);
        if (prefix == null) return null;
        const u = new URL(prefix);
        return stripDot(u.hostname) + (u.port ? `:${u.port}` : "") + u.pathname + PLACEHOLDER;
    }
    const q = parseQueryForm(value);
    if ("reason" in q) return null;
    return stripDot(q.url.hostname) + (q.url.port ? `:${q.url.port}` : "") + q.path;
}

function proxyBaseUrl(url: string | undefined): URL | null {
    if (proxyKey(url) == null) return null;
    const value = url!.trim();
    return new URL(templatePrefix(value) ?? normalizeCorsProxyUrl(value));
}

export function findProxyPreset(url: string | undefined): ProxyPreset | null {
    const k = proxyKey(url);
    if (k == null) return DEFAULT_PROXY;
    return CORS_PROXY_PRESETS.find(p => p.host === k) ?? null;
}

export const isPresetProxy = (url: string | undefined) => proxyKey(url) != null && findProxyPreset(url) != null;

export type ProxyDescription = { preset: true; host: string; operator: string; source: string; } | { preset: false; host: string; };

export function describeProxy(url: string | undefined): ProxyDescription {
    const preset = findProxyPreset(url);
    if (preset) return { preset: true, host: preset.host, operator: preset.operator, source: preset.source };
    return { preset: false, host: proxyBaseUrl(url)!.host };
}

export function proxyAddressText(url: string | undefined): string {
    const u = proxyBaseUrl(url);
    if (!u) return "";
    return u.host + (isTemplateAttempt(url) ? u.pathname : u.pathname.replace(/\/+$/, ""));
}

export function isPublicProxyUrl(url: string | undefined): boolean {
    const u = proxyBaseUrl(url);
    return u != null && u.protocol === "https:" && isProxyReachableHost(u.hostname);
}

export function proxyBodyLimit(url: string): number | null {
    const preset = findProxyPreset(url);
    if (preset) return preset.maxBodyBytes;
    const host = stripDot(proxyBaseUrl(url)!.hostname);
    return host === "workers.dev" || host.endsWith(".workers.dev") ? PROXY_MAX_BODY_BYTES : null;
}

export function isWorkersProxy(url: string): boolean {
    if (isPresetProxy(url)) return true;
    const base = proxyBaseUrl(url);
    const host = base ? stripDot(base.hostname) : "";
    return host === "workers.dev" || host.endsWith(".workers.dev");
}

export function toProxiedUrl(url: string, corsProxyUrl = CORS_PROXY): string {
    if (corsProxyUrl === "none") {
        return url;
    }
    if (isTemplateAttempt(corsProxyUrl)) {
        const prefix = templatePrefix(corsProxyUrl);
        if (prefix == null) throw new Error("The CORS proxy address is not a valid {url} template");
        const target = new URL(url);
        target.hash = "";
        return prefix + target.href;
    }
    return `${normalizeCorsProxyUrl(corsProxyUrl)}?url=${encodeURIComponent(url)}`;
}

export function isProxiedThrough(url: string, corsProxyUrl: string): boolean {
    if (proxyKey(corsProxyUrl) == null) return false;
    const lower = url.toLowerCase();
    const prefix = templatePrefix(corsProxyUrl.trim());
    if (prefix != null) return lower.startsWith(prefix.toLowerCase()) && /^https?:\/\//i.test(url.slice(prefix.length));
    const base = normalizeCorsProxyUrl(corsProxyUrl).toLowerCase();
    return lower.startsWith(`${base}?url=`) || lower.startsWith(`${base}/?url=`);
}

export const TRACKING_QUERY_KEYS: ReadonlySet<string> = new Set([
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid",
    "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "si"
]);

export interface FileTypeFilter {
    allow: ReadonlySet<string>;
    deny: ReadonlySet<string>;
}

export function parseFileTypeFilter(raw: string | undefined): FileTypeFilter | null {
    const allow = new Set<string>();
    const deny = new Set<string>();
    for (const entry of String(raw ?? "").split(/[\s,;]+/)) {
        const negated = entry.startsWith("!");
        const ext = (negated ? entry.slice(1) : entry).replace(/^\.+/, "").toLowerCase();
        if (ext) (negated ? deny : allow).add(ext);
    }
    return allow.size || deny.size ? { allow, deny } : null;
}

export function fileTypePasses(name: string, filter: FileTypeFilter | null): boolean {
    if (!filter) return true;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
    if (ext && filter.deny.has(ext)) return false;
    return filter.allow.size === 0 || filter.allow.has(ext);
}

export const MAX_SHAREX_CONFIG_BYTES = 256 * 1024;

const FILE_BODIES = new Set(["multipartformdata", "formdata", "binary"]);

const HEADER_NAME_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseDestinationTypes(destinationType?: string): string[] {
    if (!destinationType) return [];

    return destinationType
        .split(",")
        .map(type => type.trim())
        .filter(Boolean);
}

export function readShareXConfig(configText: string): ShareXUploaderConfig {
    let parsed: unknown;
    const normalizedConfigText = configText.replace(/^\uFEFF/, "").trim();

    try {
        parsed = JSON.parse(normalizedConfigText);
    } catch {
        throw new Error("Invalid ShareX JSON");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("ShareX config must be a JSON object");
    }

    const config = parsed as ShareXUploaderConfig;

    if (!config.RequestURL || typeof config.RequestURL !== "string") {
        throw new Error("ShareX RequestURL is required");
    }

    if (!isSupportedShareXDestination(config)) {
        throw new Error("ShareX DestinationType must include FileUploader or ImageUploader");
    }

    return config;
}

export function parseShareXConfig(configText: string): ShareXUploaderConfig {
    if (new TextEncoder().encode(configText).byteLength > MAX_SHAREX_CONFIG_BYTES) {
        throw new Error("ShareX config exceeds the 256 KiB size limit");
    }

    const config = readShareXConfig(configText);
    const body = String(config.Body || "MultipartFormData");
    if (!FILE_BODIES.has(body.toLowerCase())) {
        throw new Error(`The ShareX config must use a multipart or binary body (Body "${body}" doesn't send the file)`);
    }

    return config;
}

function isSupportedShareXDestination(config: ShareXUploaderConfig): boolean {
    const destinationTypes = parseDestinationTypes(config.DestinationType);

    if (destinationTypes.length === 0) {
        return true;
    }

    return destinationTypes.includes("FileUploader") || destinationTypes.includes("ImageUploader");
}

type Part = string | Call;

type Template = Part[];

interface Call {
    name: string;
    args: Template[] | null;
}

const FUNCTIONS = new Set(["response", "responseurl", "header", "json", "xml", "regex", "filename", "random", "base64", "input", "inputbox", "prompt", "outputbox", "select"]);

const DIALOG_FUNCTIONS = new Set(["input", "inputbox", "prompt", "outputbox", "select"]);

const MIN_ARGS: Record<string, number> = { header: 1, json: 1, xml: 1, regex: 1, random: 2, base64: 1, select: 1, outputbox: 1 };

function parseTemplate(text: string): Template {
    let i = 0;
    const sequence = (inArg: boolean): Template => {
        const parts: Template = [];
        let literal = "";
        while (i < text.length) {
            const c = text[i];
            if (c === "\\") {
                literal += text[i + 1] ?? "";
                i += 2;
            } else if (c === "{") {
                i++;
                if (literal) parts.push(literal);
                literal = "";
                parts.push(call());
            } else if (inArg && (c === "|" || c === "}")) {
                break;
            } else {
                literal += c;
                i++;
            }
        }
        if (literal) parts.push(literal);
        return parts;
    };
    const call = (): Call => {
        let name = "";
        while (i < text.length && !":|}".includes(text[i])) {
            if (text[i] === "{") throw new Error("a function name can't contain \"{\"");
            if (text[i] === "\\") i++;
            name += text[i++] ?? "";
        }
        let args: Template[] | null = null;
        if (text[i] === ":") {
            args = [];
            do {
                i++;
                args.push(sequence(true));
            } while (text[i] === "|");
        }
        if (i < text.length) i++;
        return { name: name.toLowerCase(), args };
    };
    return sequence(false);
}

type Syntax = "new" | "old";

function syntaxOf(config?: ShareXUploaderConfig): Syntax {
    const version = typeof config?.Version === "string" ? /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(config.Version) : null;
    if (!version) return "old";
    const [major, minor, patch] = version.slice(1).map(n => Number(n ?? 0));
    return major !== 13 ? major < 13 ? "old" : "new" : minor !== 7 ? minor < 7 ? "old" : "new" : patch <= 1 ? "old" : "new";
}

const escapeArg = (text: string) => text.replace(/[{}|\\]/g, "\\$&");

function convertLegacyToken(token: string, regexList: unknown): string | null {
    const match = /^([a-z\d]+)(?::([\s\S]*))?$/i.exec(token);
    if (!match) return null;
    const name = match[1].toLowerCase();
    const value = match[2];
    if (!FUNCTIONS.has(name)) return null;
    switch (name) {
        case "regex": {
            const ref = /^(\d+)(?:[|,]([\s\S]*))?$/.exec(value ?? "");
            if (!ref) return value === undefined ? "{regex}" : `{regex:${escapeArg(value)}}`;
            const pattern = Array.isArray(regexList) ? regexList[Number(ref[1]) - 1] : undefined;
            if (typeof pattern !== "string") throw new Error(`$regex:${value}$ refers to RegexList entry ${ref[1]}, which the config doesn't have`);
            return `{regex:${escapeArg(pattern)}${ref[2] !== undefined ? `|${escapeArg(ref[2])}` : ""}}`;
        }
        case "random":
        case "select":
            return value === undefined ? `{${name}}` : `{${name}:${value.split("|").map(escapeArg).join("|")}}`;
        case "prompt":
            return "{inputbox}";
        case "json":
        case "xml":
        case "header":
        case "base64":
        case "outputbox":
            return value === undefined ? `{${name}}` : `{${name}:${escapeArg(value)}}`;
        default:
            return `{${name}}`;
    }
}

function newTokenEnd(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) return i + 1;
    }
    return text.length;
}

function toNewSyntax(text: string, syntax: Syntax, regexList: unknown): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === "\\" && syntax === "new") {
            out += text.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (c === "\\" && (text[i + 1] === "$" || text[i + 1] === "\\")) {
            out += escapeArg(text[i + 1]);
            i += 2;
            continue;
        }
        if (c === "$") {
            let end = i + 1;
            while (end < text.length && text[end] !== "$") end += text[end] === "\\" && (text[end + 1] === "$" || text[end + 1] === "\\") ? 2 : 1;
            const converted = end < text.length ? convertLegacyToken(text.slice(i + 1, end).replace(/\\([$\\])/g, "$1"), regexList) : null;
            if (converted !== null) {
                out += converted;
                i = end + 1;
                continue;
            }
        }
        if (c === "{" && syntax === "old") {
            const name = /^\{([a-z\d]+)[:}|]/i.exec(text.slice(i, i + 14))?.[1].toLowerCase();
            if (name && FUNCTIONS.has(name)) {
                const end = newTokenEnd(text, i);
                out += text.slice(i, end);
                i = end;
                continue;
            }
        }
        out += syntax === "new" ? c : escapeArg(c);
        i++;
    }
    return out;
}

function compileField(raw: unknown, field: string, config?: ShareXUploaderConfig): Template {
    const text = raw == null ? "" : String(raw);
    if (!/[{$\\]/.test(text)) return text ? [text] : [];
    const syntax = syntaxOf(config);
    try {
        return parseTemplate(toNewSyntax(text, syntax, config?.RegexList));
    } catch (error) {
        throw new Error(`ShareX ${field}: ${(error as Error).message}`);
    }
}

export interface ShareXAnswer {
    text: string;
    json?: unknown;
    url?: string;
    headers?: { get(name: string): string | null; };
}

interface Context {
    field: string;
    filename: string;
    urlEncode: boolean;
    answer: ShareXAnswer | null;
}

const REGEX_INPUT_MAX = 256 * 1024;

const REGEX_PATTERN_MAX = 1000;

function regexProblem(pattern: string): string | null {
    return pattern.length > REGEX_PATTERN_MAX ? `whose pattern is longer than ${REGEX_PATTERN_MAX} characters` : null;
}

function matchInWorker(input: string, pattern: string, group: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        let worker: Worker | undefined;
        let url: string | undefined;
        let settled = false;
        const finish = (error: string | null, value: string | null = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker?.terminate();
            if (url) URL.revokeObjectURL(url);
            if (error) reject(new Error(error));
            else resolve(value);
        };
        const timer = setTimeout(() => finish("ShareX regex exceeded its one-second limit"), 1000);
        try {
            url = URL.createObjectURL(new Blob([`
                onmessage = ({ data: { input, pattern, group } }) => {
                    try {
                        const options = /^\\(\\?([ims]+)\\)/.exec(pattern);
                        const regex = new RegExp(options ? pattern.slice(options[0].length) : pattern, options ? [...new Set(options[1])].join("") : "");
                        const match = regex.exec(input);
                        const value = !match ? null : !group ? match[0] : /^\\d+$/.test(group) ? match[Number(group)] ?? "" : match.groups?.[group] ?? "";
                        postMessage({ value });
                    } catch {
                        postMessage({ error: "ShareX regex couldn't be evaluated" });
                    }
                };
            `], { type: "text/javascript" }));
            worker = new Worker(url);
            worker.onmessage = ({ data }) => finish(data.error ?? null, data.value);
            worker.onerror = event => {
                event.preventDefault();
                finish("ShareX regex worker failed. Check that this client allows blob workers");
            };
            worker.onmessageerror = () => finish("ShareX regex worker returned an unreadable result");
            worker.postMessage({ input: input.slice(0, REGEX_INPUT_MAX), pattern, group });
        } catch {
            finish("ShareX regex needs a worker, but this client couldn't start one");
        }
    });
}

function toRegExp(pattern: string): RegExp {
    const options = /^\(\?([ims]+)\)/.exec(pattern);
    return new RegExp(options ? pattern.slice(options[0].length) : pattern, options ? [...new Set(options[1])].join("") : "");
}

function parseJsonPath(raw: string): (string | number)[] | null {
    let path = raw.trim();
    if (path === "$") return [];
    if (path.startsWith("$.")) path = path.slice(2);
    else if (path.startsWith("$[")) path = path.slice(1);
    const keys: (string | number)[] = [];
    let i = 0;
    while (i < path.length) {
        const rest = path.slice(i);
        const bracket = /^\[\s*(?:(\d+)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\s*\]/.exec(rest);
        const name = bracket ? null : /^[^.[\]]+/.exec(rest);
        if (bracket) keys.push(bracket[1] !== undefined ? Number(bracket[1]) : (bracket[2] ?? bracket[3]).replace(/\\(.)/g, "$1"));
        else if (name && name[0].trim() !== "*") keys.push(name[0]);
        else return null;
        i += (bracket ?? name)![0].length;
        if (path[i] === ".") {
            i++;
            if (i >= path.length || path[i] === "." || path[i] === "[") return null;
        }
    }
    return keys;
}

function readJson(data: unknown, keys: (string | number)[]): string | null {
    let current = data;
    for (const key of keys) {
        if (current === null || typeof current !== "object") return null;
        if (Array.isArray(current)) {
            const index = typeof key === "number" ? key : /^\d+$/.test(key) ? Number(key) : -1;
            current = current[index];
        } else {
            if (!Object.prototype.hasOwnProperty.call(current, key)) return null;
            current = (current as Record<string, unknown>)[key];
        }
    }
    return typeof current === "string" ? current : typeof current === "number" || typeof current === "boolean" ? String(current) : null;
}

function readXml(input: string, xpath: string): string | null {
    const doc = new DOMParser().parseFromString(input, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    let node: Node | null;
    try {
        node = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch {
        throw new Error(`"{xml}" has an invalid XPath (${xpath})`);
    }
    return node?.textContent ?? null;
}

function toBase64(text: string): string {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function parseJsonText(text: string): unknown {
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

const readsAnswer = (name: string, argCount: number) =>
    name === "response" || name === "responseurl" || name === "header"
    || ((name === "json" || name === "xml") && argCount < 2) || (name === "regex" && argCount < 3);

function callFunction({ name, args: rawArgs }: Call, ctx: Context): string | null {
    const args = rawArgs?.map(arg => evaluate(arg, ctx)) ?? [];
    if (!FUNCTIONS.has(name) || DIALOG_FUNCTIONS.has(name)) throw new Error(`ShareX ${ctx.field} uses "{${name}}", which isn't supported here`);
    if (args.length < (MIN_ARGS[name] ?? 0)) throw new Error(`ShareX ${ctx.field}: "{${name}}" needs at least ${MIN_ARGS[name]} argument${MIN_ARGS[name] > 1 ? "s" : ""}`);
    const { answer } = ctx;
    if (readsAnswer(name, args.length) && !answer) throw new Error(`ShareX ${ctx.field} uses "{${name}}", which reads the host's answer`);
    switch (name) {
        case "response": return answer!.text;
        case "responseurl": return answer!.url ?? null;
        case "header":
            try {
                return args[0] ? answer!.headers?.get(args[0]) ?? null : null;
            } catch {
                return null;
            }
        case "json": {
            const [data, path] = args.length > 1 ? [parseJsonText(args[0]), args[1]] : [answer!.json !== undefined ? answer!.json : parseJsonText(answer!.text), args[0]];
            const keys = path ? parseJsonPath(path) : null;
            return keys ? readJson(data, keys) : null;
        }
        case "xml": {
            const [input, xpath] = args.length > 1 ? args : [answer!.text, args[0]];
            return input && xpath ? readXml(input, xpath) : null;
        }
        case "regex": return "preview";
        case "filename": return ctx.urlEncode ? encodeURIComponent(ctx.filename) : ctx.filename;
        case "random": return args[Math.floor(Math.random() * args.length)];
        case "base64": return args[0] ? toBase64(args[0]) : null;
    }
    return null;
}

function evaluate(template: Template, ctx: Context): string {
    let out = "";
    for (const part of template) out += typeof part === "string" ? part : callFunction(part, ctx) ?? "";
    return out;
}

async function evaluateAsync(template: Template, ctx: Context, deadline = Date.now() + 5000): Promise<string> {
    let out = "";
    for (const part of template) {
        if (Date.now() >= deadline) throw new Error(`ShareX ${ctx.field} exceeded its five-second evaluation limit`);
        if (typeof part === "string") {
            out += part;
            continue;
        }
        const args: string[] = [];
        for (const arg of part.args ?? []) args.push(await evaluateAsync(arg, ctx, deadline));
        if (part.name === "regex") {
            if (!ctx.answer && args.length < 3) throw new Error(`ShareX ${ctx.field}: "{regex}" reads the host's answer`);
            const [input, pattern, group] = args.length > 2 ? args : [ctx.answer!.text, args[0], args[1]];
            const problem = pattern ? regexProblem(pattern) : null;
            if (problem) throw new Error(`ShareX ${ctx.field} uses "{regex}", ${problem}`);
            out += input && pattern ? await matchInWorker(input, pattern, group) ?? "" : "";
        } else {
            out += callFunction({ ...part, args: args.map(arg => [arg]) }, ctx) ?? "";
        }
    }
    return out;
}

type Side = "address" | "request" | "answer";

const literalOf = (arg?: Template) => arg?.every(part => typeof part === "string") ? arg.join("") : null;

function checkTemplate(template: Template, field: string, side: Side): void {
    for (const part of template) {
        if (typeof part === "string") continue;
        const { name, args } = part;
        const fail = (why: string): never => {
            throw new Error(`ShareX ${field} uses "{${name}}", ${why}`);
        };
        const count = args?.length ?? 0;
        if (!FUNCTIONS.has(name)) fail("which isn't a ShareX function");
        if (DIALOG_FUNCTIONS.has(name)) fail("which needs one of ShareX's own windows and isn't supported here");
        if (count < (MIN_ARGS[name] ?? 0)) fail(`which needs at least ${MIN_ARGS[name]} argument${MIN_ARGS[name] > 1 ? "s" : ""}`);
        if (side !== "answer" && readsAnswer(name, count)) fail("which reads the host's answer: only URL, DeletionURL and ErrorMessage can use it");
        if (side === "address" && name === "random") fail("which would change the upload address between uploads");
        args?.forEach(arg => checkTemplate(arg, field, side));
        if (name === "regex") {
            const pattern = literalOf(args![count > 2 ? 1 : 0]);
            const problem = pattern ? regexProblem(pattern) : null;
            if (problem) fail(problem);
            try {
                if (pattern) toRegExp(pattern);
            } catch (error) {
                fail(`whose pattern is invalid (${(error as Error).message})`);
            }
        } else if (name === "json") {
            const path = literalOf(args![count > 1 ? 1 : 0]);
            if (path?.trim() && !parseJsonPath(path)) fail(`whose path "${path}" isn't supported (use names, [0] and ['key'])`);
        } else if (name === "xml" && typeof document !== "undefined") {
            const xpath = literalOf(args![count > 1 ? 1 : 0]);
            try {
                if (xpath) document.createExpression(xpath);
            } catch {
                fail(`whose XPath "${xpath}" is invalid`);
            }
        }
    }
}

function checkAddressPrefix(template: Template, field: string): void {
    let literal = "";
    for (const part of template) {
        if (typeof part === "string") literal += part;
        else if (!/^[^:/?#]*:\/\/[^/?#]*[/?#]/.test(literal)) throw new Error(`ShareX ${field} uses "{${part.name}}" before its path, which would change the upload address between uploads`);
        else return;
    }
}

export interface RequestValueOptions {
    config?: ShareXUploaderConfig;
    urlEncode?: boolean;
    field?: string;
}

export function previewShareXRequestValue(value: string | number | boolean, filename: string, { config, urlEncode = false, field = "value" }: RequestValueOptions = {}): string {
    return evaluate(compileField(value, field, config), { field, filename, urlEncode, answer: null });
}

export async function resolveShareXRequestValue(value: string | number | boolean, filename: string, { config, urlEncode = false, field = "value" }: RequestValueOptions = {}): Promise<string> {
    return evaluateAsync(compileField(value, field, config), { field, filename, urlEncode, answer: null });
}

// fetch, XHR and Node accept only Latin-1 header values
function encodeHeaderValue(value: string): string {
    return value.replace(/[\r\n]/g, "").replace(/[^\x00-\xff]+/g, run => {
        try {
            return encodeURIComponent(run);
        } catch {
            return "_";
        }
    });
}

function checkedShareXHeader(key: string, raw: string): string {
    if (!HEADER_NAME_REGEX.test(key)) throw new Error(`ShareX header "${key}" has an invalid name`);
    const value = encodeHeaderValue(raw);
    try {
        if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error();
        new Headers().set(key, value);
    } catch {
        throw new Error(`ShareX header "${key}" has an invalid value`);
    }
    return value;
}

export async function buildShareXHeaders(config: ShareXUploaderConfig, filename: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(config.Headers || {})) {
        headers[key] = checkedShareXHeader(key, await resolveShareXRequestValue(raw, filename, { config, field: `Headers.${key}` }));
    }
    return headers;
}

const requestFields = (config: ShareXUploaderConfig) => (["Headers", "Arguments", "Parameters"] as const).flatMap(field =>
    Object.entries(config[field] || {}).map(([key, value]): [string, unknown] => [`${field}.${key}`, value]));

export function validateShareXConfig(config: ShareXUploaderConfig): void {
    const fields: [string, unknown, Side][] = [
        ["RequestURL", config.RequestURL, "address"],
        ["URL", config.URL, "answer"],
        ...requestFields(config).map(([field, value]): [string, unknown, Side] => [field, value, "request"])
    ];
    for (const [field, value, side] of fields) {
        const template = compileField(value, field, config);
        checkTemplate(template, field, side);
        if (side === "address") checkAddressPrefix(template, field);
    }
    for (const [key, raw] of Object.entries(config.Headers ?? {})) {
        checkedShareXHeader(key, previewShareXRequestValue(raw, "upload.png", { config, field: `Headers.${key}` }));
    }
}

interface AnswerOptions {
    config?: ShareXUploaderConfig;
    url?: string;
    headers?: ShareXAnswer["headers"];
    filename?: string;
    field?: string;
}

export async function resolveShareXTemplate(
    template: string | undefined,
    responseText: string,
    responseJson: unknown,
    { config, url, headers, filename = "", field = "URL" }: AnswerOptions = {}
): Promise<string | undefined> {
    if (!template) return undefined;

    const output = template.trim();
    if (!output) return undefined;

    return evaluateAsync(compileField(output, field, config), { field, filename, urlEncode: true, answer: { text: responseText, json: responseJson, url, headers } });
}

export function shareXSecretParts(config: ShareXUploaderConfig, skipHeader: (name: string) => boolean = () => false): string[] {
    const found: string[] = [];
    const visit = (call: Call, encoded: boolean) => {
        const inner = encoded || call.name === "base64";
        for (const arg of call.args ?? []) {
            for (const part of arg) {
                if (typeof part !== "string") visit(part, inner);
                else if (inner) found.push(part);
            }
        }
        if (call.name === "base64" && call.args?.[0] && literalOf(call.args[0])) found.push(toBase64(literalOf(call.args[0])!));
    };
    const varies = (template: Template): boolean => template.some(part => typeof part !== "string"
        && (part.name === "filename" || part.name === "random" || part.name === "regex" || (part.args ?? []).some(varies)));
    for (const [field, value] of requestFields(config)) {
        if (field.startsWith("Headers.") && skipHeader(field.slice(8))) continue;
        try {
            const template = compileField(value, field, config);
            if (template.every(part => typeof part === "string")) continue;
            for (const part of template) {
                if (typeof part !== "string") visit(part, false);
                else found.push(/^\S+\s+(\S+)$/.exec(part.trim())?.[1] ?? "");
            }
            if (!varies(template)) found.push(evaluate(template, { field, filename: "", urlEncode: false, answer: null }));
        } catch { }
    }
    return found.map(part => part.trim()).filter(part => part && /[a-z0-9]/i.test(part) && !/^https?:\/\//i.test(part)
        && !/^(?:basic|bearer|digest|token|bot)$/i.test(part));
}

export type CredentialValues = Readonly<Record<string, unknown>>;

export const isFilled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export const PIXELDRAIN_KEY_REQUIRED = "PixelDrain API key required (PixelDrain doesn't accept anonymous uploads)";

export function parseEncryptingHostDomains(raw: string): string[] {
    const invalid = "Encrypting.host domains must be a JSON array of strings, such as [\"normal\"]";
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(invalid);
    }

    if (!Array.isArray(parsed) || parsed.some(domain => typeof domain !== "string")) {
        throw new Error(invalid);
    }

    return parsed.map(domain => domain.trim());
}

const S3_KEYS = ["s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId", "s3SecretAccessKey"];

export function legacyConfigured(service: ServiceType, values: CredentialValues): boolean {
    const filled = (...keys: string[]) => keys.every(k => isFilled(values[k]));
    switch (service) {
        case ServiceType.ZIPLINE: return filled("serviceUrl", "ziplineToken");
        case ServiceType.NEST: return filled("nestToken");
        case ServiceType.EZHOST: return filled("ezHostKey");
        case ServiceType.ENCRYPTINGHOST: return filled("encryptingHostKey");
        case ServiceType.PIXELVAULT: return filled("pixelVaultKey");
        case ServiceType.PIXELDRAIN: return filled("pixelDrainKey");
        case ServiceType.S3: return filled(...S3_KEYS);
        case ServiceType.WEBDAV: return filled("webdavUrl");
        case ServiceType.SHAREX:
            if (!filled("sharexConfig")) return false;
            try {
                readShareXConfig(values.sharexConfig as string);
                return true;
            } catch {
                return false;
            }
        default: return true;
    }
}

export function credentialProblems(service: ServiceType, values: CredentialValues): string[] {
    const filled = (...keys: string[]) => keys.every(k => isFilled(values[k]));
    const need = (ok: boolean, message: string) => ok ? [] : [message];
    switch (service) {
        case ServiceType.ZIPLINE: return need(filled("serviceUrl", "ziplineToken"), "Zipline service URL and token required");
        case ServiceType.NEST: return need(filled("nestToken"), "Nest API token required");
        case ServiceType.EZHOST: return need(filled("ezHostKey"), "E-Z Host API key required");
        case ServiceType.PIXELVAULT: return need(filled("pixelVaultKey"), "PixelVault upload key required");
        case ServiceType.PIXELDRAIN: return need(filled("pixelDrainKey"), PIXELDRAIN_KEY_REQUIRED);
        case ServiceType.WEBDAV: return need(filled("webdavUrl"), "WebDAV server URL required");
        case ServiceType.ENCRYPTINGHOST: {
            const problems = need(filled("encryptingHostKey"), "Encrypting.host API key required");
            const domains = values.encryptingHostDomains;
            if (isFilled(domains)) {
                try {
                    parseEncryptingHostDomains(domains.trim());
                } catch (error) {
                    problems.push((error as Error).message);
                }
            }
            return problems;
        }
        case ServiceType.S3:
            if (!filled(...S3_KEYS)) return ["S3 endpoint, bucket, and access keys required"];
            return need(!isR2Endpoint(values.s3Endpoint) || filled("s3PublicUrl"), "R2 needs a Public Base URL (r2.dev or a custom domain) before it is used");
        case ServiceType.SHAREX:
            if (!filled("sharexConfig")) return ["ShareX config is required"];
            try {
                validateShareXConfig(parseShareXConfig(values.sharexConfig as string));
                return [];
            } catch (error) {
                return [error instanceof Error ? error.message : "Invalid ShareX config"];
            }
        default: return [];
    }
}

function parsedUrl(raw: unknown): URL | null {
    return isFilled(raw) && URL.canParse(raw.trim()) ? new URL(raw.trim()) : null;
}

function keyedUrl(raw: unknown): boolean {
    const u = parsedUrl(raw);
    return u !== null && (u.username !== "" || u.password !== "" || hasSecretQuery(u));
}

const filledEntries = (record: unknown) => record != null && typeof record === "object"
    && Object.values(record).some(v => v != null && String(v).trim() !== "");

export function hasConfiguredCredential(service: ServiceType, values: CredentialValues): boolean {
    const any = (...keys: string[]) => keys.some(k => isFilled(values[k]));
    switch (service) {
        case ServiceType.ZIPLINE: return any("ziplineToken") || keyedUrl(values.serviceUrl);
        case ServiceType.NEST: return any("nestToken");
        case ServiceType.EZHOST: return any("ezHostKey");
        case ServiceType.ENCRYPTINGHOST: return any("encryptingHostKey");
        case ServiceType.PIXELVAULT: return any("pixelVaultKey");
        case ServiceType.PIXELDRAIN: return any("pixelDrainKey");
        case ServiceType.CATBOX: return any("catboxUserhash");
        case ServiceType.GOFILE: return any("gofileToken") || (values.gofileReuseGuestToken !== false && values.gofileSyncGuestToken === true && any("gofileGuestToken"));
        case ServiceType.S3: return any("s3AccessKeyId", "s3SecretAccessKey", "s3SessionToken") || keyedUrl(values.s3Endpoint);
        case ServiceType.WEBDAV: return any("webdavUsername", "webdavPassword") || keyedUrl(values.webdavUrl);
        case ServiceType.SHAREX: {
            if (!isFilled(values.sharexConfig)) return false;
            try {
                const config = readShareXConfig(values.sharexConfig);
                const u = parsedUrl(config.RequestURL);
                return filledEntries(config.Headers) || filledEntries(config.Arguments) || filledEntries(config.Parameters)
                    || (u !== null && (u.username !== "" || u.password !== "" || u.search !== ""));
            } catch {
                return false;
            }
        }
        default: return false;
    }
}

function endpointHost(raw: unknown): string | undefined {
    if (!isFilled(raw)) return undefined;
    try {
        return new URL(raw.trim()).host || undefined;
    } catch {
        return undefined;
    }
}

export function describeKeptHost(service: ServiceType, values: CredentialValues): string {
    let host: string | undefined;
    switch (service) {
        case ServiceType.ZIPLINE: host = endpointHost(values.serviceUrl); break;
        case ServiceType.S3: host = endpointHost(values.s3Endpoint); break;
        case ServiceType.WEBDAV: host = endpointHost(values.webdavUrl); break;
        case ServiceType.SHAREX:
            try {
                host = endpointHost(readShareXConfig(values.sharexConfig as string).RequestURL);
            } catch { }
            break;
    }
    const problems = credentialProblems(service, values);
    const details = [host, problems.length ? `skipped until fixed: ${problems.join("; ")}` : undefined].filter(Boolean);
    return details.length ? `${serviceLabel(service)} (${details.join("; ")})` : serviceLabel(service);
}
