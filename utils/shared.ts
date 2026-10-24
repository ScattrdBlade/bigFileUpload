/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type FailureKind = "blocked" | "unreachable" | "host-closed" | "host-tls" | "local" | "cancelled" | "stalled" | "unknown";

export interface UploadFailure {
    stage: "connect" | "body" | "response";
    code?: string;
    stageReliable: boolean;
    kind?: FailureKind;
    addresses?: string[];
}

export const PROXY_RETRY_KINDS: ReadonlySet<FailureKind> = new Set(["blocked", "unreachable"]);

export class UploadAbortError extends Error {
    constructor(readonly reason: "user" | "stalled") {
        super(reason === "user" ? "Upload cancelled by user" : "No upload progress, so the request was stopped");
        this.name = "UploadAbortError";
    }
}

const PRE_HANDSHAKE_CODES: ReadonlySet<string> = new Set([
    "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA", "ENODATA", "ESERVFAIL", "EREFUSED",
    "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"
]);

const NOT_TRANSIENT_CODES: ReadonlySet<string> = new Set([
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CRL_HAS_EXPIRED", "CERT_REVOKED",
    "UND_ERR_INVALID_ARG", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_CHAR", "ERR_INVALID_URL"
]);

export function failedBeforeSending(f: UploadFailure): boolean {
    if (!f.code || NOT_TRANSIENT_CODES.has(f.code)) return false;
    return f.stage === "connect" && (f.stageReliable || PRE_HANDSHAKE_CODES.has(f.code));
}

export type NativeErrorCode = "cancelled" | "stalled" | "network" | "tls" | "http" | "local";

export const RESPONSE_GRACE_MS = 5 * 60 * 1000;

type ErrorLike = { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; } | null | undefined;

export function firstErrorCode(error: unknown): string | undefined {
    const queue = [error];
    for (let i = 0; i < 8 && queue.length; i++) {
        const e = queue.shift() as ErrorLike;
        if (!e || typeof e !== "object") continue;
        if (typeof e.code === "string") return e.code;
        if (e.cause) queue.push(e.cause);
        if (Array.isArray(e.errors)) queue.push(...e.errors);
    }
    return undefined;
}

const DNS_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA", "ENODATA", "ESERVFAIL", "EREFUSED"]);

const CLOSED_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

const EXPIRED_CERT_CODES: ReadonlySet<string> = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CRL_HAS_EXPIRED"]);

const isTlsCode = (code: string) => /^(?:ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|CRL_)/.test(code)
    || ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "HOSTNAME_MISMATCH", "EPROTO"].includes(code);

function errorChainText(error: unknown): string {
    const texts: string[] = [];
    const add = (e: ErrorLike) => {
        if (!e || typeof e !== "object") return;
        let text = typeof e.message === "string" ? e.message.trim() : "";
        if (!text && Array.isArray(e.errors)) {
            text = e.errors.slice(0, 2).map(inner => typeof (inner as ErrorLike)?.message === "string" ? String((inner as { message: string; }).message) : "").filter(Boolean).join("; ");
        }
        text = text.slice(0, 300);
        const code = typeof e.code === "string" ? e.code : "";
        const tagged = (t: string) => code && !t.includes(code) ? `${t} (${code})` : t;
        if (text && texts.some(t => t.includes(text))) {
            if (code && !texts.some(t => t.includes(code))) texts[texts.length - 1] = tagged(texts[texts.length - 1]);
            return;
        }
        if (text || code) texts.push(text ? tagged(text) : code);
    };
    let e = error as ErrorLike;
    for (let level = 0; level < 3 && e && typeof e === "object"; level++) {
        add(e);
        e = e.cause as ErrorLike;
    }
    return texts.join(": ") || "Unknown error";
}

function networkHint(code: string | undefined, stage: UploadFailure["stage"] | undefined): string | null {
    if (!code) return null;
    if (DNS_CODES.has(code)) return "DNS lookup failed (your network may block this host)";
    if (CLOSED_CODES.has(code)) {
        if (stage === "body") return "The host closed the connection mid-upload (possibly a size limit)";
        if (stage === "response") return "The host closed the connection before answering";
        if (stage === "connect") return "The connection was closed before anything was sent (your network may block this host)";
        return "The host closed the connection";
    }
    if (code === "ECONNREFUSED") return "The host refused the connection";
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "Couldn't connect to the host in time";
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "The host stopped answering";
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENETDOWN" || code === "EADDRNOTAVAIL") return "The host's network is unreachable from here";
    if (EXPIRED_CERT_CODES.has(code) || code === "CERT_REVOKED") return "The host's certificate is expired, revoked or not valid yet";
    if (code === "EPROTO" || code.startsWith("ERR_SSL_")) return "The secure connection failed (something other than the host may be answering)";
    if (isTlsCode(code)) return "The host's certificate isn't trusted (a proxy, antivirus or network filter may be intercepting HTTPS)";
    return null;
}

export const isDnsCode = (code: string | undefined) => code !== undefined && DNS_CODES.has(code);

const BLOCKED_CODES: ReadonlySet<string> = new Set([...DNS_CODES, "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"].filter(c => c !== "EAI_AGAIN"));

const INTERCEPTION_CERT_CODES: ReadonlySet<string> = new Set([
    "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED", "CERT_SIGNATURE_FAILURE", "CERT_REJECTED", "HOSTNAME_MISMATCH"
]);

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "UND_ERR_SOCKET", "ECONNABORTED", "EPIPE", "ENETDOWN"]);

const HOST_TLS_CODES: ReadonlySet<string> = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CRL_HAS_EXPIRED", "CERT_REVOKED"]);

const LOCAL_CODES: ReadonlySet<string> = new Set(["UND_ERR_INVALID_ARG", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_CHAR", "ERR_INVALID_URL"]);

export function classifyFetchError(error: unknown, stage: UploadFailure["stage"], stageReliable: boolean, abort?: UploadAbortError["reason"]): FailureKind {
    if (abort === "user") return "cancelled";
    if (abort === "stalled") return stage === "connect" && stageReliable ? "unreachable" : "stalled";
    if (stage !== "connect") return "host-closed";
    const code = firstErrorCode(error);
    if (!code) return error instanceof RangeError || (error instanceof TypeError && !(error as { cause?: unknown; }).cause) ? "local" : "unknown";
    if (LOCAL_CODES.has(code)) return "local";
    if (HOST_TLS_CODES.has(code)) return "host-tls";
    if (BLOCKED_CODES.has(code) || INTERCEPTION_CERT_CODES.has(code)) return "blocked";
    if (code === "EPROTO" || code.startsWith("ERR_SSL_")) return stageReliable ? "blocked" : "unknown";
    if (UNREACHABLE_CODES.has(code)) return stageReliable || code === "EAI_AGAIN" ? "unreachable" : "unknown";
    return "unknown";
}

const FILTER_VENDORS = /fortiguard|fortinet|sophos|zscaler|umbrella|opendns|palo ?alto|netsweeper|lightspeed|goguardian|securly|iboss|barracuda|forcepoint|smoothwall|blue ?coat|pi-hole|adguard|nextdns|cisco|websense|untangle|cyberoam/i;

const htmlTitle = (body: string) => /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? "";

export function classifyHttpBlock(status: number, header: (name: string) => string | null | undefined, bodyHead: string): boolean {
    if (status === 451) return true;
    if (status !== 403 || !/^\s*text\/html/i.test(header("content-type") ?? "")) return false;
    if (header("cf-mitigated")) return true;
    const title = htmlTitle(bodyHead);
    if (header("cf-ray") && (/attention required|access denied|just a moment/i.test(title)
        || /sorry, you have been blocked|error code: (?:100[5-9]|101[0-2]|1020)\b/i.test(bodyHead))) return true;
    if (/akamaighost/i.test(header("server") ?? "") && /access denied/i.test(title)) return true;
    return /block|filter|denied|restricted|prohibited|not allowed/i.test(title) && FILTER_VENDORS.test(bodyHead);
}

export function proxyCouldNotReach(status: number, body: string): boolean {
    if (status >= 520 && status <= 530) return true;
    return status >= 500 && (/\|\s*cloudflare\s*$/i.test(htmlTitle(body)) || /error code: 1\d{3}\b/i.test(body));
}

export function describeNetworkError(error: unknown, stage?: UploadFailure["stage"]): { code: NativeErrorCode; error: string; } {
    const errno = firstErrorCode(error);
    const chain = errorChainText(error);
    const hint = networkHint(errno, stage);
    const code: NativeErrorCode = !errno ? "local" : isTlsCode(errno) ? "tls" : "network";
    return { code, error: hint ? `${hint}: ${chain}` : chain };
}

export const PROXY_MAX_BODY_BYTES = 99_000_000;

export function isDiscordMediaHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return ["discord.com", "discordapp.com", "discordapp.net"].some(d => host === d || host.endsWith("." + d));
}

function ipv4Octets(host: string): number[] | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    const octets = m?.slice(1).map(Number);
    return octets && octets.every(o => o <= 255) ? octets : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function ipv6Groups(host: string): number[] | null {
    let text = host.toLowerCase();
    const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (v4) {
        const o = ipv4Octets(v4[1]);
        if (!o) return null;
        text = text.slice(0, -v4[1].length) + `${(o[0] << 8 | o[1]).toString(16)}:${(o[2] << 8 | o[3]).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const parse = (s: string) => s ? s.split(":").map(g => /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN) : [];
    const head = parse(halves[0]), tail = halves.length === 2 ? parse(halves[1]) : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = [...head, ...Array(Math.max(0, fill)).fill(0), ...tail];
    return groups.length === 8 && groups.every(g => Number.isInteger(g)) && fill >= 0 ? groups : null;
}

export function isPrivateAddress(address: string): boolean {
    const host = address.replace(/^\[|\]$/g, "");
    const v4 = ipv4Octets(host);
    if (v4) return isPrivateIpv4(v4);
    const g = ipv6Groups(host);
    if (!g) return false;
    if (g.slice(0, 7).every(x => x === 0) && g[7] <= 1) return true;
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
}

export function isPublicSourceAddress(address: string): boolean {
    const host = address.replace(/^\[|\]$/g, "");
    const v4 = ipv4Octets(host);
    if (v4) return !isPrivateIpv4(v4) && v4[0] < 224;
    const g = ipv6Groups(host);
    if (!g) return false;
    const wrapped = (hi: number, lo: number) => isPublicSourceAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return wrapped(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return wrapped(g[6], g[7]);
    if ((g[0] & 0xe000) !== 0x2000) return false;
    return g[0] !== 0x2002 || wrapped(g[1], g[2]);
}

const LAN_NAME_SUFFIXES = ["localhost", "local", "lan", "home.arpa", "internal"];

export function httpHostKind(hostname: string): "private" | "lan-name" | "public" {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    if (host.startsWith("[") || ipv4Octets(host)) return isPrivateAddress(host) ? "private" : "public";
    if (!host.includes(".")) return host ? "lan-name" : "public";
    return LAN_NAME_SUFFIXES.some(s => host === s || host.endsWith("." + s)) ? "lan-name" : "public";
}

export function httpLanOnlyText(host: string, resolvedPublic: boolean, optIn = true): string {
    const why = resolvedPublic ? `${host} resolves to a public address` : `${host} isn't one`;
    return `http is only allowed for LAN hosts (${why})${optIn ? ". \"Allow Insecure HTTP\" in the host's settings allows it on this device" : ""}`;
}

const LOCAL_SUFFIXES = ["localhost", "local", "lan", "home.arpa", "internal", "ts.net", "nip.io", "sslip.io", "localtest.me"];

export function isProxyReachableHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    if (host.startsWith("[") || ipv4Octets(host)) return !isPrivateAddress(host);
    if (!host.includes(".")) return false;
    return !LOCAL_SUFFIXES.some(s => host === s || host.endsWith("." + s));
}

export const CREDENTIAL_QUERY_KEYS: ReadonlySet<string> = new Set([
    "key", "token", "access_token", "apikey", "api_key", "auth", "sig", "signature", "password", "pass", "pw", "secret",
    "session", "jwt", "expires", "policy", "key-pair-id", "hmac"
]);

export function isCredentialQueryKey(key: string): boolean {
    const k = key.toLowerCase();
    return CREDENTIAL_QUERY_KEYS.has(k) || k.startsWith("x-amz-") || k.startsWith("x-goog-");
}

export function hasSecretQuery(u: URL): boolean {
    for (const key of u.searchParams.keys()) if (isCredentialQueryKey(key)) return true;
    return false;
}

export function proxySourceAllowed(u: URL): boolean {
    return !isDiscordMediaHost(u.hostname) && isProxyReachableHost(u.hostname) && !hasSecretQuery(u) && !u.username && !u.password;
}

export const SPOOL_MIN_BYTES = 4 * 1024 * 1024;

export const SPOOL_SLICE_BYTES = 8 * 1024 * 1024;

export const SPOOL_MAX_BYTES = 8 * 1024 * 1024 * 1024;

export const NATIVE_MAX_BUFFER = 1900 * 1024 * 1024;

export const SPOOL_HEAD_BYTES = 4096;

export interface SpoolSource {
    kind: "spool";
    id: string;
    offset?: number;
    length?: number;
}

export interface SpooledFile {
    readonly kind: "spool";
    readonly id: string;
    readonly size: number;
    readonly type: string;
    readonly head: Blob;
    readonly sha256: string;
}

export type UploadBody = Blob | SpooledFile;

export interface SpoolPart {
    readonly kind: "spool-part";
    readonly id: string;
    readonly offset: number;
    readonly size: number;
    readonly type: string;
}

export type RequestBody = UploadBody | SpoolPart;

export const isSpooled = (body: RequestBody): body is SpooledFile => !(body instanceof Blob) && body.kind === "spool";

export const isSpoolPart = (body: RequestBody): body is SpoolPart => !(body instanceof Blob) && body.kind === "spool-part";

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export function randomHexBytes(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}
