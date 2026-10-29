/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { copyToClipboard } from "@utils/clipboard";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { PluginNative } from "@utils/types";
import { chooseFile } from "@utils/web";
import { ChannelSectionStore, ChannelStore, DraftType, MessageActions, PermissionsBits, PermissionStore, SelectedChannelStore, showToast, UserStore } from "@webpack/common";

import { ensureMigrated, getStripQueryMode, settings, withDeclaredDefaults } from "../settings";
import { bodySize, buildShareXHeaders, credentialProblems, CredentialValues, DEFAULT_ACTIVE_FALLBACKS, describeProxy, directWebHostNames, fallbackServiceOrder, fallsBackToPublic, fileTypePasses, findProxyPreset, hasConfiguredCredential, isGenericWebdav, isPrivateFallbackTarget, isProxiedThrough, isWorkersProxy, listNames, logger, normalizeActiveFallbacks, parseEncryptingHostDomains, parseFileTypeFilter, parseShareXConfig, PIXELDRAIN_KEY_REQUIRED, previewShareXRequestValue, proxyBodyLimit, proxyKey, resolveShareXRequestValue, resolveShareXTemplate, serviceLabel, SERVICES, ServiceType, ShareXUploaderConfig, TMPFILES_KEPT, toProxiedUrl, TRACKING_QUERY_KEYS, validateShareXConfig, ZEROX0_KEPT } from "../types";
import { announceKeptUpload, announceLateCancel, announceSendFailure, askOriginRetry, askTakeover, askToUseHost, LateCancelEntry, LateCancelError, notifyBlockedHost, notifyTakeover, openPluginSettings, UploadCancelledError } from "./dialogs";
import { ByteSource, convertApngToGif, getExtensionFromBytes, getExtensionFromMime, getMimeFromExtension, getUrlExtension, isOggVideo } from "./media";
import { addHistoryEntry, cleanHostText, Deletion, describeBody, describeHttpFailure, HistoryEntry, isDeleting, loadUploadHistory, newHistoryId, redactText, rememberSessionSecret, removeHistoryEntry, setDeleteActions, setDeleting, setDeviceSecret } from "./privacy";
import { addAlwaysOrigin, alwaysRetryAllowed, checkRoutingSettings, consentPending, dropProxyFirst, EmbedContext, embedTarget, EmbedWait, getActiveCorsProxyUrl, hasUploadedToHttpOrigin, isHostDown, isInsecureHttpAllowed, isLanOrigin, isVideoLink, loadProxyOrigins, markHostDown, markProxyFirst, needsOriginConfirmation, noticeProxyChange, notifyHttpPrefs, onAlwaysOriginsForgotten, peekDeviceProxyAnswer, predictEmbedTarget, primeDeviceState, probeEmbedTarget, proxyAllowedHere, proxyConsentGiven, proxyFirstEntry, proxyOffReason, proxyRedirectsSafe, readCapped, readVideoDims, rememberHttpOrigin, rememberLanOrigin, routingSnapshot, VideoDims, whenPromptIdle, wrapForEmbed } from "./proxy";
import { bytesToHex, failedBeforeSending, hasSecretQuery, httpHostKind, httpLanOnlyText, isBuiltInOrigin, isDnsCode, isPrivateAddress, isProxyReachableHost, isSpooled, isSpoolPart, NATIVE_MAX_BUFFER, PROXY_RETRY_KINDS, proxyCouldNotReach, proxySourceAllowed, randomHexBytes, RequestBody, RESPONSE_GRACE_MS, SPOOL_MAX_BYTES, SPOOL_MIN_BYTES, SPOOL_SLICE_BYTES, SpooledFile, SpoolPart, SpoolSource, UploadBody, UploadFailure } from "./shared";

const KEY = "BigFileUpload_gofileGuestToken";

let cache = "";

let loading: Promise<void> | null = null;

let written = false;

const asToken = (value: unknown) => typeof value === "string" ? value.trim() : "";

function setCache(token: string): void {
    cache = token;
    setDeviceSecret("gofileGuestToken", token);
    notifyHttpPrefs();
}

export function loadGofileGuest(): Promise<void> {
    return loading ??= (async () => {
        try {
            const stored = asToken(await DataStore.get<unknown>(KEY));
            if (!written) setCache(stored);
        } catch (error) {
            logger.warn("Couldn't read this device's GoFile guest token", error);
        }
    })();
}

function saveDevice(token: string): void {
    written = true;
    setCache(token);
    Promise.resolve().then(() => token ? DataStore.set(KEY, token) : DataStore.del(KEY))
        .catch(error => logger.warn("Couldn't save this device's GoFile guest token", error));
}

export const gofileGuestSynced = () => settings.plain?.gofileSyncGuestToken === true;

export function storedGofileGuestToken(): string {
    if (gofileGuestSynced()) return asToken(settings.plain?.gofileGuestToken);
    if (!loading) void loadGofileGuest();
    return cache;
}

export function hasStoredGofileGuestToken(): boolean {
    if (!loading) void loadGofileGuest();
    return cache !== "" || asToken(settings.plain?.gofileGuestToken) !== "";
}

export function saveGofileGuestToken(token: string): void {
    if (gofileGuestSynced()) settings.store.gofileGuestToken = token;
    else saveDevice(token);
}

export async function setGofileGuestSync(on: boolean): Promise<void> {
    await loadGofileGuest();
    if (on === gofileGuestSynced()) return;
    if (on) {
        const token = cache;
        settings.store.gofileSyncGuestToken = true;
        if (token) settings.store.gofileGuestToken = token;
        saveDevice("");
    } else {
        const token = asToken(settings.plain?.gofileGuestToken);
        settings.store.gofileSyncGuestToken = false;
        saveDevice(token);
        if (token) settings.store.gofileGuestToken = "";
    }
}

export async function resetGofileGuestToken(): Promise<void> {
    await loadGofileGuest();
    for (const old of [cache, asToken(settings.plain?.gofileGuestToken)]) if (old) rememberSessionSecret(old);
    saveDevice("");
    if (asToken(settings.plain?.gofileGuestToken)) settings.store.gofileGuestToken = "";
}

type UploadRequestResponse = {
    ok: boolean;
    status: number;
    headers: Headers;
    text(): Promise<string>;
};

export type S3RequestOptions = {
    method: string;
    headers: Record<string, string>;
    bodyType: "binary";
    filename?: string;
    idempotent?: boolean;
    proxyRetry?: "deny";
};

export interface S3Transport {
    request(url: string, options: S3RequestOptions, body: RequestBody | null): Promise<UploadRequestResponse>;
    proxied: boolean;
    proxyLimit: number | null;
    corsHeaders: boolean;
    bucketCors: boolean;
    answeredDirect?(): boolean;
    multipartBlocked: string | null;
    payloadSha256(body: UploadBody): Promise<string>;
    hashReadsWhole(body: UploadBody): Promise<boolean>;
    prepare(body: UploadBody): Promise<void>;
    approve(url: string): Promise<void>;
    part(body: UploadBody, offset: number, length: number, hashed: boolean): Promise<{ body: RequestBody; sha256?: string; }>;
    abort(url: string, headers: Record<string, string>): Promise<number>;
    retry(error: unknown, options?: RetryOptions): Promise<boolean>;
    checkCancel(): void;
    ownRetries(): void;
    parts(state: MultipartState | null): void;
    uploaded?(object: S3Object): void;
}

export interface S3Object {
    url: string;
    endpoint: string;
    bucket: string;
}

export interface RetryOptions {
    transient?: boolean;
    resend?: boolean;
}

export interface MultipartState {
    done: number;
    total: number;
    part: number;
    parts: number;
    completing?: boolean;
    last?: boolean;
}

export const S3_MAX_PUT_BYTES = 5 * 1024 ** 3;

const S3_MIN_PART_BYTES = 5 * 1024 ** 2;

const S3_PART_BYTES = 64 * 1024 ** 2;

const S3_MAX_PARTS = 10_000;

const S3_MAX_OBJECT_BYTES = 5 * 1024 ** 4;

export const MULTIPART_ETAG_TEXT = "Your bucket's CORS rules (or your proxy) must expose the ETag header for multipart uploads (ExposeHeaders: ETag)";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const HASHED_RESEND_MAX = 256 * 1024 * 1024;

const textEncoder = new TextEncoder();

function toArrayBuffer(data: ArrayBuffer | string): ArrayBuffer {
    return typeof data === "string" ? textEncoder.encode(data).buffer as ArrayBuffer : data;
}

function encodeRfc3986(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const byByteOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function buildS3Path(endpointPath: string, ...parts: string[]): string {
    const segments = [
        ...endpointPath.split("/").filter(Boolean).map(decodeSegment),
        ...parts.filter(Boolean).flatMap(part => part.split("/"))
    ].filter(Boolean);
    if (segments.some(segment => segment === "." || segment === "..")) {
        throw new Error("S3 paths can't contain \".\" or \"..\" segments (check the endpoint path, bucket and prefix)");
    }
    const normalized = segments.map(encodeRfc3986).join("/");
    return normalized ? `/${normalized}` : "/";
}

function getTimestampParts(date: Date): { amzDate: string; dateStamp: string; } {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hour = String(date.getUTCHours()).padStart(2, "0");
    const minute = String(date.getUTCMinutes()).padStart(2, "0");
    const second = String(date.getUTCSeconds()).padStart(2, "0");

    return {
        amzDate: `${year}${month}${day}T${hour}${minute}${second}Z`,
        dateStamp: `${year}${month}${day}`
    };
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(data))));
}

async function hmacSha256(key: ArrayBuffer | string, value: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(value));
}

export function canonicalQuery(query: Record<string, string>): string {
    return Object.entries(query)
        .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
        .sort(([a], [b]) => byByteOrder(a, b))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
}

export function multipartPartSize(size: number, proxyLimit: number | null): number {
    if (size > S3_MAX_OBJECT_BYTES) throw new Error("S3 objects can't be larger than 5 TiB");
    let partSize = Math.max(S3_PART_BYTES, Math.ceil(size / S3_MAX_PARTS));
    if (proxyLimit != null) partSize = Math.min(partSize, proxyLimit);
    if (partSize < S3_MIN_PART_BYTES || Math.ceil(size / partSize) > S3_MAX_PARTS) {
        throw new Error("The file is too large for multipart upload through the CORS proxy");
    }
    return partSize;
}

export function needsMultipart(size: number, proxyLimit: number | null): boolean {
    return size > S3_MAX_PUT_BYTES || (proxyLimit != null && size > proxyLimit);
}

function xmlValue(xml: string, tag: string): string | undefined {
    const raw = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
    return raw?.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" })[e]!);
}

const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const describeS3Error = (status: number, body: string) => describeHttpFailure(ServiceType.S3, status, body);

async function refusesUnsignedPayload(response: UploadRequestResponse): Promise<boolean> {
    const code = xmlValue(await response.text(), "Code");
    return (response.status === 403 && code === "SignatureDoesNotMatch")
        || (response.status === 400 && code === "XAmzContentSHA256Mismatch")
        || (response.status === 501 && code === "NotImplemented");
}

interface S3Target {
    host: string;
    canonicalUri: string;
    url: URL;
    region: string;
    regionKey: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

let clockOffsetMs = 0;

const learnedRegions = new Map<string, string>();

async function correctedFrom(target: S3Target, response: UploadRequestResponse, t: S3Transport): Promise<boolean> {
    if (response.status !== 403 && response.status !== 400) return false;
    const text = await response.text();
    const code = xmlValue(text, "Code");
    if (code === "RequestTimeTooSkewed") {
        if (t.proxied || t.answeredDirect?.() === false) return false;
        const server = Date.parse(response.headers.get("date") ?? "") || Date.parse(xmlValue(text, "ServerTime") ?? "");
        if (!Number.isFinite(server)) return false;
        clockOffsetMs = server - Date.now();
        logger.warn(`This device's clock is ${Math.round(Math.abs(clockOffsetMs) / 1000)} s off S3's. Signing with S3's time`);
        return true;
    }
    if (code === "AuthorizationHeaderMalformed") {
        const region = xmlValue(text, "Region") ?? /expecting '([^']+)'/.exec(xmlValue(text, "Message") ?? "")?.[1];
        if (!region || !/^[a-z0-9-]{1,64}$/.test(region) || region === target.region) return false;
        logger.warn(`S3 expects the region "${region}", not "${target.region}". Set Region to it in the S3 settings`);
        target.region = region;
        learnedRegions.set(target.regionKey, region);
        return true;
    }
    return false;
}

async function signedHeaders(target: S3Target, method: string, query: Record<string, string>, headers: Record<string, string>, payloadHash: string): Promise<Record<string, string>> {
    const { amzDate, dateStamp } = getTimestampParts(new Date(Date.now() + clockOffsetMs));
    const canonicalHeadersMap: Record<string, string> = {
        ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
        "host": target.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate
    };

    if (target.sessionToken) {
        canonicalHeadersMap["x-amz-security-token"] = target.sessionToken;
    }

    const signedHeaderEntries = Object.entries(canonicalHeadersMap).sort(([a], [b]) => byByteOrder(a, b));
    const signedHeaderNames = signedHeaderEntries.map(([key]) => key).join(";");
    const canonicalHeaders = signedHeaderEntries.map(([key, value]) => `${key}:${value.trim().replace(/ {2,}/g, " ")}\n`).join("");

    const canonicalRequest = [
        method,
        target.canonicalUri,
        canonicalQuery(query),
        canonicalHeaders,
        signedHeaderNames,
        payloadHash
    ].join("\n");

    const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        await sha256Hex(canonicalRequest)
    ].join("\n");

    const kDate = await hmacSha256(`AWS4${target.secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256(kDate, target.region);
    const kService = await hmacSha256(kRegion, "s3");
    const kSigning = await hmacSha256(kService, "aws4_request");
    const signature = bytesToHex(new Uint8Array(await hmacSha256(kSigning, stringToSign)));

    const { host: _, ...sent } = canonicalHeadersMap;
    return {
        ...sent,
        "Authorization": `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`
    };
}

function requestUrl(target: S3Target, query: Record<string, string>): string {
    const url = new URL(target.url.href);
    url.search = canonicalQuery(query).replace(/=(?=&|$)/g, "");
    return url.href;
}

export async function uploadToS3(fileBlob: UploadBody, filename: string, t: S3Transport): Promise<string> {
    const {
        s3Endpoint,
        s3Bucket,
        s3Region = "auto",
        s3AccessKeyId,
        s3SecretAccessKey,
        s3SessionToken,
        s3PublicUrl,
        s3Prefix,
        s3ForcePathStyle = true,
        s3SignPayload
    } = settings.store;

    if (!s3Endpoint || !s3Bucket || !s3Region || !s3AccessKeyId || !s3SecretAccessKey) {
        throw new Error("S3 endpoint, bucket, region, access key ID and secret key are required");
    }

    const endpoint = new URL(s3Endpoint);
    if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error("S3 endpoint must be an HTTP(S) URL without a user name or password");
    }
    if (s3PublicUrl) {
        const publicUrl = URL.canParse(s3PublicUrl.trim()) ? new URL(s3PublicUrl.trim()) : null;
        if (!publicUrl || !/^https?:$/.test(publicUrl.protocol) || publicUrl.username || publicUrl.password || /[?#]/.test(s3PublicUrl)) {
            throw new Error("S3 Public Base URL must be an HTTP(S) URL without a user name, password, query or fragment");
        }
    }

    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
    const prefixSegments = (s3Prefix || "").split("/").filter(Boolean);
    const objectName = `${Date.now()}-${randomHexBytes(8)}${extension}`;
    const objectKeyRaw = [...prefixSegments, objectName].join("/");
    const objectKeyPath = objectKeyRaw.split("/").filter(Boolean).map(encodeRfc3986).join("/");

    const host = s3ForcePathStyle ? endpoint.host : `${s3Bucket}.${endpoint.host}`;
    const canonicalUri = s3ForcePathStyle
        ? buildS3Path(endpoint.pathname, s3Bucket, objectKeyRaw)
        : buildS3Path(endpoint.pathname, objectKeyRaw);

    const uploadUrl = new URL(endpoint.toString());
    uploadUrl.host = host;
    uploadUrl.pathname = canonicalUri;
    uploadUrl.search = "";
    uploadUrl.hash = "";
    if (uploadUrl.pathname !== canonicalUri) {
        throw new Error("The S3 object path changes during URL normalization, so the upload was not sent");
    }

    const regionKey = `${endpoint.host}\n${s3Bucket}\n${s3Region}`;
    const target: S3Target = { host, canonicalUri, url: uploadUrl, region: learnedRegions.get(regionKey) ?? s3Region, regionKey, accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey, sessionToken: s3SessionToken || undefined };
    const unsigned = endpoint.protocol === "https:" && !t.proxied && !s3SignPayload;
    const contentType = fileBlob.type || "application/octet-stream";
    const proxyLimit = t.proxied ? t.proxyLimit : null;
    const objectHeaders: Record<string, string> = {
        "Content-Type": contentType,
        ...!t.bucketCors && { "Content-Disposition": `inline; filename*=UTF-8''${encodeRfc3986(filename)}` }
    };

    await t.approve(uploadUrl.toString());
    if (needsMultipart(fileBlob.size, proxyLimit)) {
        await multipartUpload(target, fileBlob, objectHeaders, unsigned, proxyLimit, t);
    } else {
        const put = async (hashed: boolean) => {
            const payloadHash = hashed ? await t.payloadSha256(fileBlob) : UNSIGNED_PAYLOAD;
            const headers = await signedHeaders(target, "PUT", {}, objectHeaders, payloadHash);
            return t.request(uploadUrl.toString(), { method: "PUT", headers, bodyType: "binary", filename, ...(!hashed && { proxyRetry: "deny" as const }) }, fileBlob);
        };

        let response = await put(!unsigned);
        if (await correctedFrom(target, response, t)) response = await put(!unsigned);
        if (unsigned && await refusesUnsignedPayload(response)) {
            if (fileBlob.size > HASHED_RESEND_MAX && await t.hashReadsWhole(fileBlob)) {
                throw new Error(`Upload failed: ${describeS3Error(response.status, await response.text()).replace(/\.+$/, "")}. Check the access key and secret key. If they are right, this server needs the payload's hash: turn on "Sign Payload" in the S3 settings`);
            }
            response = await put(true);
        }

        if (!response.ok) {
            throw new Error(`Upload failed: ${describeS3Error(response.status, await response.text())}`);
        }
    }

    t.uploaded?.({ url: uploadUrl.href, endpoint: s3Endpoint.trim(), bucket: s3Bucket.trim() });

    if (s3PublicUrl) {
        const base = s3PublicUrl.trim().replace(/\/+$/, "");
        return `${base}/${objectKeyPath}`;
    }

    const publicBase = s3ForcePathStyle
        ? `${endpoint.origin}${buildS3Path(endpoint.pathname, s3Bucket)}`
        : `${endpoint.protocol}//${host}${buildS3Path(endpoint.pathname)}`;

    return `${publicBase.replace(/\/+$/, "")}/${objectKeyPath}`;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export async function signS3Delete(objectUrl: string): Promise<Record<string, string>> {
    const { s3Endpoint, s3Bucket, s3Region = "auto", s3AccessKeyId, s3SecretAccessKey, s3SessionToken } = settings.store;
    if (!s3Endpoint || !s3Bucket || !s3Region || !s3AccessKeyId || !s3SecretAccessKey) throw new Error("S3's settings are incomplete");
    const url = new URL(objectUrl);
    const regionKey = `${new URL(s3Endpoint).host}\n${s3Bucket}\n${s3Region}`;
    const target: S3Target = { host: url.host, canonicalUri: url.pathname, url, region: learnedRegions.get(regionKey) ?? s3Region, regionKey, accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey, sessionToken: s3SessionToken || undefined };
    return signedHeaders(target, "DELETE", {}, {}, EMPTY_SHA256);
}

async function multipartUpload(target: S3Target, fileBlob: UploadBody, objectHeaders: Record<string, string>, unsignedParts: boolean, proxyLimit: number | null, t: S3Transport): Promise<void> {
    if (t.multipartBlocked) throw new Error(t.multipartBlocked);
    const { size } = fileBlob;
    const partSize = multipartPartSize(size, proxyLimit);
    const parts = Math.ceil(size / partSize);
    const send = async (method: string, query: Record<string, string>, body: Blob | null, headers: Record<string, string> = {}) => {
        const payloadHash = body?.size ? await sha256Hex(await body.arrayBuffer()) : EMPTY_SHA256;
        const once = async () => t.request(requestUrl(target, query), { method, headers: await signedHeaders(target, method, query, headers, payloadHash), bodyType: "binary", idempotent: true }, body);
        const response = await once();
        return await correctedFrom(target, response, t) ? once() : response;
    };
    const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (error) {
            if (!await t.retry(error)) throw error;
            return run();
        }
    };

    t.ownRetries();
    await t.prepare(fileBlob);
    t.checkCancel();
    t.parts({ done: 0, total: size, part: 1, parts });
    let uploadId: string | undefined;
    let completed = false;
    try {
        uploadId = await withRetry(async () => {
            const response = await send("POST", { uploads: "" }, new Blob([], { type: objectHeaders["Content-Type"] }), objectHeaders);
            const text = await response.text();
            const id = response.ok ? xmlValue(text, "UploadId") : undefined;
            if (!id) throw new Error(`Couldn't start the multipart upload: ${describeS3Error(response.status, text)}`);
            return id;
        });

        const etags: string[] = [];
        let unsigned = unsignedParts;
        for (let n = 1; n <= parts; n++) {
            t.checkCancel();
            const offset = (n - 1) * partSize;
            const length = Math.min(partSize, size - offset);
            t.parts({ done: offset, total: size, part: n, parts });
            const query = { partNumber: String(n), uploadId };
            let retried = false;
            let corrected = false;
            let etag: string | null = null;
            for (let tries = 0; tries < 4 && etag === null; tries++) {
                const part = await t.part(fileBlob, offset, length, !unsigned);
                const headers = await signedHeaders(target, "PUT", query, {}, part.sha256 ?? UNSIGNED_PAYLOAD);
                let response: UploadRequestResponse | undefined;
                let failure: unknown;
                try {
                    response = await t.request(requestUrl(target, query), { method: "PUT", headers, bodyType: "binary", idempotent: true, ...(unsigned && { proxyRetry: "deny" as const }) }, part.body);
                } catch (error) {
                    failure = error;
                }
                if (response) {
                    if (!corrected && await correctedFrom(target, response, t)) {
                        corrected = true;
                        continue;
                    }
                    if (unsigned && await refusesUnsignedPayload(response)) {
                        unsigned = false;
                        continue;
                    }
                    if (response.ok) {
                        etag = response.headers.get("etag");
                        if (!etag) throw new Error(t.corsHeaders ? MULTIPART_ETAG_TEXT : `S3 didn't return an ETag for part ${n}`);
                        continue;
                    }
                    failure = new Error(`Part ${n} of ${parts} failed: ${describeS3Error(response.status, await response.text())}`);
                }
                if (retried || !await t.retry(failure, { resend: true })) throw failure;
                retried = true;
            }
            if (etag === null) throw new Error(`Part ${n} of ${parts} failed`);
            etags.push(etag);
        }

        t.checkCancel();
        t.parts({ done: size, total: size, part: parts, parts, completing: true });
        const xml = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        for (let tries = 0; tries < 2 && !completed; tries++) {
            let failure: unknown;
            let transient = false;
            try {
                const response = await send("POST", { uploadId }, new Blob([xml], { type: "application/xml" }), { "Content-Type": "application/xml" });
                const text = await response.text();
                if (response.ok && text.includes("<CompleteMultipartUploadResult") && !/<Error>/.test(text)) {
                    completed = true;
                    break;
                }
                transient = xmlValue(text, "Code") === "InternalError";
                failure = new Error(`Couldn't complete the multipart upload: ${describeS3Error(response.status, text)}`);
            } catch (error) {
                failure = error;
            }
            if (tries > 0 || !await t.retry(failure, { transient })) throw failure;
        }
    } finally {
        t.parts(null);
        if (uploadId && !completed) {
            try {
                const query = { uploadId };
                const status = await t.abort(requestUrl(target, query), await signedHeaders(target, "DELETE", query, {}, EMPTY_SHA256));
                if (status !== 204 && status !== 200 && status !== 404) logger.warn(`Couldn't abort the multipart upload ${uploadId}: S3 answered ${status}`);
            } catch (error) {
                logger.warn(`Couldn't abort the multipart upload ${uploadId}`, error);
            }
        }
    }
}

const Native = IS_WEB
    ? null
    : (VencordNative.pluginHelpers.BigFileUpload as PluginNative<typeof import("../native")> | undefined) ?? null;

export { listNames, logger };

export const hasNativeHelper = Native !== null;

export const clientName = () => IS_WEB ? "Web" : IS_VESKTOP ? "Vesktop" : "Desktop";

export const transportName = () => Native ? "native" : "renderer";

export { getEmbedProxyService } from "./proxy";
export { getActiveCorsProxyUrl, proxyAllowedHere } from "./proxy";

void primeDeviceState();

void loadUploadHistory();

let currentAttemptService: ServiceType | null = null;

async function withAttemptService<T>(service: ServiceType, run: () => Promise<T>): Promise<T> {
    currentAttemptService = service;
    try {
        return await run();
    } finally {
        currentAttemptService = null;
    }
}

type Route = "native" | "direct" | "simple" | "proxy";

export const carriesCredential = (service: ServiceType) => hasConfiguredCredential(service, settings.store as CredentialValues)
    || (service === ServiceType.GOFILE && !gofileGuestSynced() && gofileGuestToken() !== undefined);

const credentialHeldBack = (service: ServiceType) => !Native && carriesCredential(service) && !proxyConsentGiven();

const proxyFor = (service: ServiceType | null) => proxyAllowedHere() && !(service && credentialHeldBack(service));

function requestRoute(service: ServiceType | null): Route {
    if (Native) return "native";
    const web = service ? SERVICES[service]?.web : undefined;
    if (web === "direct") return "direct";
    if (web === "direct-simple") return "simple";
    return proxyFor(service) ? "proxy" : "direct";
}

export const routesThroughProxy = (service: ServiceType) => requestRoute(service) === "proxy";

const PROXY_PLACE = IS_WEB ? "On Vencord Web" : "In this app without the native helper";

export function credentialViaProxy(service: ServiceType): boolean {
    const web = SERVICES[service]?.web;
    return !Native && proxyAllowedHere() && web !== undefined && web !== "direct" && web !== "direct-simple" && web !== "unsupported"
        && carriesCredential(service);
}

export function proxiedCredentialHosts(allowed = true): ServiceType[] {
    const selected = settings.store.serviceType as ServiceType;
    const hosts = [selected, ...settings.store.disableFallbacks ? [] : getFallbackServices()];
    return [...new Set(hosts)].filter(s => SERVICES[s] && (allowed ? credentialViaProxy(s) : !Native && SERVICES[s].web !== "direct"
        && SERVICES[s].web !== "direct-simple" && SERVICES[s].web !== "unsupported" && carriesCredential(s)));
}

function uploadUrlCarriesKey(service: ServiceType): boolean {
    let raw = endpointOf(service);
    if (service === ServiceType.SHAREX) {
        try {
            const config = parseShareXConfigFromSettings();
            raw = previewShareXRequestValue(config.RequestURL!, "upload.png", { config, urlEncode: true, field: "RequestURL" });
            if (Object.keys(config.Parameters ?? {}).some(key => hasSecretQuery(new URL(`https://example.invalid/?${encodeURIComponent(key)}=value`)))) return true;
        } catch { }
    }
    const value = raw?.trim() ?? "";
    return URL.canParse(value) && hasSecretQuery(new URL(value));
}

function customCredentialHeader(service: ServiceType): boolean {
    if (service === ServiceType.EZHOST || service === ServiceType.ENCRYPTINGHOST) return true;
    if (service !== ServiceType.SHAREX) return false;
    try {
        return Object.entries(parseShareXConfigFromSettings().Headers ?? {}).some(([k, v]) => k.toLowerCase() !== "authorization" && String(v).trim() !== "");
    } catch {
        return false;
    }
}

export function proxyCredentialWarning(service?: ServiceType): string | null {
    const hosts = service ? credentialViaProxy(service) ? [service] : [] : proxiedCredentialHosts();
    if (!hosts.length) return null;
    const url = getActiveCorsProxyUrl();
    const proxy = describeProxy(url);
    const given = proxyConsentGiven();
    const one = service !== undefined;
    const subject = one ? "this credential" : `the credentials you entered for ${listNames(hosts.map(serviceLabel))}`;
    const verb = given ? one ? "passes" : "pass" : "will pass";
    const target = proxy.preset ? `the CORS proxy (${proxy.host}, run by ${proxy.operator})` : proxy.host;
    const parts = [`${PROXY_PLACE}, ${subject} ${verb} through ${target}${given ? "" : " once you accept the CORS proxy on this device"}.`];
    if (!proxy.preset) parts.push("Only use a proxy you run yourself.");
    else if (given) parts.push("Use your own proxy to avoid that.");
    const keyed = hosts.filter(uploadUrlCarriesKey);
    if (keyed.length) {
        const where = one ? "The key in the upload URL" : `The key in the upload URL of ${listNames(keyed.map(serviceLabel))}`;
        parts.push(`${where} ends up in the proxy's own request URL, ${proxy.preset ? "which Workers logging records by default" : "where the proxy's logs can record it"}.`);
    }
    const redirectsSafe = proxyRedirectsSafe();
    if (!proxy.preset) {
        if (!redirectsSafe) parts.push(`Your proxy may forward ${one ? "this credential" : "these credentials"} to another site if the host redirects the upload, and BigFileUpload can't stop that ${RENDERER_PLACE}.`);
    } else if (!redirectsSafe) {
        const headed = hosts.filter(customCredentialHeader);
        if (headed.length) parts.push(`If ${one ? "the host" : listNames(headed.map(serviceLabel))} redirects the upload to another site, the proxy forwards ${one ? "this key" : "those keys"} there too.`);
    }
    const limit = proxyBodyLimit(url);
    if (limit != null) parts.push(`Files over ${formatSize(limit, true)} aren't sent through it.`);
    return parts.join(" ");
}

function viaCorsProxy(url: string): string {
    const corsProxyUrl = getActiveCorsProxyUrl();
    if (isProxiedThrough(url, corsProxyUrl)) {
        return url;
    }

    return toProxiedUrl(url, corsProxyUrl);
}

const needsProxyHere = (service: ServiceType) => !Native && SERVICES[service]?.web === "proxy" && !proxyAllowedHere();

function runsWithoutProxy(service: ServiceType): boolean {
    const web = SERVICES[service]?.web;
    return web === "direct" || web === "direct-simple" || web === "user";
}

function toProxyUrl(url: string, service: ServiceType | null = currentAttemptService): string {
    return requestRoute(service) === "proxy" ? viaCorsProxy(url) : url;
}

const RENDERER_PLACE = IS_WEB ? "on Vencord Web" : "in this app without the native helper";

const neededProxy = () => `the CORS proxy ${RENDERER_PLACE} (${proxyOffReason()})`;

export const needsProxyNote = () => `Needs ${neededProxy()}`;

const APNG_TO_GIF_MAX_BYTES = 32 * 1024 * 1024;

const LATE_CANCEL_WAIT_MS = 30000;

let isUploading = false;

type UploadPhase = "idle" | "preparing" | "downloading" | "uploading" | "retrying" | "success" | "failed" | "cancelled";

export interface UploadProgressState {
    phase: UploadPhase;
    channelId: string | null;
    draftType: number | null;
    composer: string | null;
    fileName: string;
    currentService: ServiceType | null;
    currentServiceLabel: string;
    attempt: number;
    totalAttempts: number;
    percent: number;
    indeterminate: boolean;
    transferredBytes: number;
    totalBytes: number;
    status: string;
    canCancel: boolean;
    lateWait: boolean;
    keptLink: LateCancelEntry | null;
    queued: number;
    queuedItems: QueuedUpload[];
}

export interface QueuedUpload {
    id: number;
    name: string;
    size: number | null;
}

const defaultUploadState: UploadProgressState = {
    phase: "idle",
    channelId: null,
    draftType: null,
    composer: null,
    fileName: "",
    currentService: null,
    currentServiceLabel: "",
    attempt: 0,
    totalAttempts: 0,
    percent: 0,
    indeterminate: false,
    transferredBytes: 0,
    totalBytes: 0,
    status: "",
    canCancel: false,
    lateWait: false,
    keptLink: null,
    queued: 0,
    queuedItems: []
};

let uploadState: UploadProgressState = { ...defaultUploadState };

const uploadStateListeners = new Set<() => void>();

let activeAbortController: AbortController | null = null;

let activeXhr: XMLHttpRequest | null = null;

let cancelRequested = false;

let resetStateTimer: ReturnType<typeof setTimeout> | null = null;

let xhrBodySent = false;

let cancelStage: "none" | "checking" | "waiting" = "none";

let lateWaitTimer: ReturnType<typeof setTimeout> | null = null;

let lateWaitHost: string | null = null;

let committedStage = false;

let uploadGeneration = 0;

let multipart: MultipartState | null = null;

function uploadingStatus(): string {
    const label = uploadState.currentServiceLabel;
    if (!label) return "Uploading...";
    if (multipart?.completing) return `Finishing the upload on ${label}...`;
    return multipart && multipart.parts > 1 ? `Uploading via ${label} (part ${multipart.part} of ${multipart.parts})...` : `Uploading via ${label}...`;
}

function spanned(loaded: number, total: number): { loaded: number; total: number; } {
    if (!multipart) return { loaded, total };
    return { loaded: multipart.completing ? multipart.total : multipart.done + Math.min(loaded, total), total: multipart.total };
}

function scheduleResetUploadState() {
    if (resetStateTimer) clearTimeout(resetStateTimer);
    resetStateTimer = setTimeout(() => {
        resetStateTimer = null;
        resetUploadState();
    }, 1800);
}

function clearScheduledResetUploadState() {
    if (resetStateTimer) {
        clearTimeout(resetStateTimer);
        resetStateTimer = null;
    }
}

function finishUploadState() {
    if (uploadState.phase === "failed" || uploadState.keptLink) {
        clearScheduledResetUploadState();
    } else {
        scheduleResetUploadState();
    }
}

export function dismissUploadState() {
    if (isUploading) return;
    clearScheduledResetUploadState();
    resetUploadState();
}

function isUploadCancelledError(error: unknown): boolean {
    return cancelRequested || error instanceof UploadCancelledError;
}

export function getFallbackServices(): ServiceType[] {
    ensureMigrated();
    const v = settings.store.fallbackActive;
    return normalizeActiveFallbacks(typeof v === "string" ? v : DEFAULT_ACTIVE_FALLBACKS);
}

export const isFallbackActive = (service: ServiceType) => getFallbackServices().includes(service);

function emitUploadState() {
    for (const listener of uploadStateListeners) {
        listener();
    }
}

function setUploadState(patch: Partial<UploadProgressState>) {
    uploadState = { ...uploadState, ...patch };
    emitUploadState();
}

function resetUploadState() {
    uploadState = { ...defaultUploadState, ...queueState() };
    emitUploadState();
}

export function subscribeUploadState(listener: () => void): () => void {
    uploadStateListeners.add(listener);
    return () => uploadStateListeners.delete(listener);
}

export function getUploadState(): UploadProgressState {
    return uploadState;
}

interface UploadJob {
    run(job: UploadJob): Promise<boolean>;
    resolve(ok: boolean): void;
    queuedBehind: boolean;
    fileNames: readonly string[];
    id: number;
    name: string;
    size: number | null;
}

const uploadQueue: UploadJob[] = [];

let nextJobId = 1;

const queueState = () => ({ queued: uploadQueue.length, queuedItems: uploadQueue.map(({ id, name, size }) => ({ id, name, size })) });

let pumping = false;

let droppedJobs = 0;

function enqueueUpload(name: string, run: UploadJob["run"], fileNames: readonly string[], size: number | null = null): Promise<boolean> {
    return new Promise(resolve => {
        uploadQueue.push({ run, resolve, queuedBehind: pumping, fileNames, id: nextJobId++, name, size });
        if (pumping) {
            setUploadState(queueState());
            showToast({ text: `Queued ${name}. It uploads when the current upload is done` });
        }
        void pumpUploads();
    });
}

async function pumpUploads(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
        for (let job = uploadQueue.shift(); job; job = uploadQueue.shift()) {
            setUploadState(queueState());
            staleOtherOffers(job);
            currentJob = job;
            let ok = false;
            try {
                ok = await job.run(job);
            } catch (error) {
                logger.error("Upload job failed", loggable(error));
            } finally {
                currentJob = null;
            }
            job.resolve(ok);
        }
    } finally {
        pumping = false;
    }
}

export function removeQueuedUpload(id: number): void {
    const index = uploadQueue.findIndex(job => job.id === id);
    if (index < 0) return;
    const [job] = uploadQueue.splice(index, 1);
    job.resolve(false);
    setUploadState(queueState());
}

const queuedName = (n: number) => `${n} queued ${n === 1 ? "upload" : "uploads"}`;

export function cancelAllUploads(): void {
    const dropped = uploadQueue.splice(0);
    for (const job of dropped) job.resolve(false);
    const stopRunning = isUploading && uploadState.canCancel && !cancelRequested;
    if (!dropped.length && !stopRunning) return;
    setUploadState({ queued: 0, queuedItems: [] });
    if (stopRunning) {
        droppedJobs += dropped.length;
        cancelCurrentUpload();
    } else {
        showToast({ text: `Cancelled ${queuedName(dropped.length)}` });
    }
}

function takeDroppedCount(): number {
    const n = droppedJobs;
    droppedJobs = 0;
    return n;
}

const cancelledAll = (queued: number) => queued === 1 ? "Cancelled both uploads" : `Cancelled all ${queued + 1} uploads`;

function clearLateWaitTimer() {
    if (lateWaitTimer) clearTimeout(lateWaitTimer);
    lateWaitTimer = null;
}

function beginUploadSession() {
    isUploading = true;
    droppedJobs = 0;
    cancelRequested = false;
    cancelStage = "none";
    lateWaitHost = null;
    committedStage = false;
    uploadGeneration++;
    clearLateWaitTimer();
}

function showCancelled() {
    cancelStage = "none";
    setUploadState({ phase: "cancelled", status: "Upload cancelled", canCancel: false, lateWait: false, percent: 0 });
}

function abortUpload() {
    clearLateWaitTimer();
    activeAbortController?.abort();
    activeXhr?.abort();
    void Native?.cancelUpload();
    showCancelled();
}

function startLateWait() {
    cancelStage = "waiting";
    lateWaitHost = uploadState.currentServiceLabel || "The host";
    clearLateWaitTimer();
    lateWaitTimer = setTimeout(abortUpload, LATE_CANCEL_WAIT_MS);
    setUploadState({ status: `Cancelling. ${lateWaitHost} already has the whole file, so BigFileUpload waits up to ${LATE_CANCEL_WAIT_MS / 1000} s for its link`, canCancel: true, lateWait: true });
}

export function cancelCurrentUpload() {
    if (!isUploading) {
        return;
    }

    if (cancelRequested) {
        if (cancelStage !== "none") abortUpload();
        return;
    }

    cancelRequested = true;
    if (stopEmbedWait) {
        stopEmbedWait();
        return;
    }
    if (wakeRetryWait) {
        abortUpload();
        wakeRetryWait();
        return;
    }
    activeAbortController?.abort();

    const native = Native;
    if (committedStage || (multipart && !multipart.completing && !multipart.last) || (activeXhr && !xhrBodySent)) {
        abortUpload();
    } else if (activeXhr) {
        startLateWait();
    } else if (native && typeof native.cancelUploadUnlessBodySent === "function") {
        cancelStage = "checking";
        setUploadState({ status: "Cancelling...", canCancel: true, lateWait: true });
        const generation = uploadGeneration;
        const current = () => generation === uploadGeneration && isUploading && cancelStage === "checking";
        native.cancelUploadUnlessBodySent().then(late => {
            if (!current()) return;
            if (late) startLateWait();
            else showCancelled();
        }, () => {
            if (current()) abortUpload();
        });
    } else {
        abortUpload();
    }
}

function getUploadTimeoutMs(): number {
    const value = settings.store.uploadTimeoutMs;
    if (!Number.isFinite(value) || !value) {
        return 60000;
    }

    return Math.max(5000, value);
}

function describeRequestTarget(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

class DownloadTooLargeError extends Error { }

function downloadTooLarge(source: string, size: number): DownloadTooLargeError {
    const segment = URL.canParse(source) ? new URL(source).pathname.split("/").pop() : "";
    const file = { name: sanitizeFilename(segment ? decodeUrlSegment(segment) : ""), size };
    const primary = selectedHost();
    const plan = planUpload(primary, file);
    return new DownloadTooLargeError((plan.order.length ? nativeCeilingText(size) : null) ?? noHostMessage(primary, file, plan));
}

function largestAccepted(service: ServiceType, ceiling: number): number {
    const accepts = (size: number) => !fileSkip(service, { name: "", size });
    let low = 0;
    let high = Math.min(ceiling, Number.MAX_SAFE_INTEGER);
    if (accepts(high)) return ceiling;
    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (accepts(mid)) low = mid;
        else high = mid;
    }
    return low;
}

function downloadLimit(): number | null {
    const ceiling = !Native ? Infinity : canSpool() ? SPOOL_MAX_BYTES : NATIVE_MAX_BUFFER;
    let limit = 0;
    for (const service of planUpload(selectedHost(), { name: "", size: 0 }).order) {
        limit = Math.max(limit, largestAccepted(service, ceiling));
        if (limit >= ceiling) break;
    }
    return Number.isFinite(limit) ? limit : null;
}

let downloadShownAt = 0;

function showDownloadProgress(loaded: number, total: number, force = false) {
    if (cancelRequested || (!force && Date.now() - downloadShownAt < 100)) return;
    downloadShownAt = Date.now();
    const known = total > 0 && loaded <= total;
    const percent = known ? Math.floor(loaded / total * 100) : 0;
    setUploadState({
        phase: "downloading",
        status: known ? `Downloading… ${percent}%` : "Downloading…",
        indeterminate: !known,
        percent,
        transferredBytes: loaded,
        totalBytes: known ? total : loaded
    });
}

function pollNativeDownload(): () => void {
    const native = Native;
    let stopped = false;
    if (!native) return () => { };
    const interval = setInterval(async () => {
        try {
            const p = await native.getUploadProgress();
            if (!stopped && p?.phase === "downloading") showDownloadProgress(p.loaded, p.total);
        } catch { }
    }, 150);
    return () => {
        stopped = true;
        clearInterval(interval);
    };
}

async function fetchBlobWithTimeout(url: string, useProxy: boolean, limit: number | null = null, tooLarge = downloadTooLarge): Promise<{ blob: Blob; contentType: string; }> {
    const controller = new AbortController();
    activeAbortController = controller;
    const stallMs = getUploadTimeoutMs();
    let timeout = setTimeout(() => controller.abort(), stallMs);
    const resetStallTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), stallMs);
    };

    try {
        const requestUrl = useProxy ? toProxyUrl(url, null) : url;
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Couldn't download the file (HTTP ${response.status})`);
        }

        const contentType = response.headers.get("content-type") || "";
        const declared = Number(response.headers.get("content-length") ?? NaN);
        const total = Number.isSafeInteger(declared) && declared >= 0 ? declared : 0;
        if (limit !== null && total > limit) {
            await response.body?.cancel().catch(() => { });
            throw tooLarge(url, total);
        }

        if (!response.body) {
            return { blob: await response.blob(), contentType };
        }

        resetStallTimeout();
        showDownloadProgress(0, total, true);
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetStallTimeout();
            if (!value) continue;
            received += value.length;
            if (limit !== null && received > limit) {
                await reader.cancel().catch(() => { });
                throw tooLarge(url, received);
            }
            chunks.push(value as BlobPart);
            showDownloadProgress(received, total);
        }

        return { blob: new Blob(chunks, contentType ? { type: contentType } : undefined), contentType };
    } catch (error) {
        if (cancelRequested || controller.signal.aborted) {
            throw cancelRequested ? new UploadCancelledError() : new Error("Download timed out");
        }

        throw error;
    } finally {
        clearTimeout(timeout);
        if (activeAbortController === controller) {
            activeAbortController = null;
        }
    }
}

function getHeaderEntries(headers?: HeadersInit): [string, string][] {
    if (!headers) return [];
    if (headers instanceof Headers) return Array.from(headers.entries());
    if (Array.isArray(headers)) return headers.map(([key, value]) => [key, value]);

    return Object.entries(headers);
}

class XhrResponse {
    ok: boolean;
    headers: Headers;
    status: number;
    statusText: string;
    url: string;

    constructor(private xhr: XMLHttpRequest) {
        this.status = xhr.status;
        this.statusText = xhr.statusText;
        this.url = xhr.responseURL;
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers();

        const rawHeaders = xhr.getAllResponseHeaders();
        for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
            if (!line) continue;

            const separatorIndex = line.indexOf(":");
            if (separatorIndex < 0) continue;

            this.headers.append(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
        }
    }

    async text(): Promise<string> {
        return typeof this.xhr.response === "string"
            ? this.xhr.response
            : this.xhr.responseText;
    }

    async json(): Promise<unknown> {
        return parseJsonAnswer(await this.text(), this.headers.get("content-type"));
    }
}

function setXhrUploadProgress(event: ProgressEvent) {
    if (!event.lengthComputable || event.total <= 0) {
        setUploadState({ status: uploadingStatus() });
        return;
    }

    const { loaded, total } = spanned(event.loaded, event.total);
    const percent = Math.round(Math.max(0, Math.min(100, loaded / total * 100)));
    setUploadState({
        phase: "uploading",
        percent,
        transferredBytes: loaded,
        totalBytes: total,
        status: uploadingStatus()
    });
}

class TransportError extends Error {
    constructor(
        message: string,
        readonly kind: "network" | "timeout",
        readonly viaProxy: boolean,
        readonly bodySent: boolean,
        readonly sentAny: boolean,
        readonly unsent: boolean
    ) {
        super(message);
    }
}

interface RequestTransport {
    viaProxy: boolean;
    simple: boolean;
    bodyBytes: number;
}

const SIMPLE_REQUEST_BYTES_PER_SECOND = 256 * 1024;

async function uploadRequestWithTimeout(requestUrl: string, options: RequestInit, { viaProxy, simple, bodyBytes }: RequestTransport): Promise<XhrResponse> {
    const xhr = new XMLHttpRequest();
    activeXhr = xhr;
    xhrBodySent = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return new Promise<XhrResponse>((resolve, reject) => {
        let bodySent = false;
        let sentAny = false;
        const stallMs = getUploadTimeoutMs();
        const firstMs = simple ? Math.max(stallMs, RESPONSE_GRACE_MS + bodyBytes / SIMPLE_REQUEST_BYTES_PER_SECOND * 1000) : stallMs;
        timeout = setTimeout(() => xhr.abort(), firstMs);
        const armStallTimeout = (ms: number) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => xhr.abort(), ms);
        };
        const resetStallTimeout = () => armStallTimeout(stallMs);

        xhr.open(options.method || "GET", requestUrl);

        for (const [key, value] of getHeaderEntries(options.headers)) {
            xhr.setRequestHeader(key, value);
        }

        // Upload listeners registered before send() force a CORS preflight, so a host that doesn't grant discord.com never gets the body. Never move them after send()
        if (!simple) {
            xhr.upload.onprogress = event => {
                if (event.loaded > 0) sentAny = true;
                resetStallTimeout();
                setXhrUploadProgress(event);
            };
            xhr.upload.onload = () => {
                bodySent = sentAny = true;
                if (activeXhr === xhr) xhrBodySent = true;
                armStallTimeout(Math.max(stallMs, RESPONSE_GRACE_MS));
            };
        }
        xhr.onload = () => {
            try {
                resolve(new XhrResponse(xhr));
            } catch (error) {
                reject(error);
            }
        };
        xhr.onerror = () => reject(new TransportError(
            `Couldn't reach ${describeRequestTarget(requestUrl)}. The browser blocked the request (CORS) or the host is unreachable`,
            "network", viaProxy, bodySent, sentAny, !simple && !sentAny
        ));
        xhr.onabort = () => reject(cancelRequested
            ? new UploadCancelledError()
            : new TransportError("Upload timed out", "timeout", viaProxy, bodySent, sentAny, false));
        xhr.send((options.body ?? null) as XMLHttpRequestBodyInit | null);
    }).finally(() => {
        clearTimeout(timeout);
        if (!simple) {
            xhr.upload.onprogress = null;
            xhr.upload.onload = null;
        }
        xhr.onload = xhr.onerror = xhr.onabort = null;
        if (activeXhr === xhr) activeXhr = null;
    });
}

function isCloudflareErrorPage(body: string): boolean {
    return /cloudflare/i.test(body) && (/<title>\s*413 Request Entity Too Large\s*<\/title>/i.test(body) || /error code: 1\d{3}/i.test(body));
}

function withinProxyLimit(bodyBytes: number): boolean {
    const limit = proxyBodyLimit(getActiveCorsProxyUrl());
    return limit == null || bodyBytes <= limit;
}

function parseJsonAnswer(text: string, contentType?: string | null): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const body = describeBody(text, contentType);
        throw new Error(`The host's answer isn't JSON${body ? ` (${body})` : ""}`);
    }
}

async function httpFailure(response: UploadHttpResponse, text?: string, lead = "Upload failed"): Promise<Error> {
    const line = describeHttpFailure(currentAttemptService, response.status, text ?? await response.text(), response.headers.get("content-type"));
    const reason = line === String(response.status) ? cleanHostText(response.statusText) : "";
    return new Error(`${lead}: ${line}${reason ? ` ${reason}` : ""}`);
}

interface UploadHttpResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Headers;
    url: string;
    text(): Promise<string>;
    json(): Promise<unknown>;
}

const canSpool = () => Boolean(Native && typeof Native.spoolOpen === "function" && typeof Native.spoolWrite === "function"
    && typeof Native.spoolRelease === "function");

const SPOOL_SESSION = randomHexBytes(16);

function nativeCeilingText(size: number): string | null {
    if (!Native) return null;
    if (canSpool()) return size > SPOOL_MAX_BYTES ? `Files over ${formatSize(SPOOL_MAX_BYTES, true)} can't be uploaded from the desktop app` : null;
    return size > NATIVE_MAX_BUFFER ? "Files over 1.9 GB can't be uploaded from the desktop app yet (fully restart Discord or Vesktop to finish updating BigFileUpload)" : null;
}

class SpoolError extends Error { }

class NativeBusyError extends Error { }

interface Spool {
    id: string;
    sha256: string;
}

let currentSpool: { blob: Blob | null; spool: Promise<Spool | null>; } | null = null;

async function releaseSpool(): Promise<void> {
    const current = currentSpool;
    currentSpool = null;
    const spool = await current?.spool.catch(() => null);
    if (spool) await Native?.spoolRelease(spool.id).catch(() => { });
}

function adoptSpool(file: SpooledFile): void {
    void releaseSpool();
    currentSpool = { blob: null, spool: Promise.resolve({ id: file.id, sha256: file.sha256 }) };
}

function spoolFor(blob: Blob): Promise<Spool | null> {
    if (currentSpool?.blob === blob) return currentSpool.spool;
    void releaseSpool();
    const spool = writeSpool(blob);
    currentSpool = { blob, spool };
    return spool;
}

async function writeSpool(blob: Blob): Promise<Spool | null> {
    const native = Native!;
    const fallBack = (reason: string) => {
        if (blob.size > NATIVE_MAX_BUFFER) throw new SpoolError(`Couldn't prepare the file for upload: ${reason}`);
        logger.warn(`Couldn't prepare a temporary file, sending the file whole instead: ${reason}`);
        return null;
    };

    const opened = await native.spoolOpen(blob.size, SPOOL_SESSION);
    if (cancelRequested) {
        if (opened.id) void native.spoolRelease(opened.id).catch(() => { });
        throw new UploadCancelledError();
    }
    if (!opened.success || !opened.id) return fallBack(opened.error || "unknown error");

    const { id } = opened;
    const { status } = uploadState;
    try {
        for (let offset = 0; offset < blob.size;) {
            const end = Math.min(offset + SPOOL_SLICE_BYTES, blob.size);
            const chunk = await blob.slice(offset, end).arrayBuffer();
            if (cancelRequested) throw new UploadCancelledError();
            if (chunk.byteLength !== end - offset) throw new SpoolError("The file changed or couldn't be read completely");
            const result = await native.spoolWrite(id, offset, chunk);
            if (result.cancelled || cancelRequested) throw new UploadCancelledError();
            if (!result.success || result.written !== end) throw new SpoolError(result.error || "The desktop app didn't take the whole file");
            offset = end;
            const percent = Math.floor(offset / blob.size * 100);
            setUploadState({ status: `Preparing… ${percent}%`, percent, transferredBytes: offset, totalBytes: blob.size });
            if (offset === blob.size) {
                if (!result.sha256) throw new SpoolError("The desktop app didn't finish the file");
                return { id, sha256: result.sha256 };
            }
        }
        throw new SpoolError("The file is empty");
    } catch (error) {
        void native.spoolRelease(id).catch(() => { });
        if (error instanceof SpoolError) return fallBack(error.message);
        throw error;
    } finally {
        if (!cancelRequested) setUploadState({ status, percent: 0, transferredBytes: 0 });
    }
}

async function readSpooledFile(file: SpooledFile): Promise<Blob> {
    const parts: ArrayBuffer[] = [];
    for (let offset = 0; offset < file.size;) {
        const length = Math.min(SPOOL_SLICE_BYTES, file.size - offset);
        const result = await Native!.spoolRead(file.id, offset, length);
        if (!result.success || !result.data) throw new Error(result.error || "Couldn't read the downloaded file");
        parts.push(result.data);
        offset += length;
    }
    return new Blob(parts, { type: file.type });
}

function spoolBytes(file: SpooledFile): ByteSource {
    return {
        size: file.size,
        async read(offset, length) {
            if (offset + length <= file.head.size) return new Uint8Array(await file.head.slice(offset, offset + length).arrayBuffer());
            const result = await Native!.spoolRead(file.id, offset, Math.min(length, file.size - offset));
            if (!result.success || !result.data) throw new Error(result.error || "Couldn't read the downloaded file");
            return new Uint8Array(result.data);
        }
    };
}

async function nativeBody(body: RequestBody): Promise<ArrayBuffer | SpoolSource> {
    if (isSpoolPart(body)) return { kind: "spool", id: body.id, offset: body.offset, length: body.size };
    if (isSpooled(body)) return { kind: "spool", id: body.id };
    if (body.size > SPOOL_MIN_BYTES && canSpool()) {
        const spool = await spoolFor(body);
        if (spool) return { kind: "spool", id: spool.id };
    }
    return body.arrayBuffer();
}

const hashingSpool = (body: Blob) => Native && body.size > SPOOL_MIN_BYTES && canSpool() ? spoolFor(body) : Promise.resolve(null);

async function payloadSha256(body: UploadBody): Promise<string> {
    if (isSpooled(body)) return body.sha256;
    return (await hashingSpool(body))?.sha256 ?? sha256Hex(await body.arrayBuffer());
}

const canMultipart = () => !Native || (canSpool() && typeof Native.cleanupRequest === "function" && typeof Native.spoolHash === "function");

const MULTIPART_RESTART_TEXT = "S3-Compatible needs a multipart upload for files over 5 GB: fully restart Discord or Vesktop to finish updating BigFileUpload";

const CLEANUP_TIMEOUT_MS = 15000;

function rendererCleanupRequest(url: string, headers: Record<string, string>, viaProxy: boolean): Promise<number> {
    const xhr = new XMLHttpRequest();
    const timer = setTimeout(() => xhr.abort(), CLEANUP_TIMEOUT_MS);
    return new Promise<number>((resolve, reject) => {
        xhr.open("DELETE", viaProxy ? viaCorsProxy(url) : url);
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        xhr.onload = () => resolve(xhr.status);
        xhr.onerror = () => reject(new Error("network error (the bucket's CORS rules must allow DELETE)"));
        xhr.onabort = () => reject(new Error(`no answer within ${CLEANUP_TIMEOUT_MS / 1000} s`));
        xhr.send();
    }).finally(() => {
        clearTimeout(timer);
        xhr.onload = xhr.onerror = xhr.onabort = null;
    });
}

async function partOf(body: UploadBody, offset: number, length: number, hashed: boolean): Promise<{ body: RequestBody; sha256?: string; }> {
    if (Native) {
        const id = isSpooled(body) ? body.id : (await spoolFor(body))?.id;
        if (!id) throw new SpoolError("Couldn't prepare the file for upload");
        const part: SpoolPart = { kind: "spool-part", id, offset, size: length, type: "" };
        if (!hashed) return { body: part };
        const result = await Native.spoolHash(id, offset, length);
        if (!result.success || !result.sha256) throw new SpoolError(result.error || "Couldn't read the prepared file");
        return { body: part, sha256: result.sha256 };
    }
    if (isSpooled(body)) throw new Error("A file prepared for the desktop app can't be sent from here");
    const slice = body.slice(offset, offset + length);
    return { body: slice, sha256: hashed ? await sha256Hex(await slice.arrayBuffer()) : undefined };
}

function s3Transport(): S3Transport {
    const proxied = requestRoute(ServiceType.S3) === "proxy";
    return {
        request: serviceUploadRequest,
        proxied,
        proxyLimit: proxied ? proxyBodyLimit(getActiveCorsProxyUrl()) : null,
        corsHeaders: !Native,
        bucketCors: !Native && !proxied,
        answeredDirect: () => !lastOutcome?.rerouted && !attemptProxy,
        multipartBlocked: canMultipart() ? null : MULTIPART_RESTART_TEXT,
        payloadSha256,
        async hashReadsWhole(body) {
            return !isSpooled(body) && !await hashingSpool(body);
        },
        async prepare(body) {
            if (Native && !isSpooled(body)) await spoolFor(body);
        },
        approve: approveOrigin,
        part: partOf,
        async abort(url, headers) {
            if (!Native) return rendererCleanupRequest(url, headers, proxied && requestRoute(ServiceType.S3) === "proxy");
            const result = await Native.cleanupRequest({ url, method: "DELETE", headers, insecureOrigin: insecureOriginFor(url) });
            if (!result.success) throw new Error(result.error || "Unknown error");
            return result.status ?? 0;
        },
        retry: retryRequest,
        checkCancel() {
            if (cancelRequested) throw new UploadCancelledError();
        },
        ownRetries() {
            requestsRetried = true;
        },
        parts(state) {
            multipart = state;
            if (state) setUploadState({ phase: "uploading", status: uploadingStatus(), ...state.part === 1 && !state.done && { percent: 0, transferredBytes: 0, totalBytes: state.total } });
        },
        uploaded({ url, endpoint, bucket }) {
            attemptKept = { deletion: { kind: "s3", url }, endpointOrigin: new URL(url).origin, s3: { endpoint, bucket } };
        }
    };
}

type NativeUploadRequestOptions = Omit<import("../native").CustomUploadRequestOptions, "url" | "insecureOrigin">;

export const INSECURE_HTTP_HOSTS: ReadonlySet<ServiceType> = new Set([ServiceType.ZIPLINE, ServiceType.WEBDAV, ServiceType.SHAREX]);

export function insecureHttpOrigin(service: ServiceType): string | null {
    const origin = INSECURE_HTTP_HOSTS.has(service) ? httpOriginOf(service) : null;
    return origin && isInsecureHttpAllowed(service, origin) ? origin : null;
}

function insecureOriginFor(url: string): string | undefined {
    const origin = currentAttemptService && insecureHttpOrigin(currentAttemptService);
    return origin && URL.canParse(url) && new URL(url).origin === origin ? origin : undefined;
}

function httpRefusal(url: string, insecureOrigin: string | undefined): string | null {
    if (!URL.canParse(url)) return null;
    const { protocol, host, hostname } = new URL(url);
    if (protocol !== "http:") return null;
    if (insecureOrigin) return typeof Native?.checkHttpHost === "function" ? null : "\"Allow Insecure HTTP\" needs a full restart of Discord or Vesktop to finish updating BigFileUpload";
    if (httpHostKind(hostname) !== "public") return null;
    return httpLanOnlyText(host, false, currentAttemptService !== null && INSECURE_HTTP_HOSTS.has(currentAttemptService));
}

interface LanVerdict {
    lan: boolean | null;
    at: number;
}

const lanVerdicts = new Map<string, LanVerdict>();

const LAN_VERDICT_TTL_MS = 60000;

let lanCheckTimer: ReturnType<typeof setTimeout> | null = null;

let lanChecking: string | null = null;

export function insecureHttpOffered(service: ServiceType, url: string): boolean {
    const native = Native;
    if (!native || !INSECURE_HTTP_HOSTS.has(service) || !URL.canParse(url.trim())) return false;
    const { protocol, hostname, href } = new URL(url.trim());
    if (protocol !== "http:") return false;
    const kind = httpHostKind(hostname);
    if (kind !== "lan-name") return kind === "public";
    if (typeof native.checkHttpHost !== "function") return false;
    const key = hostname.toLowerCase();
    const known = lanVerdicts.get(key);
    if ((!known || Date.now() - known.at > LAN_VERDICT_TTL_MS) && lanChecking !== key) {
        if (lanCheckTimer) clearTimeout(lanCheckTimer);
        lanChecking = key;
        lanCheckTimer = setTimeout(() => {
            lanCheckTimer = null;
            native.checkHttpHost(href).then(r => r?.lan ?? null, () => null).then(lan => {
                lanVerdicts.set(key, { lan, at: Date.now() });
                if (lanChecking === key) lanChecking = null;
                notifyHttpPrefs();
            });
        }, 600);
    }
    return known?.lan === false;
}

type NativeUploadResult = import("../native").CustomUploadResponse;

function noteLanAddresses(url: string, addresses: readonly (string | undefined)[] | undefined): void {
    if (addresses?.some(address => address && isPrivateAddress(address)) && URL.canParse(url)) rememberLanOrigin(new URL(url).origin);
}

const ZEROX0_USER_AGENT = "BigFileUpload (+https://github.com/ScattrdBlade/bigFileUpload)";

export function withZeroX0Agent(url: string, options: NativeUploadRequestOptions): NativeUploadRequestOptions {
    if (!URL.canParse(url) || new URL(url).hostname !== "0x0.st") return options;
    if (Object.keys(options.headers ?? {}).some(name => name.toLowerCase() === "user-agent")) return options;
    return { ...options, headers: { ...options.headers, "User-Agent": ZEROX0_USER_AGENT } };
}

async function originApproved(url: string): Promise<boolean> {
    const native = Native;
    const target = URL.canParse(url) ? new URL(url) : null;
    if (typeof native?.requestOriginApproval !== "function" || !/^https?:$/.test(target?.protocol ?? "") || isBuiltInOrigin(url)) return true;
    return await native.requestOriginApproval(url).catch(() => null) !== "cancelled";
}

async function approveOrigin(url: string): Promise<void> {
    if (await originApproved(url)) return;
    cancelRequested = true;
    throw new UploadCancelledError();
}

export async function listApprovedServers(): Promise<string[] | null> {
    if (typeof Native?.listApprovedOrigins !== "function") return null;
    return Native.listApprovedOrigins().catch(() => []);
}

export async function resetApprovedServers(): Promise<boolean> {
    return await Native?.forgetApprovedOrigins?.().catch(() => false) === true;
}

async function nativeAttempt(url: string, options: NativeUploadRequestOptions, fileBlob: RequestBody | null, viaProxy = false): Promise<NativeUploadResult> {
    const insecureOrigin = viaProxy ? undefined : insecureOriginFor(url);
    const refusal = viaProxy ? null : httpRefusal(url, insecureOrigin);
    if (refusal) throw new Error(refusal);
    await approveOrigin(url);
    const body = fileBlob ? await nativeBody(fileBlob) : new ArrayBuffer(0);
    const service = currentAttemptService;
    const user = !viaProxy && service !== null && SERVICES[service]?.web === "user";
    const result = await Native!.customUploadRequest({
        url, ...withZeroX0Agent(url, options), stallTimeoutMs: getUploadTimeoutMs(),
        ...insecureOrigin && { insecureOrigin }, ...viaProxy && { viaProxy: true }, ...user && { resolveAddresses: true }
    }, body);
    if (result.busy) throw new NativeBusyError(result.error);
    if (!result.success && result.cancelled) throw new UploadCancelledError();
    if (result.error) result.error = redactText(result.error);
    if (user) noteLanAddresses(url, result.success ? [result.remoteAddress] : result.failure?.addresses);
    return result;
}

function nativeResponse(result: NativeUploadResult, url: string): UploadHttpResponse {
    if (!result.success) {
        const { failure } = result;
        if (result.code === "stalled") throw new TransportError(result.error || "No upload progress", "timeout", false, failure?.stage === "response", failure ? failure.stage !== "connect" : true, false);
        if (failure) throw new TransportError(result.error || "Upload failed", "network", false, failure.stage === "response", failure.stage !== "connect", failedBeforeSending(failure));
        throw new Error(result.error || "Upload failed");
    }
    if (result.responseTruncated) logger.warn(`The answer from ${describeRequestTarget(url)} was cut off at 1 MiB`);

    const status = result.status ?? 0;
    const text = result.responseText ?? "";
    const headers = new Headers();
    if (result.headers) {
        for (const [name, value] of result.headers) {
            try {
                headers.append(name, value);
            } catch { }
        }
    } else {
        if (result.contentType) headers.set("content-type", result.contentType);
        if (result.retryAfter) headers.set("retry-after", result.retryAfter);
        if (result.etag) headers.set("etag", result.etag);
    }
    const answeredFrom = result.url && URL.canParse(result.url) && URL.canParse(url) && new URL(result.url).origin === new URL(url).origin ? result.url : url;

    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: result.statusText ?? "",
        headers,
        url: answeredFrom,
        text: async () => text,
        json: async () => parseJsonAnswer(text, result.contentType)
    };
}

interface BlockCause {
    kind: "blocked" | "unreachable";
    page?: number;
    code?: string;
    addresses?: string[];
}

function blockedCause(result: NativeUploadResult): BlockCause | null {
    if (result.success) return result.block ? { kind: "blocked", page: result.status } : null;
    const failure = result.failure as UploadFailure | undefined;
    if (!failure?.kind || !PROXY_RETRY_KINDS.has(failure.kind)) return null;
    return { kind: failure.kind === "blocked" ? "blocked" : "unreachable", code: failure.code, addresses: failure.addresses };
}

type ProxyGate = { ok: true; } | { ok: false; reason: string | null; hint?: true; };

const NOT_CONFIRMED = "not confirmed for this host this session";

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

let proxyJob = { proxyUnreachable: false };

interface AttemptProxy {
    blockedHost: string;
    proxyHost: string;
    proxy: string;
    anonymous: boolean;
    remember: string | null;
}

let attemptProxy: AttemptProxy | null = null;

const pinnedOrigins = new Set<string>();

type ProxyNote = { reason: string | null; hint?: true; };

let proxyNote: ProxyNote | null = null;

const PLAIN_HEADERS: ReadonlySet<string> = new Set([
    "content-type", "accept", "accept-language", "user-agent", "cache-control", "ocs-apirequest", "x-zipline-folder",
    "if-none-match", "x-amz-date", "x-amz-content-sha256", "content-md5", "content-disposition",
    "content-range", "x-zipline-p-filename", "x-zipline-p-content-type", "x-zipline-p-content-length", "x-zipline-p-lastchunk",
    "x-zipline-p-token"
]);

function requestCredentials(service: ServiceType, { headers = {}, fields = {} }: NativeUploadRequestOptions): { authorization: boolean; other: boolean; } {
    const named = Object.entries(headers).filter(([, value]) => String(value).trim() !== "").map(([name]) => name.toLowerCase());
    const field = service === ServiceType.ENCRYPTINGHOST ? Boolean(fields.userKey?.trim())
        : service === ServiceType.SHAREX && Object.values(fields).some(value => String(value).trim() !== "");
    return { authorization: named.includes("authorization"), other: field || named.some(name => name !== "authorization" && !PLAIN_HEADERS.has(name)) };
}

function withoutOptionalCredentials(service: ServiceType, options: NativeUploadRequestOptions): { options: NativeUploadRequestOptions; anonymous: boolean; } {
    const optional = service === ServiceType.CATBOX ? "userhash" : service === ServiceType.GOFILE ? "token" : null;
    if (!optional || !options.fields?.[optional]) return { options, anonymous: false };
    const fields = { ...options.fields };
    delete fields[optional];
    return { options: { ...options, fields }, anonymous: true };
}

async function proxyCanReach(origin: string): Promise<boolean> {
    const native = Native;
    if (typeof native?.probeUrl !== "function") return false;
    const active = getActiveCorsProxyUrl();
    const result = await native.probeUrl(toProxiedUrl(`${origin}/`, active), "HEAD").catch(() => null);
    const status = result?.ok ? result.status ?? 0 : 0;
    if (!status) return false;
    return isWorkersProxy(active) ? status < 520 || status > 530 : status >= 200 && status < 400;
}

interface GateRequest {
    service: ServiceType;
    url: string;
    options: NativeUploadRequestOptions;
    bodyBytes: number;
    proxyRetry?: "deny";
    cause: BlockCause | null;
}

async function decideDesktopProxy({ service, url, options, bodyBytes, proxyRetry, cause }: GateRequest): Promise<ProxyGate> {
    const refuse = (reason: string | null, hint?: true): ProxyGate => ({ ok: false, reason, ...hint && { hint } });
    const info = SERVICES[service];
    if (!Native || !info || !URL.canParse(url) || isOffline()) return refuse(null);
    const consented = proxyConsentGiven();
    const pending = !consented && peekDeviceProxyAnswer()?.answer !== "declined" && consentPending();
    if (!consented && !pending) return refuse(null);
    const target = new URL(url);
    if (info.web === "unsupported") return refuse(`${info.label} refuses the CORS proxy's network`);
    if (proxyRetry === "deny") return refuse("this request was signed for a direct connection");
    if (!isProxyReachableHost(target.hostname)) return refuse("the host is on your own network");
    if (target.protocol !== "https:" || insecureHttpOrigin(service)) return refuse("the upload address isn't https");
    await loadProxyOrigins();
    if (info.web === "user" && (isLanOrigin(target.origin) || cause?.addresses?.some(isPrivateAddress))) {
        rememberLanOrigin(target.origin);
        return refuse("the host was seen on your own network");
    }
    if (hasSecretQuery(target) || target.username || target.password) return refuse("the upload URL contains a key");
    if (!consented) return refuse(null, true);
    const active = getActiveCorsProxyUrl();
    const proxied = new URL(toProxiedUrl(url, active));
    if (proxied.protocol !== "https:") return refuse("the CORS proxy isn't https");
    if (proxied.origin === target.origin) return refuse("the host is the CORS proxy itself");
    if (proxyJob.proxyUnreachable) return refuse("the CORS proxy couldn't be reached for this file");
    const limit = proxyBodyLimit(active);
    if (limit != null && bodyBytes > limit) return refuse(`over the CORS proxy's limit (about ${formatSize(limit, true)})`);
    const credentials = requestCredentials(service, options);
    if (!proxyRedirectsSafe()) {
        if (findProxyPreset(active)) {
            if (credentials.other) return refuse("the CORS proxy would forward this host's key on a redirect");
        } else if (credentials.authorization || credentials.other) {
            return refuse("your proxy may forward this host's credentials on a redirect");
        }
    }
    if (!needsOriginConfirmation(service)) return { ok: true };
    if (rerunConfirmed?.service === service && rerunConfirmed.origin === target.origin) return { ok: true };
    if (!alwaysRetryAllowed(service, target.origin) && !canOfferOriginRetry(service, target.origin)) return refuse(NOT_CONFIRMED);
    if (info.web === "user" && cause && isDnsCode(cause.code) && !await proxyCanReach(target.origin)) {
        return refuse(`the CORS proxy can't reach ${target.host} either. It may only exist on your home network`);
    }
    if (alwaysRetryAllowed(service, target.origin)) return { ok: true };
    return refuse(offerOriginRetry(service, target.origin) ? "waiting for your confirmation (click the notification)" : NOT_CONFIRMED);
}

function proxyFirstHere(service: ServiceType, origin: string): boolean {
    if (needsOriginConfirmation(service)) return false;
    const proxy = proxyFirstEntry(origin);
    if (proxy == null) return false;
    if (proxyConsentGiven() && proxy === proxyKey(getActiveCorsProxyUrl())) return true;
    dropProxyFirst(origin);
    return false;
}

function restartAttemptMonitor(): void {
    if (cancelRequested) throw new UploadCancelledError();
    attemptPoll?.stop();
    attemptPoll = pollNativeUploadProgress();
}

type ProxiedOutcome = { response: UploadHttpResponse; } | { failed: string; proxyDown: boolean; };

function describeProxyErrorPage(status: number, text: string, proxyUrl: string): "too-large" | "unreachable" | null {
    if (status === 413) return !isWorkersProxy(proxyUrl) && isCloudflareErrorPage(text) ? "too-large" : null;
    return proxyCouldNotReach(status, text) ? "unreachable" : null;
}

interface ProxiedRequest {
    service: ServiceType;
    idempotent?: boolean;
    blockedHost: string;
    remember: string | null;
    bodyBytes: number;
}

async function proxiedNativeRequest(url: string, { options, anonymous }: ReturnType<typeof withoutOptionalCredentials>, fileBlob: RequestBody | null, { service, idempotent, blockedHost, remember, bodyBytes }: ProxiedRequest): Promise<ProxiedOutcome> {
    const active = getActiveCorsProxyUrl();
    const proxyHost = describeProxy(active).host;
    const label = serviceLabel(service);
    rerouted = true;
    const result = await nativeAttempt(toProxiedUrl(url, active), options, fileBlob, true);
    if (!result.success) {
        if (result.failure?.stage === "response" && !idempotent && !cancelRequested) {
            throw new CommittedUploadError(`${label} may already have received the file through the CORS proxy, but no link came back. No other host was tried`);
        }
        if (result.failure || result.code === "stalled") {
            proxyJob.proxyUnreachable = true;
            return { failed: `the retry through the CORS proxy (${proxyHost}) failed too: ${result.error || "network error"}`, proxyDown: true };
        }
        return { response: nativeResponse(result, url) };
    }
    const page = describeProxyErrorPage(result.status ?? 0, result.responseText ?? "", active);
    if (page === "too-large") throw new Error(`The CORS proxy (${proxyHost}) refused a file this big (${formatSize(bodyBytes)})`);
    if (page === "unreachable") return { failed: `the CORS proxy couldn't reach ${blockedHost} either`, proxyDown: false };
    attemptProxy = {
        blockedHost, proxyHost, proxy: proxyKey(active) ?? "",
        anonymous: anonymous || Boolean(attemptProxy?.anonymous),
        remember: remember ?? attemptProxy?.remember ?? null
    };
    return { response: nativeResponse(result, url) };
}

async function nativeServiceRequest(url: string, options: ServiceRequestOptions, fileBlob: RequestBody | null): Promise<UploadHttpResponse> {
    const { idempotent, proxyRetry, ...rest } = options;
    const requestOptions: NativeUploadRequestOptions = { ...rest, fileContentType: fileBlob?.type || undefined };
    const service = currentAttemptService;
    if (!service || !URL.canParse(url)) return nativeResponse(await nativeAttempt(url, requestOptions, fileBlob), url);
    const { origin, host } = new URL(url);
    const bodyBytes = fileBlob ? bodySize({ name: requestOptions.filename ?? "", size: fileBlob.size }, service) : 0;
    const label = serviceLabel(service);
    const anonymousOptions = withoutOptionalCredentials(service, requestOptions);
    await approveOrigin(url);

    const pinned = pinnedOrigins.has(origin);
    const confirmed = rerunConfirmed?.service === service && rerunConfirmed.origin === origin;
    const proxyFirst = !pinned && !confirmed && proxyFirstHere(service, origin);
    if (pinned || confirmed || proxyFirst) {
        const gate = await decideDesktopProxy({ service, url, options: anonymousOptions.options, bodyBytes, proxyRetry, cause: null });
        if (gate.ok) {
            if (confirmed && !pinned) {
                pinnedOrigins.add(origin);
            }
            if (proxyFirst || confirmed) setUploadState({ status: `Uploading through the CORS proxy (${host} was blocked on this network)...` });
            const outcome = await proxiedNativeRequest(url, anonymousOptions, fileBlob, { service, idempotent, blockedHost: host, remember: null, bodyBytes });
            if ("response" in outcome) return outcome.response;
            if (!proxyFirst) throw new TransportError(`${label}: ${outcome.failed}`, "network", false, false, true, false);
            dropProxyFirst(origin);
            rerouted = false;
            restartAttemptMonitor();
        } else if (gate.reason !== null || gate.hint) {
            proxyNote = gate;
        }
    }

    const result = await nativeAttempt(url, requestOptions, fileBlob);
    const cause = blockedCause(result);
    if (!cause) return nativeResponse(result, url);
    const gate = await decideDesktopProxy({ service, url, options: anonymousOptions.options, bodyBytes, proxyRetry, cause });
    if (!gate.ok) {
        proxyNote = gate;
        return nativeResponse(result, url);
    }

    const active = getActiveCorsProxyUrl();
    const why = cause.page ? `${host} answered with a block page (${cause.page})` : cause.kind === "blocked" ? `${host} is blocked on this network` : `Couldn't reach ${host}`;
    logger.warn(`${why}; retrying once through the CORS proxy`);
    setUploadState({ status: `${why}. Retrying through the CORS proxy (${describeProxy(active).host})...`, percent: 0, transferredBytes: 0 });
    restartAttemptMonitor();
    pinnedOrigins.add(origin);
    const remember = cause.kind === "blocked" && !needsOriginConfirmation(service) ? origin : null;
    const outcome = await proxiedNativeRequest(url, anonymousOptions, fileBlob, { service, idempotent, blockedHost: host, remember, bodyBytes });
    if ("response" in outcome) return outcome.response;
    const direct = result.success ? `${host} answered ${result.status} (a block page)` : result.error || "Upload failed";
    throw new TransportError(`${direct}; ${outcome.failed}`, "network", false, false, true, false);
}

type OfferItem = { kind: "file"; file: File; } | { kind: "url"; url: string; discordProxyUrl?: string; };

interface OriginOffer {
    service: ServiceType;
    origin: string;
    endpointOrigin: string | null;
    credentialPrint: Promise<string>;
    proxy: string;
    acceptId?: string;
    routing: string;
    items: OfferItem[];
    target: UploadTarget;
    job: UploadJob | null;
    stale: "expired" | "changed" | null;
    timer: ReturnType<typeof setTimeout>;
}

const OFFER_MS = 10 * 60 * 1000;

const offerKey = (service: string, origin: string) => `${service}\n${origin}`;

const offers = new Map<string, OriginOffer>();

const offeredOrigins = new Map<string, string | undefined>();

onAlwaysOriginsForgotten(entry => entry ? offeredOrigins.delete(offerKey(entry.service, entry.origin)) : offeredOrigins.clear());

let currentJob: UploadJob | null = null;

let currentTarget: UploadTarget | null = null;

let currentItem: OfferItem | null = null;

let rerunConfirmed: { service: ServiceType; origin: string; } | null = null;

const CREDENTIAL_KEYS: Partial<Record<ServiceType, string[]>> = {
    [ServiceType.ZIPLINE]: ["ziplineToken"],
    [ServiceType.NEST]: ["nestToken"],
    [ServiceType.EZHOST]: ["ezHostKey"],
    [ServiceType.ENCRYPTINGHOST]: ["encryptingHostKey"],
    [ServiceType.S3]: ["s3AccessKeyId", "s3SecretAccessKey", "s3SessionToken"],
    [ServiceType.PIXELVAULT]: ["pixelVaultKey"],
    [ServiceType.PIXELDRAIN]: ["pixelDrainKey"],
    [ServiceType.WEBDAV]: ["webdavUsername", "webdavPassword"],
    [ServiceType.SHAREX]: ["sharexConfig"]
};

const CREDENTIAL_NAMES: Partial<Record<ServiceType, string>> = {
    [ServiceType.ZIPLINE]: "your Zipline token",
    [ServiceType.NEST]: "your Nest token",
    [ServiceType.EZHOST]: "your E-Z Host key",
    [ServiceType.ENCRYPTINGHOST]: "your Encrypting.host key",
    [ServiceType.S3]: "your S3 request signatures",
    [ServiceType.PIXELVAULT]: "your PixelVault key",
    [ServiceType.PIXELDRAIN]: "your PixelDrain key",
    [ServiceType.WEBDAV]: "your WebDAV login",
    [ServiceType.SHAREX]: "your custom uploader's headers and fields"
};

function credentialPrint(service: ServiceType): Promise<string> {
    const values = (settings.plain ?? {}) as Record<string, unknown>;
    return sha256Hex(JSON.stringify((CREDENTIAL_KEYS[service] ?? []).map(key => values[key] ?? null)));
}

function endpointOriginOf(service: ServiceType): string | null {
    const raw = endpointOf(service)?.trim() ?? "";
    return URL.canParse(raw) ? new URL(raw).origin : null;
}

const currentRouting = () => routingSnapshot(withDeclaredDefaults(settings.plain ?? {}));

function staleOffer(offer: OriginOffer, why: OriginOffer["stale"]): void {
    clearTimeout(offer.timer);
    const key = offerKey(offer.service, offer.origin);
    if (offers.get(key) === offer) offers.delete(key);
    offer.stale ??= why;
    offer.items = [];
}

function joinableOffer(service: ServiceType, origin: string): OriginOffer | null {
    const open = offers.get(offerKey(service, origin));
    return open && !open.stale && open.job === currentJob ? open : null;
}

function canOfferOriginRetry(service: ServiceType, origin: string): boolean {
    if (joinableOffer(service, origin)) return true;
    const key = offerKey(service, origin);
    const asked = offeredOrigins.has(key) && offeredOrigins.get(key) === peekDeviceProxyAnswer()?.acceptId;
    return !asked && currentItem != null && currentTarget != null;
}

function offerOriginRetry(service: ServiceType, origin: string): boolean {
    const item = currentItem;
    const open = joinableOffer(service, origin);
    if (open) {
        if (item && !open.items.includes(item)) open.items.push(item);
        return true;
    }
    if (!canOfferOriginRetry(service, origin) || !item || !currentTarget) return false;
    const acceptId = peekDeviceProxyAnswer()?.acceptId;
    offeredOrigins.set(offerKey(service, origin), acceptId);
    const offer: OriginOffer = {
        service, origin,
        endpointOrigin: endpointOriginOf(service),
        credentialPrint: credentialPrint(service),
        proxy: proxyKey(getActiveCorsProxyUrl()) ?? "",
        acceptId,
        routing: currentRouting(),
        items: [item],
        target: currentTarget,
        job: currentJob,
        stale: null,
        timer: setTimeout(() => staleOffer(offer, "expired"), OFFER_MS)
    };
    offers.set(offerKey(service, origin), offer);
    notifyBlockedHost(`${serviceLabel(service)} is blocked on this network`, "Click to choose whether to retry it through the CORS proxy.", () => void openOriginRetry(offer));
    return true;
}

const settledItems = new WeakSet<OfferItem>();

function settleOfferItem(item: OfferItem | undefined): void {
    if (!item) return;
    settledItems.add(item);
    for (const offer of [...offers.values()]) {
        if (!offer.items.includes(item)) continue;
        offer.items = offer.items.filter(i => i !== item);
        if (!offer.items.length) staleOffer(offer, "expired");
    }
}

function staleOtherOffers(job: UploadJob): void {
    for (const offer of [...offers.values()]) if (offer.job !== job) staleOffer(offer, "expired");
}

export function noticeRoutingChange(): void {
    if (!offers.size) return;
    const routing = currentRouting();
    for (const offer of [...offers.values()]) if (offer.routing !== routing) staleOffer(offer, "changed");
}

const OFFER_EXPIRED = "That upload already finished or expired. Nothing was retried";

const OFFER_CHANGED = "That host's settings changed. Nothing was retried";

async function offerProblem(offer: OriginOffer): Promise<string | null> {
    const { store } = settings;
    const used = offer.service === store.serviceType || (!store.disableFallbacks && isFallbackActive(offer.service));
    if (!used) return OFFER_EXPIRED;
    if (offer.stale === "changed") return OFFER_CHANGED;
    if (offer.stale === "expired" || !offer.items.length) return OFFER_EXPIRED;
    if (offer.routing !== currentRouting() || endpointOriginOf(offer.service) !== offer.endpointOrigin
        || await credentialPrint(offer.service) !== await offer.credentialPrint) return OFFER_CHANGED;
    if (!proxyConsentGiven() || proxyKey(getActiveCorsProxyUrl()) !== offer.proxy || peekDeviceProxyAnswer()?.acceptId !== offer.acceptId) {
        return "The CORS proxy, or this device's answer about it, changed. Nothing was retried";
    }
    return null;
}

async function openOriginRetry(offer: OriginOffer): Promise<void> {
    try {
        window.focus();
    } catch { }
    const early = offer.stale || !offers.has(offerKey(offer.service, offer.origin)) ? await offerProblem(offer) ?? OFFER_EXPIRED : null;
    if (early) {
        showToast({ text: early });
        return;
    }
    const proxy = describeProxy(getActiveCorsProxyUrl());
    const { host } = new URL(offer.origin);
    const n = offer.items.length;
    const credential = carriesCredential(offer.service) ? CREDENTIAL_NAMES[offer.service] : undefined;
    const question = `${serviceLabel(offer.service)} at ${host} is blocked on this network. Retry ${n > 1 ? `these ${n} uploads` : "the upload"} once through the CORS proxy (${proxy.preset ? `${proxy.host}, run by ${proxy.operator}` : proxy.host})? Whoever runs it sees ${n > 1 ? "the files" : "the file"}${credential ? ` and ${credential}` : ""}.`;
    const answer = await askOriginRetry(host, question);
    if (!answer.retry) {
        staleOffer(offer, "expired");
        return;
    }
    const problem = await offerProblem(offer);
    if (problem) {
        staleOffer(offer, null);
        showToast({ text: problem });
        return;
    }
    if (answer.always) addAlwaysOrigin(offer.service, offer.origin);
    const { items, target, service, origin } = offer;
    staleOffer(offer, null);
    const offerSize = items.every(i => i.kind === "file") ? items.reduce((sum, i) => sum + (i.kind === "file" ? i.file.size : 0), 0) : null;
    void enqueueUpload(items.length > 1 ? `${items.length} files` : items[0].kind === "file" ? items[0].file.name : "the file", async job => {
        const pending = items.filter(i => !settledItems.has(i));
        if (!pending.length) {
            showToast({ text: OFFER_EXPIRED });
            return false;
        }
        const files = pending.flatMap(i => i.kind === "file" ? [i.file] : []);
        const links = pending.flatMap(i => i.kind === "url" ? [i] : []);
        rerunConfirmed = { service, origin };
        try {
            let ok = files.length ? await runFilesUpload(files, { ...target, automatic: false, stillWanted: undefined }, job) : true;
            for (const link of links) ok = await runUrlUpload(link.url, target, link.discordProxyUrl, job) && ok;
            return ok;
        } finally {
            rerunConfirmed = null;
        }
    }, items.flatMap(i => i.kind === "file" ? [i.file.name] : []), offerSize);
}

const announcedProxyHosts = new Set<string>();

function announceProxiedUpload({ blockedHost, proxyHost, anonymous }: AttemptProxy): void {
    if (announcedProxyHosts.has(blockedHost)) return;
    announcedProxyHosts.add(blockedHost);
    showToast({ text: `${blockedHost} is blocked on this network, so the upload went through the CORS proxy (${proxyHost})${anonymous ? " anonymously, so you can't delete it from your account" : ""}`, duration: 8000 });
}

interface SourceFailureFacts {
    policy?: true;
    failure?: UploadFailure;
    block?: true;
}

function sourceProxyAllowed(source: string, res: SourceFailureFacts): boolean {
    if (res.policy || !(res.block || (res.failure?.kind && PROXY_RETRY_KINDS.has(res.failure.kind)))) return false;
    if (!Native || !URL.canParse(source) || isOffline() || !proxyConsentGiven()) return false;
    const target = new URL(source);
    if (target.protocol !== "https:" || !proxySourceAllowed(target)) return false;
    const proxied = new URL(toProxiedUrl(source, getActiveCorsProxyUrl()));
    return proxied.protocol === "https:" && proxied.origin !== target.origin;
}

async function fetchFileThroughProxy<T>(source: string, download: (viaProxy: string) => Promise<T>): Promise<T> {
    const active = getActiveCorsProxyUrl();
    setUploadState({ status: `${describeRequestTarget(source)} is blocked on this network. Downloading through the CORS proxy (${describeProxy(active).host})...` });
    const stopPoll = pollNativeDownload();
    try {
        return await download(toProxiedUrl(source, active));
    } finally {
        stopPoll();
    }
}

type ServiceRequestOptions = Omit<NativeUploadRequestOptions, "fileContentType"> & Pick<S3RequestOptions, "idempotent" | "proxyRetry">;

interface RequestOutcome {
    status?: number;
    retryAfter?: string | null;
    error?: TransportError;
    rerouted?: boolean;
}

let lastOutcome: RequestOutcome | null = null;

let rerouted = false;

let proxyPinned: ServiceType | null = null;

async function serviceUploadRequest(url: string, options: ServiceRequestOptions, fileBlob: RequestBody | null): Promise<UploadHttpResponse> {
    lastOutcome = null;
    rerouted = false;
    try {
        const response = await sendServiceRequest(url, options, fileBlob);
        lastOutcome = { status: response.status, retryAfter: response.headers.get("retry-after"), rerouted };
        return response;
    } catch (error) {
        lastOutcome = error instanceof TransportError ? { error, rerouted } : null;
        throw error;
    }
}

function redirectedTo(requested: string, responseUrl: string): string | null {
    if (!responseUrl || !URL.canParse(requested) || !URL.canParse(responseUrl)) return null;
    const comparable = (raw: string) => {
        const parsed = new URL(raw);
        parsed.hash = parsed.username = parsed.password = "";
        return parsed.href;
    };
    if (comparable(requested) === comparable(responseUrl)) return null;
    const final = new URL(responseUrl);
    return final.origin + final.pathname;
}

async function sendServiceRequest(url: string, options: ServiceRequestOptions, fileBlob: RequestBody | null): Promise<UploadHttpResponse> {
    if (Native) return nativeServiceRequest(url, options, fileBlob);
    const { idempotent, proxyRetry, ...requestOptions } = options;

    if (fileBlob && !(fileBlob instanceof Blob)) throw new Error("A file prepared for the desktop app can't be sent from here");

    const { method = "POST", headers = {}, bodyType, fields = {}, fileFieldName = "file", filename = "upload.bin" } = requestOptions;

    const requestHeaders = new Headers(headers);
    let body: BodyInit;
    const multipart = (skip?: string) => {
        const formData = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            if (key !== skip) formData.append(key, value);
        }
        if (fileBlob) {
            formData.append(fileFieldName, fileBlob, filename);
        }
        return formData;
    };

    if (bodyType === "multipart") {
        requestHeaders.delete("content-type");
        body = multipart();
    } else if (bodyType === "binary") {
        body = fileBlob ?? "";
    } else {
        if (!requestHeaders.has("content-type")) {
            requestHeaders.set("content-type", "application/json");
        }
        body = JSON.stringify(fields);
    }

    const service = currentAttemptService;
    const route = requestRoute(service);
    const label = service ? serviceLabel(service) : describeRequestTarget(url);
    const bodyBytes = fileBlob ? service ? bodySize({ name: filename, size: fileBlob.size }, service) : fileBlob.size : 0;
    if (route === "simple") setUploadState({ indeterminate: true });
    const proxiedBody = bodyType === "multipart" && service === ServiceType.GOFILE && fields.token !== undefined && fields.token === gofileGuestToken()
        ? multipart("token") : body;

    const send = async (viaProxy: boolean) => {
        try {
            return await uploadRequestWithTimeout(viaProxy ? viaCorsProxy(url) : url, { method, headers: requestHeaders, body: viaProxy ? proxiedBody : body },
                { viaProxy, simple: route === "simple", bodyBytes });
        } catch (error) {
            if (error instanceof TransportError && viaProxy && error.bodySent && !idempotent && !cancelRequested) {
                throw new CommittedUploadError(`${label} may already have received the file through the CORS proxy, but no link came back. No other host was tried`);
            }
            throw error;
        }
    };

    const pinned = route === "direct" && service !== null && proxyPinned === service && proxyFor(service) && withinProxyLimit(bodyBytes);
    let viaProxy = route === "proxy" || pinned;
    if (viaProxy && proxyRetry === "deny") {
        throw new Error("This request was signed for a direct connection, so it isn't sent through the CORS proxy. Try the upload again");
    }
    rerouted = pinned;
    let response: XhrResponse;
    try {
        response = await send(viaProxy);
    } catch (error) {
        const preflightFailed = error instanceof TransportError && error.kind === "network" && !error.sentAny;
        if (!(preflightFailed && !pinned && route === "direct" && service && SERVICES[service]?.web === "direct"
            && proxyFor(service) && withinProxyLimit(bodyBytes) && !cancelRequested && proxyRetry !== "deny")) throw error;
        logger.warn(`${label} refused a direct request. Retrying once through the CORS proxy`);
        setUploadState({ status: `${label} refused a direct request. Retrying through the CORS proxy...` });
        viaProxy = rerouted = true;
        proxyPinned = service;
        response = await send(true);
    }

    // XHR follows a redirect silently, and a 301 to 303 turns the upload into a GET that drops the file
    const final = viaProxy ? null : redirectedTo(url, response.url);
    if (final) throw new Error(`Upload endpoint redirected to ${final}. Update the configured URL to the final address`);
    if (viaProxy || !response.url) response.url = url;

    if (viaProxy && response.status === 413 && isCloudflareErrorPage(await response.text())) {
        throw new Error(`The CORS proxy (${describeRequestTarget(getActiveCorsProxyUrl())}) refused a file this big (${formatSize(bodyBytes)})`);
    }
    return response;
}

function withoutUserinfo(url: URL): string {
    url.username = "";
    url.password = "";
    return url.href;
}

// trim() and \s also strip U+FEFF, which Encrypting.host's zero-width links can end in
export function trimAscii(value: string): string {
    return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function isSingleHttpUrl(value: string): boolean {
    if (!value || value.length > 2048 || /[\x00-\x20\x7f\\<>]/.test(value) || !URL.canParse(value)) return false;
    const { protocol, hostname } = new URL(value);
    return (protocol === "https:" || protocol === "http:") && hostname !== "";
}

// new URL().href would percent-encode zero-width characters
export function validateUploadedUrl(raw: unknown, service: ServiceType): string {
    const value = typeof raw === "string" ? trimAscii(raw) : "";
    const inner = /^\[[^\]]*\]\(([^)]*)\)$/.exec(value)?.[1];
    if (isSingleHttpUrl(inner ?? value)) return value;
    throw new Error(`${serviceLabel(service)} returned an unexpected response`);
}

async function readPlainTextUrl(response: UploadHttpResponse): Promise<string> {
    if (!response.ok) throw await httpFailure(response);
    const text = trimAscii(await response.text());
    if (!text) {
        throw new Error("The host returned no link");
    }
    return text;
}

async function readTextAndJson(response: UploadHttpResponse): Promise<{ text: string; json: unknown; }> {
    const text = await response.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { text, json };
}

function parseShareXConfigFromSettings(): ShareXUploaderConfig {
    const configText = settings.store.sharexConfig || "";
    if (!configText.trim()) {
        throw new Error("ShareX config is required");
    }

    const config = parseShareXConfig(configText);
    validateShareXConfig(config);
    return config;
}

async function buildShareXRequestUrl(config: ShareXUploaderConfig, filename: string): Promise<string> {
    const base = await resolveShareXRequestValue(config.RequestURL!.trim(), filename, { config, urlEncode: true, field: "RequestURL" });
    const params = config.Parameters;
    if (!params || typeof params !== "object" || !Object.keys(params).length) {
        return base;
    }

    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, await resolveShareXRequestValue(value as string | number | boolean, filename, { config, field: `Parameters.${key}` }));
    }
    return url.toString();
}

interface Kept {
    deletion?: Deletion;
    endpointOrigin?: string;
    s3?: HistoryEntry["s3"];
}

let attemptKept: Kept = {};

interface KeptNow extends Kept {
    anonymous: boolean;
}

const keptNow = (): KeptNow => ({ ...attemptKept, anonymous: Boolean((attemptProxy as AttemptProxy | null)?.anonymous) });

const linkOf = (url: string) => /^\[[^\]]*\]\(([^)]*)\)$/.exec(url)?.[1] ?? url;

const builtInOrigin = (service: ServiceType) => SERVICES[service]?.apiHost ? `https://${SERVICES[service].apiHost}` : null;

function keepInHistory(url: string, service: ServiceType, size: number, kept: KeptNow, cancelled = false): string {
    const id = newHistoryId();
    void addHistoryEntry({
        id, url, service, time: Date.now(), size,
        endpoint: { service, origin: kept.endpointOrigin ?? builtInOrigin(service) },
        ...kept.s3 && { s3: kept.s3 },
        ...kept.deletion && !kept.anonymous && { deletion: kept.deletion },
        ...kept.anonymous && { anonymous: true as const },
        ...cancelled && { cancelled: true as const }
    });
    return id;
}

async function shareXDeletionUrl(config: ShareXUploaderConfig, requestUrl: string, responseText: string, responseJson: unknown, answer: Parameters<typeof resolveShareXTemplate>[3]): Promise<string | null> {
    let url: string;
    try {
        url = trimAscii(await resolveShareXTemplate(config.DeletionURL, responseText, responseJson, { ...answer, field: "DeletionURL" }) ?? "");
    } catch {
        return null;
    }
    if (!isSingleHttpUrl(url)) return null;
    rememberSessionSecret(url);
    const { protocol, origin } = new URL(url);
    return protocol === "https:" || (URL.canParse(requestUrl) && new URL(requestUrl).origin === origin) ? url : null;
}

async function uploadToShareX(fileBlob: UploadBody, filename: string): Promise<string> {
    const config = parseShareXConfigFromSettings();
    const method = (config.RequestMethod || "POST").toUpperCase();
    const requestUrl = await buildShareXRequestUrl(config, filename);
    const bodyType = (config.Body || "MultipartFormData").toLowerCase();
    const headers = await buildShareXHeaders(config, filename);

    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.Arguments || {})) {
        args[key] = await resolveShareXRequestValue(value as string | number | boolean, filename, { config, field: `Arguments.${key}` });
    }

    for (const value of [...Object.values(headers), ...Object.values(args), ...new URL(requestUrl).searchParams.values()]) rememberSessionSecret(value);

    const response = await serviceUploadRequest(requestUrl, bodyType === "binary"
        ? { method, headers, bodyType: "binary", filename }
        : { method, headers, bodyType: "multipart", fields: args, fileFieldName: config.FileFormName || "file", filename }, fileBlob);

    const responseText = await response.text();
    let responseJson: unknown = null;
    try {
        responseJson = responseText ? JSON.parse(responseText) : null;
    } catch {
        responseJson = null;
    }

    const answer = { config, url: response.url, headers: response.headers, filename };
    if (!response.ok) {
        let configuredError = "";
        try {
            configuredError = describeBody(await resolveShareXTemplate(config.ErrorMessage, responseText, responseJson, { ...answer, field: "ErrorMessage" }) ?? "");
        } catch { }
        throw configuredError ? new Error(configuredError) : await httpFailure(response, responseText);
    }

    const deletionUrl = await shareXDeletionUrl(config, requestUrl, responseText, responseJson, answer);
    attemptKept = {
        ...deletionUrl && { deletion: { kind: "sharex", url: deletionUrl } },
        ...URL.canParse(requestUrl) && { endpointOrigin: new URL(requestUrl).origin }
    };
    const configuredUrl = trimAscii(await resolveShareXTemplate(config.URL, responseText, responseJson, answer) ?? "");
    const fallbackUrl = typeof responseJson === "object" && responseJson && "url" in responseJson
        ? String((responseJson as Record<string, unknown>).url || "")
        : responseText;

    const resultUrl = trimAscii(configuredUrl || fallbackUrl);
    if (!resultUrl) {
        throw new Error("The custom uploader returned no link");
    }

    if (/^\.{0,2}\//.test(resultUrl) && !/[\x00-\x20]/.test(resultUrl)) {
        try {
            return withoutUserinfo(new URL(resultUrl, requestUrl));
        } catch { }
    }

    return resultUrl;
}

export interface ZiplineCaps {
    maxFileSize: number | null;
    chunks: { max: number; size: number; } | null;
}

const ZIPLINE_PROBE_MS = 5000;

const ZIPLINE_RECHECK_MS = 10 * 60 * 1000;

const ZIPLINE_MAX_CHUNKS = 10_000;

const ZIPLINE_PENDING_CHECKS = 10;

const ZIPLINE_PENDING_GAP_MS = 1000;

const ZIPLINE_PENDING_MAX_MS = 15000;

const ziplineCaps = new Map<string, { caps: ZiplineCaps | null; answered: boolean; at: number; }>();

const ziplineBase = (serviceUrl: string) => serviceUrl.replace(/\/+$/, "");

const BYTE_UNITS = ["b", "kb", "mb", "gb", "tb", "pb"];

export function parseZiplineBytes(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?\s*$/i.exec(value);
    if (!match) return null;
    const bytes = Math.floor(Number(match[1]) * 1024 ** BYTE_UNITS.indexOf((match[2] ?? "b").toLowerCase()));
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

export function parseZiplineCaps(status: number | undefined, body: string | undefined): ZiplineCaps {
    const none: ZiplineCaps = { maxFileSize: null, chunks: null };
    if (status !== 200 || !body) return none;
    let files: unknown, chunks: unknown;
    try {
        const data = JSON.parse(body) as { files?: unknown; chunks?: unknown; } | null;
        files = data?.files;
        chunks = data?.chunks;
    } catch {
        const object = (key: string) => {
            const inner = new RegExp(`"${key}"\\s*:\\s*(\\{[^{}]*\\})`).exec(body)?.[1];
            try {
                return inner ? JSON.parse(inner) : undefined;
            } catch {
                return undefined;
            }
        };
        files = object("files");
        chunks = object("chunks");
    }
    const maxFileSize = parseZiplineBytes((files as { maxFileSize?: unknown; } | undefined)?.maxFileSize);
    const c = chunks as { enabled?: unknown; max?: unknown; size?: unknown; } | undefined;
    const max = parseZiplineBytes(c?.max);
    const size = parseZiplineBytes(c?.size);
    return { maxFileSize, chunks: c?.enabled === true && max && size ? { max, size } : null };
}

async function discoverZipline(serviceUrl: string): Promise<ZiplineCaps | null> {
    const native = Native;
    const probe = ziplineProbeUrl(serviceUrl);
    if (!probe || typeof native?.probeUrl !== "function") return ziplineCaps.get(ziplineBase(serviceUrl))?.caps ?? null;
    const result = await native.probeUrl(probe, "GET", undefined, ZIPLINE_PROBE_MS).catch(() => null);
    const status = result?.ok ? result.status ?? 0 : 0;
    const answered = status >= 200 && status < 500 && status !== 408 && status !== 429;
    const caps = answered ? parseZiplineCaps(status, result?.body) : null;
    ziplineCaps.set(ziplineBase(serviceUrl), { caps, answered, at: Date.now() });
    return caps;
}

function ziplineProbeUrl(serviceUrl: string): string | null {
    const base = ziplineBase(serviceUrl);
    const known = ziplineCaps.get(base);
    if (known && (known.answered || Date.now() - known.at < ZIPLINE_RECHECK_MS)) return null;
    if (typeof Native?.probeUrl !== "function" || isOffline() || !URL.canParse(`${base}/api/server/public`)) return null;
    const url = new URL(`${base}/api/server/public`);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (proxyFirstEntry(url.origin) !== null || isHostDown(url.origin)) return null;
    return url.href;
}

export function ziplineMaxBytes(): number | null {
    const url = (settings.plain as Record<string, unknown> | undefined)?.serviceUrl;
    return typeof url === "string" && url ? ziplineCaps.get(ziplineBase(url))?.caps?.maxFileSize ?? null : null;
}

type ZiplineAnswer = { files?: (string | { url?: string; pending?: boolean; })[]; partialToken?: unknown; partialIdentifier?: unknown; };

async function readZiplineAnswer(response: UploadHttpResponse): Promise<ZiplineAnswer> {
    if (!response.ok) throw await httpFailure(response);
    if (!(response.headers.get("content-type") || "").includes("application/json")) {
        throw new Error("The host's answer isn't JSON");
    }
    return await response.json() as ZiplineAnswer;
}

// Zipline v4 returns { files: [{ url }] }, v3.x returns { files: ["url"] }
async function ziplineLink(data: ZiplineAnswer): Promise<string> {
    const first = data.files?.[0];
    const url = typeof first === "string" ? first : first?.url;
    if (!url) throw new Error("The host returned no link");
    if (typeof first === "object" && first?.pending === true) await waitForZiplineFile(url);
    return url;
}

async function waitForZiplineFile(url: string): Promise<void> {
    const native = Native;
    if (cancelRequested || typeof native?.probeUrl !== "function" || !URL.canParse(url) || new URL(url).protocol !== "https:") return;
    let stop = () => { };
    const stopped = new Promise<null>(resolve => { stop = () => resolve(null); });
    stopEmbedWait = stop;
    const { status } = uploadState;
    setUploadState({ status: `Waiting for ${serviceLabel(ServiceType.ZIPLINE)} to finish processing the file...`, canCancel: true });
    const end = Date.now() + ZIPLINE_PENDING_MAX_MS;
    try {
        for (let i = 0; i < ZIPLINE_PENDING_CHECKS && !cancelRequested; i++) {
            if (i) await Promise.race([new Promise(resolve => setTimeout(resolve, ZIPLINE_PENDING_GAP_MS)), stopped]);
            const left = end - Date.now();
            if (cancelRequested || left < 1000) break;
            const result = await Promise.race([native.probeUrl(url, "HEAD", undefined, Math.min(ZIPLINE_PROBE_MS, left)).catch(() => null), stopped]);
            if (!result?.ok || result.status !== 404) return;
        }
        if (!cancelRequested) logger.info("Zipline is still processing the file. Posting its link anyway");
    } finally {
        stopEmbedWait = null;
        if (!cancelRequested) setUploadState({ status });
    }
}

async function canChunk(body: UploadBody, chunkSize: number): Promise<boolean> {
    if (Math.ceil(body.size / chunkSize) > ZIPLINE_MAX_CHUNKS) return false;
    if (!Native || isSpooled(body)) return true;
    return canSpool() && await spoolFor(body) !== null;
}

function postMultipart(url: string, file: RequestBody, filename: string, options: { headers?: Record<string, string>; fields?: Record<string, string>; fileFieldName?: string; } = {}): Promise<UploadHttpResponse> {
    return serviceUploadRequest(url, { method: "POST", bodyType: "multipart", fileFieldName: "file", filename, ...options }, file);
}

async function uploadZiplineChunks(base: string, headers: Record<string, string>, body: UploadBody, filename: string, chunkSize: number): Promise<string | null> {
    const total = body.size;
    const parts = Math.ceil(total / chunkSize);
    let token: string | null = null;
    try {
        for (let n = 0; n < parts; n++) {
            if (cancelRequested) throw new UploadCancelledError();
            const offset = n * chunkSize;
            const length = Math.min(chunkSize, total - offset);
            const last = n === parts - 1;
            multipart = { done: offset, total, part: n + 1, parts, last };
            setUploadState({ phase: "uploading", status: uploadingStatus(), ...n === 0 && { percent: 0, transferredBytes: 0, totalBytes: total } });
            const { body: part } = await partOf(body, offset, length, false);
            const response = await postMultipart(`${base}/api/upload/partial`, part, filename, {
        headers: {
                    ...headers,
                    ...token && { "x-zipline-p-token": token },
                    "x-zipline-p-filename": encodeURIComponent(filename),
                    "x-zipline-p-content-type": body.type || "application/octet-stream",
                    "x-zipline-p-content-length": String(total),
                    "x-zipline-p-lastchunk": String(last),
                    "content-range": `bytes ${offset}-${offset + length - 1}/${total}`
                }
    });
            const data = await readZiplineAnswer(response);
            if (last) {
                multipart = null;
                return await ziplineLink(data);
            }
            if (typeof data.partialToken === "string" && data.partialToken) {
                token = data.partialToken;
                rememberSessionSecret(token, true);
                continue;
            }
            if (n === 0 && typeof data.partialIdentifier === "string") {
                const known = ziplineCaps.get(base);
                if (known?.caps) known.caps = { ...known.caps, chunks: null };
                logger.info("This Zipline uses the partial-upload protocol from before v4.8. Sending the file whole");
                return null;
            }
            throw new Error("Zipline's answer to a chunk had no token for the next one");
        }
        throw new Error("The host returned no link");
    } finally {
        multipart = null;
    }
}

async function uploadToZipline(fileBlob: UploadBody, filename: string): Promise<string> {
    const { serviceUrl, ziplineToken, folderId } = settings.store;

    if (!serviceUrl || !ziplineToken) {
        throw new Error("Zipline Service URL and token are required");
    }

    const baseUrl = ziplineBase(serviceUrl);

    const headers: Record<string, string> = {
        "Authorization": ziplineToken
    };

    if (folderId) {
        headers["x-zipline-folder"] = folderId;
    }

    const chunks = ziplineCaps.get(baseUrl)?.caps?.chunks;
    if (chunks && fileBlob.size > chunks.max && await canChunk(fileBlob, chunks.size)) {
        const url = await uploadZiplineChunks(baseUrl, headers, fileBlob, filename, chunks.size);
        if (url !== null) return url;
        if (cancelRequested) throw new UploadCancelledError();
    }

    const response = await postMultipart(`${baseUrl}/api/upload`, fileBlob, filename, {
        headers
    });

    return ziplineLink(await readZiplineAnswer(response));
}

async function uploadToNest(fileBlob: UploadBody, filename: string): Promise<string> {
    const { nestToken } = settings.store;

    if (!nestToken) {
        throw new Error("Nest token is required");
    }

    const response = await postMultipart("https://nest.rip/api/files/upload", fileBlob, filename, {
        headers: {
            "Authorization": nestToken
        }
    });

    if (!response.ok) throw await httpFailure(response);

    const data = await response.json() as { fileURL?: string; };

    if (data.fileURL) {
        return data.fileURL;
    }

    throw new Error("The host returned no link");
}

const ENCRYPTING_HOST_STYLES = ["query", "param", "fakelink", "embed", "zws"] as const;

type EncryptingHostUrlStyle = typeof ENCRYPTING_HOST_STYLES[number];

const isEncryptingHostStyle = (style: string): style is EncryptingHostUrlStyle => (ENCRYPTING_HOST_STYLES as readonly string[]).includes(style);

function getEncryptingHostConfig(): {
    key: string;
    urlStyle: EncryptingHostUrlStyle;
    domains: string[];
    title: string;
    color: string;
    fakelink: string;
} {
    const {
        encryptingHostKey,
        encryptingHostUrlStyle,
        encryptingHostDomains,
        encryptingHostTitle,
        encryptingHostColor,
        encryptingHostFakelink
    } = settings.store;

    const key = encryptingHostKey?.trim() || "";
    if (!key) {
        throw new Error("Encrypting.host API key is required");
    }

    const style = encryptingHostUrlStyle || "query";
    if (!isEncryptingHostStyle(style)) {
        throw new Error("Invalid Encrypting.host URL style");
    }

    const domainsRaw = encryptingHostDomains?.trim() || "[\"normal\"]";

    return {
        key,
        urlStyle: style,
        domains: parseEncryptingHostDomains(domainsRaw),
        title: style === "embed" || style === "zws" ? encryptingHostTitle?.trim() || "" : "",
        color: style === "embed" ? encryptingHostColor?.trim().replace(/^#/, "") || "" : "",
        fakelink: style === "fakelink" ? encryptingHostFakelink?.trim() || "" : ""
    };
}

async function uploadToEncryptingHost(fileBlob: UploadBody, filename: string): Promise<string> {
    const config = getEncryptingHostConfig();

    const fields: Record<string, string> = {
        password: randomHexBytes(16),
        userKey: config.key,
        urlStyle: config.urlStyle,
        domains: JSON.stringify(config.domains)
    };
    if (config.title) {
        fields.title = config.title;
    }
    if (config.color) {
        fields.color = config.color;
    }
    if (config.fakelink) {
        fields.fakelink = config.fakelink;
    }

    const response = await postMultipart("https://encrypting.host/upload", fileBlob, filename, {
        fields
    });

    const { text, json } = await readTextAndJson(response);
    const data = json as { url?: string; error?: string; } | null;

    if (!response.ok) throw await httpFailure(response, text);

    const parsedUrl = typeof data?.url === "string" ? trimAscii(data.url) : "";
    const fallbackUrl = trimAscii(text).startsWith("http") ? trimAscii(text) : "";
    const url = parsedUrl || fallbackUrl;
    if (!url) {
        throw new Error("The host returned no link");
    }

    return url;
}

const pixelDrainErrors: Record<string, string> = {
    authentication_required: PIXELDRAIN_KEY_REQUIRED,
    authentication_failed: "PixelDrain rejected the API key (invalid, revoked or expired)"
};

export interface ConfigProblem {
    kind: "credentials" | "platform" | "consent";
    message: string;
}

const PROBLEM_ORDER: readonly ConfigProblem["kind"][] = ["platform", "credentials", "consent"];

export function getServiceConfigProblems(service: ServiceType): ConfigProblem[] {
    if (!Object.hasOwn(SERVICES, service)) return [{ kind: "platform", message: `${service} isn't a host this version of BigFileUpload knows` }];
    const info = SERVICES[service];

    const problems: ConfigProblem[] = [];
    if (!Native && info.web === "unsupported") problems.push({ kind: "platform", message: `${info.label} doesn't work on Vencord Web` });
    if (needsProxyHere(service)) problems.push({ kind: "platform", message: `${info.label} needs ${neededProxy()}` });
    for (const message of credentialProblems(service, settings.store as CredentialValues)) problems.push({ kind: "credentials", message });
    if (!Native && info.web === "proxy" && proxyAllowedHere() && credentialHeldBack(service)) {
        problems.push({ kind: "consent", message: `${info.label} with your credential is waiting for your CORS-proxy answer (BigFileUpload asks at the next start)` });
    }
    return problems;
}

export function getServiceConfigError(service: ServiceType): string | null {
    const problems = getServiceConfigProblems(service);
    for (const kind of PROBLEM_ORDER) {
        const problem = problems.find(p => p.kind === kind);
        if (problem) return problem.message;
    }
    return null;
}

export const isHostConfigured = (service: ServiceType) => !getServiceConfigProblems(service).some(p => p.kind === "credentials");

export const isUsableHere = (service: ServiceType) => !getServiceConfigProblems(service).some(p => p.kind === "platform");

function selectedHost(): ServiceType {
    ensureMigrated();
    return settings.store.serviceType as ServiceType;
}

export function isPrimaryReady(): boolean {
    return isHostConfigured(selectedHost());
}

export const primaryNotReadyReason = () => `${serviceLabel(selectedHost())} isn't configured`;

export const primaryNotReadyText = () => `${primaryNotReadyReason()}. Open BigFileUpload settings`;

export function isConfigured(): boolean {
    const primary = selectedHost();
    if (SERVICES[primary] && !fallsBackToPublic(primary) && !isHostConfigured(primary)) return false;
    return candidateHosts(primary).hosts.some(s => SERVICES[s] && isHostConfigured(s) && (s === primary || httpFallbackAllowed(s)));
}

export function uploadBlocker(): string | null {
    const primary = selectedHost();
    if (SERVICES[primary] && !isHostConfigured(primary) && !isConfigured()) return primaryNotReadyText();
    const anyFile: FileFacts = { name: "", size: 0 };
    const plan = planUpload(primary, anyFile);
    return plan.order.length ? null : noHostMessage(primary, anyFile, plan);
}

async function uploadToEzHost(fileBlob: UploadBody, filename: string): Promise<string> {
    const { ezHostKey } = settings.store;

    if (!ezHostKey) throw new Error("E-Z Host API key is required");

    const response = await postMultipart("https://api.e-z.host/files", fileBlob, filename, {
        headers: { key: ezHostKey }
    });

    if (!response.ok) throw await httpFailure(response);

    const data = await response.json() as { success?: boolean; error?: string; imageUrl?: string; rawUrl?: string; };
    if (!data || !data.success) {
        throw new Error(typeof data?.error === "string" && cleanHostText(data.error) || "Upload failed");
    }

    const url = data.imageUrl || data.rawUrl;
    if (!url) throw new Error("The host returned no link");
    return url;
}

async function uploadToCatbox(fileBlob: UploadBody, filename: string): Promise<string> {
    const { catboxUserhash } = settings.store;

    const fields: Record<string, string> = { reqtype: "fileupload" };
    if (catboxUserhash) fields.userhash = catboxUserhash;

    const response = await postMultipart("https://catbox.moe/user/api.php", fileBlob, filename, {
        fields,
        fileFieldName: "fileToUpload"
    });

    const url = await readPlainTextUrl(response);
    const name = catboxFileName(url);
    if (fields.userhash && name) attemptKept = { deletion: { kind: "catbox", file: name } };
    return url;
}

function catboxFileName(url: string): string | null {
    if (!URL.canParse(url)) return null;
    const { protocol, hostname, pathname } = new URL(url);
    return protocol === "https:" && hostname === "files.catbox.moe" ? /^\/([\w-]+(?:\.[\w-]+)?)$/.exec(pathname)?.[1] ?? null : null;
}

async function uploadTo0x0(fileBlob: UploadBody, filename: string): Promise<string> {
    if (!Native) {
        throw new Error("0x0.st doesn't work on Vencord Web");
    }

    const { zeroX0Secret, zeroX0Expiry } = settings.store;
    const fields: Record<string, string> = {};
    if (zeroX0Secret) fields.secret = "";
    if (typeof zeroX0Expiry === "string" && Object.hasOwn(ZEROX0_KEPT, zeroX0Expiry)) fields.expires = zeroX0Expiry;

    const response = await postMultipart("https://0x0.st", fileBlob, filename, {
        fields
    });

    const url = await readPlainTextUrl(response);
    const token = response.headers.get("x-token")?.trim();
    if (token && URL.canParse(url) && new URL(url).hostname === "0x0.st") {
        rememberSessionSecret(token);
        attemptKept = { deletion: { kind: "0x0", url: trimAscii(url), token } };
    }
    return url;
}

async function uploadToLitterbox(fileBlob: UploadBody, filename: string): Promise<string> {
    const { litterboxExpiry, litterboxFileNameLength } = settings.store;
    const fields: Record<string, string> = { reqtype: "fileupload", time: litterboxExpiry || "24h" };
    if (litterboxFileNameLength === "16") fields.fileNameLength = "16";

    const response = await postMultipart("https://litterbox.catbox.moe/resources/internals/api.php", fileBlob, filename, {
        fields,
        fileFieldName: "fileToUpload"
    });

    return readPlainTextUrl(response);
}

const GOFILE_ERRORS: Record<string, string> = {
    "error-rateLimit": "GoFile is rate-limiting uploads (error-rateLimit)",
    "error-limits": "GoFile's storage or file-count limit for this account was reached (error-limits)"
};

const gofileError = (status: unknown) => typeof status === "string" && Object.hasOwn(GOFILE_ERRORS, status) ? GOFILE_ERRORS[status] : undefined;

function gofileStatus(text: string): unknown {
    try {
        return (JSON.parse(text) as { status?: unknown; } | null)?.status;
    } catch {
        return undefined;
    }
}

const GOFILE_GUEST_TOKEN = /^[\w-]{8,256}$/;

const GOFILE_OTHER_401 = new Set(["error-notPremium", "error-owner", "error-notOwner"]);

const isGofileTokenRejection = (status: number, code: unknown) => typeof code === "string" && /^error-(auth|token)/.test(code)
    || status === 401 && !(typeof code === "string" && GOFILE_OTHER_401.has(code));

const gofileAnsweredDirect = () => lastOutcome !== null && !lastOutcome.rerouted && !attemptProxy;

let gofileResent = false;

export function gofileGuestToken(): string | undefined {
    const { gofileToken, gofileReuseGuestToken } = settings.store;
    if (gofileToken?.trim() || !gofileReuseGuestToken) return undefined;
    const stored = storedGofileGuestToken();
    return GOFILE_GUEST_TOKEN.test(stored) ? stored : undefined;
}

async function uploadToGofile(fileBlob: UploadBody, filename: string): Promise<string> {
    const { gofileToken, gofileReuseGuestToken } = settings.store;
    await loadGofileGuest();
    const guest = gofileGuestToken();

    const send = (token: string | undefined) => postMultipart("https://upload.gofile.io/uploadfile", fileBlob, filename, {
        fields: token ? { token } : {}
    });

    const account = gofileToken?.trim() || undefined;
    let sent = account || guest;
    let response = await send(sent);
    let direct = gofileAnsweredDirect();

    if (guest && !account && sent === guest && direct && isGofileTokenRejection(response.status, gofileStatus(await response.text()))) {
        rememberSessionSecret(guest);
        if (storedGofileGuestToken() === guest) saveGofileGuestToken("");
        if (gofileResent) {
            throw new Error(`GoFile no longer accepts the saved guest token (HTTP ${response.status}), so it was reset. The next GoFile upload starts a new guest account`);
        }
        restartAttemptMonitor();
        gofileResent = true;
        logger.warn("GoFile no longer accepts the saved guest token. It was reset, and the upload is sent once more without it");
        setUploadState({ status: "GoFile no longer accepts the saved guest token. Uploading again without it...", percent: 0, transferredBytes: 0 });
        sent = undefined;
        response = await send(sent);
        direct = gofileAnsweredDirect();
    }

    if (!response.ok) {
        const text = await response.text();
        const known = gofileError(gofileStatus(text));
        throw known ? new Error(`${known} (HTTP ${response.status})`) : await httpFailure(response, text);
    }

    const data = await response.json() as {
        status?: string;
        error?: string;
        data?: { downloadPage?: string; code?: string; guestToken?: unknown; };
    };
    const minted = data?.data?.guestToken;
    if (typeof minted === "string" && minted.trim()) {
        rememberSessionSecret(minted);
        if (!sent && gofileReuseGuestToken && direct && GOFILE_GUEST_TOKEN.test(minted.trim())) {
            saveGofileGuestToken(minted.trim());
        }
    }

    if (data.status === "error-rateLimit") throw new RateLimitError(GOFILE_ERRORS["error-rateLimit"]);
    if (data.status !== "ok") {
        const status = typeof data.status === "string" ? cleanHostText(data.status) : "";
        throw new Error(gofileError(data.status)
            || typeof data.error === "string" && cleanHostText(data.error)
            || (status ? `GoFile error: ${status}` : "Upload failed"));
    }

    const url = data.data?.downloadPage || (data.data?.code ? `https://gofile.io/d/${data.data.code}` : "");
    if (!url) throw new Error("The host returned no link");
    return url;
}

async function uploadToTmpfiles(fileBlob: UploadBody, filename: string): Promise<string> {
    const { tmpfilesExpiry } = settings.store;
    const fields: Record<string, string> = typeof tmpfilesExpiry === "string" && Object.hasOwn(TMPFILES_KEPT, tmpfilesExpiry) ? { expire: tmpfilesExpiry } : {};

    const response = await postMultipart("https://tmpfiles.org/api/v1/upload", fileBlob, filename, {
        fields
    });

    if (!response.ok) throw await httpFailure(response);

    const data = await response.json() as { status?: string; data?: { url?: string; }; };
    const url = data.data?.url;
    if (!url || data.status !== "success") {
        throw new Error("The host returned no link");
    }

    return url.includes("tmpfiles.org/") && !url.includes("/dl/")
        ? url.replace(/tmpfiles\.org\/(\d+)/, "tmpfiles.org/dl/$1")
        : url;
}

async function uploadToBuzzheavier(fileBlob: UploadBody, filename: string): Promise<string> {
    const response = await serviceUploadRequest(`https://w.buzzheavier.com/${encodeURIComponent(filename)}`, {
        method: "PUT",
        bodyType: "binary",
        filename
    }, fileBlob);

    const text = await response.text();
    if (!response.ok) throw await httpFailure(response, text);

    let data: { code?: number; data?: { id?: unknown; }; } | null = null;
    try {
        data = JSON.parse(text);
    } catch { }
    const id = data?.data?.id;
    if (data?.code !== 201 || typeof id !== "string" || !id) throw new Error("The host returned no link");
    return `https://buzzheavier.com/${encodeURIComponent(id)}`;
}

async function uploadToTempSh(fileBlob: UploadBody, filename: string): Promise<string> {
    const response = await postMultipart("https://temp.sh/upload", fileBlob, filename);

    return readPlainTextUrl(response);
}

async function uploadToFilebin(fileBlob: UploadBody, filename: string): Promise<string> {
    const binId = randomHexBytes(6);
    const uploadUrl = `https://filebin.net/${binId}/${encodeURIComponent(filename)}`;

    const response = await serviceUploadRequest(uploadUrl, {
        method: "POST",
        bodyType: "binary",
        filename
    }, Native || isSpooled(fileBlob) ? fileBlob : new Blob([fileBlob]));

    if (!response.ok) throw await httpFailure(response);

    return uploadUrl;
}

async function uploadToPixelVault(fileBlob: UploadBody, filename: string): Promise<string> {
    const { pixelVaultKey } = settings.store;

    if (!pixelVaultKey?.trim()) {
        throw new Error("PixelVault upload key is required");
    }

    const response = await postMultipart("https://pixelvault.co/", fileBlob, filename, {
        headers: {
            Authorization: pixelVaultKey.trim()
        }
    });

    const { text, json } = await readTextAndJson(response);
    const data = json as { resource?: string; url?: string; } | null;

    if (!response.ok) throw await httpFailure(response, text);

    const url = data?.resource || data?.url || trimAscii(text);
    if (!url) {
        throw new Error("The host returned no link");
    }

    return url;
}

async function uploadToPixelDrain(fileBlob: UploadBody, filename: string): Promise<string> {
    const key = settings.store.pixelDrainKey?.trim();
    if (!key) throw new Error(PIXELDRAIN_KEY_REQUIRED);

    const response = await serviceUploadRequest(`https://pixeldrain.com/api/file/${encodeURIComponent(filename)}`, {
        method: "PUT",
        headers: { Authorization: `Basic ${utf8ToBase64(`:${key}`)}` },
        bodyType: "binary",
        filename
    }, fileBlob);

    const { text, json } = await readTextAndJson(response);
    const data = json as { id?: string; success?: boolean; value?: string; message?: string; } | null;

    if (!response.ok) {
        const known = typeof data?.value === "string" && Object.hasOwn(pixelDrainErrors, data.value) ? pixelDrainErrors[data.value] : null;
        const message = typeof data?.message === "string" ? cleanHostText(data.message) : "";
        throw known || message ? new Error(known || message) : await httpFailure(response, text);
    }

    if (!data?.id) {
        throw new Error(typeof data?.message === "string" && cleanHostText(data.message) || "The host returned no link");
    }

    attemptKept = { deletion: { kind: "pixeldrain", id: String(data.id) } };
    return `https://pixeldrain.com/u/${data.id}`;
}

function utf8ToBase64(input: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(input)));
}

function buildWebdavAuthHeader(): string | null {
    const { webdavUsername, webdavPassword } = settings.store;
    if (webdavUsername?.trim() && webdavPassword?.trim()) {
        return `Basic ${utf8ToBase64(`${webdavUsername.trim()}:${webdavPassword.trim()}`)}`;
    }
    return null;
}

class CommittedUploadError extends Error {
    constructor(message: string, readonly objectUrl?: string, readonly shareInterrupted = false) {
        super(message);
    }
}

function loggable(error: unknown): unknown {
    return error instanceof CommittedUploadError ? error.message : error;
}

export function parseWebdavRoot(webdavUrl: string): { base: string; sharePrefix: string; } {
    const { origin, pathname } = new URL(webdavUrl);
    const at = pathname.indexOf("/remote.php/");
    if (at < 0) return { base: origin, sharePrefix: "" };

    const below = /^(?:dav\/files\/[^/]+|webdav)(?:\/(.*))?$/.exec(pathname.slice(at + "/remote.php/".length))?.[1] ?? "";
    return {
        base: origin + pathname.slice(0, at),
        sharePrefix: below.split("/").filter(Boolean).map(decodeUrlSegment).join("/")
    };
}

async function createWebdavShare(relativePath: string, serverOrigin: string, filename: string, options: {
    webdavServerType: string; webdavShareType: string; authHeader: string | null;
}): Promise<string> {
    const { webdavServerType, webdavShareType, authHeader } = options;

    const ocsVersion = webdavServerType === "owncloud" ? "v1" : "v2";
    const ocsUrl = `${serverOrigin}/ocs/${ocsVersion}.php/apps/files_sharing/api/v1/shares?format=json`;

    const ocsHeaders: Record<string, string> = {
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded"
    };
    if (authHeader) {
        ocsHeaders.Authorization = authHeader;
    }

    const body = new URLSearchParams({
        path: `/${relativePath}`,
        shareType: "3",
        permissions: "1"
    }).toString();

    const response = await serviceUploadRequest(ocsUrl, {
        method: "POST",
        headers: ocsHeaders,
        bodyType: "binary"
    }, new Blob([body], { type: "application/x-www-form-urlencoded" }));

    const responseText = await response.text();

    if (!response.ok) throw await httpFailure(response, responseText, "Couldn't create the public share");

    let shareData: { ocs?: { data?: { url?: string; token?: string; }; meta?: Record<string, string>; }; };
    try {
        shareData = JSON.parse(responseText);
    } catch {
        throw new Error(`Couldn't read the share answer: ${describeBody(responseText, response.headers.get("content-type"))}`);
    }

    const shareToken = shareData?.ocs?.data?.token ?? "";

    if (!shareToken) {
        const meta = shareData?.ocs?.meta;
        const description = meta ? `${meta.message || meta.status || "unknown"} (${meta.statuscode || "?"})` : "no token in response";
        throw new Error(`Couldn't create the public share: ${cleanHostText(String(description))}`);
    }

    const shareUrl = shareData.ocs?.data?.url;

    const shareType = webdavShareType || "share-page";

    const token = encodeURIComponent(shareToken);
    const sharePageUrl = shareUrl || `${serverOrigin}/s/${token}`;
    const indexPhp = typeof shareUrl === "string" && shareUrl.includes(`/index.php/s/${shareToken}`) ? "/index.php" : "";
    const directDownloadUrl = webdavServerType === "owncloud"
        ? `${serverOrigin}/remote.php/dav/public-files/${token}`
        : `${serverOrigin}${indexPhp}/s/${token}/download`;

    if (shareType === "direct-download") {
        return directDownloadUrl;
    }

    if (shareType === "markdown") {
        return `[${markdownLabel(filename)}](${directDownloadUrl})`;
    }

    return sharePageUrl;
}

function uniqueWebdavName(filename: string): string {
    const safe = filename.replace(/[\\/\x00-\x1f]/g, "_");
    const dot = safe.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    return `${stem}-${Date.now().toString(36)}${randomHexBytes(3)}${ext}`;
}

async function uploadToWebdav(fileBlob: UploadBody, filename: string): Promise<string> {
    const { webdavUrl, webdavServerType, webdavDirectory, webdavShareType } = settings.store;

    if (!webdavUrl) {
        throw new Error("WebDAV server URL is required");
    }

    const authHeader = buildWebdavAuthHeader();
    const baseUrl = webdavUrl.replace(/\/+$/, "");
    const dir = (webdavDirectory || "").replace(/^\/+|\/+$/g, "");
    const encodedDir = dir ? dir.split("/").map(encodeURIComponent).join("/") + "/" : "";
    let root: ReturnType<typeof parseWebdavRoot> | null = null;
    if (!isGenericWebdav(webdavServerType || "nextcloud", webdavUrl)) {
        try {
            root = parseWebdavRoot(webdavUrl);
        } catch {
            throw new Error("Invalid WebDAV server URL");
        }
    }

    const requestHeaders: Record<string, string> = {
        "Content-Type": fileBlob.type || "application/octet-stream",
        ...(Native || toProxyUrl(baseUrl, ServiceType.WEBDAV) !== baseUrl ? { "If-None-Match": "*" } : {})
    };
    if (authHeader) {
        requestHeaders.Authorization = authHeader;
    }

    const put = async () => {
        const name = uniqueWebdavName(filename);
        const url = `${baseUrl}/${encodedDir}${encodeURIComponent(name)}`;
        const response = await serviceUploadRequest(url, {
            method: "PUT",
            headers: requestHeaders,
            bodyType: "binary",
            filename: name
        }, fileBlob);
        return { name, url, response };
    };

    let attempt = await put();
    if (attempt.response.status === 412 && !cancelRequested) attempt = await put();
    const { name: remoteName, url: uploadUrl, response } = attempt;

    if (!response.ok) throw await httpFailure(response);

    let privateUrl = uploadUrl;
    try {
        privateUrl = withoutUserinfo(new URL(uploadUrl));
    } catch { }
    if (URL.canParse(privateUrl)) attemptKept = { deletion: { kind: "webdav", url: privateUrl }, endpointOrigin: new URL(privateUrl).origin };
    const fileLink = () => {
        try {
            return validateUploadedUrl(privateUrl, ServiceType.WEBDAV);
        } catch {
            throw new CommittedUploadError(`File uploaded to WebDAV (${[dir, remoteName].filter(Boolean).join("/")}), but its URL isn't a valid link. No other host was tried`, privateUrl);
        }
    };
    if (!root) return fileLink();

    const sharePath = [root.sharePrefix, dir, remoteName].filter(Boolean).join("/");
    if (cancelRequested) throw new CommittedUploadError(`Cancelled before WebDAV shared ${sharePath}`, privateUrl);
    committedStage = true;
    try {
        return validateUploadedUrl(await createWebdavShare(sharePath, root.base, filename, { webdavServerType, webdavShareType, authHeader }), ServiceType.WEBDAV);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        throw new CommittedUploadError(`File uploaded to WebDAV (${sharePath}), but sharing it failed: ${reason}. No other host was tried`, privateUrl, cancelRequested);
    } finally {
        committedStage = false;
    }
}

const uploaders: Record<ServiceType, (fileBlob: UploadBody, filename: string) => Promise<string>> = {
    [ServiceType.ZIPLINE]: uploadToZipline,
    [ServiceType.NEST]: uploadToNest,
    [ServiceType.EZHOST]: uploadToEzHost,
    [ServiceType.ENCRYPTINGHOST]: uploadToEncryptingHost,
    [ServiceType.S3]: (fileBlob, filename) => uploadToS3(fileBlob, filename, s3Transport()),
    [ServiceType.CATBOX]: uploadToCatbox,
    [ServiceType.ZEROX0]: uploadTo0x0,
    [ServiceType.LITTERBOX]: uploadToLitterbox,
    [ServiceType.SHAREX]: uploadToShareX,
    [ServiceType.GOFILE]: uploadToGofile,
    [ServiceType.TMPFILES]: uploadToTmpfiles,
    [ServiceType.BUZZHEAVIER]: uploadToBuzzheavier,
    [ServiceType.TEMPSH]: uploadToTempSh,
    [ServiceType.FILEBIN]: uploadToFilebin,
    [ServiceType.PIXELVAULT]: uploadToPixelVault,
    [ServiceType.PIXELDRAIN]: uploadToPixelDrain,
    [ServiceType.WEBDAV]: uploadToWebdav
};

async function uploadToService(serviceType: ServiceType, fileBlob: UploadBody, filename: string): Promise<string> {
    if (!Object.hasOwn(uploaders, serviceType)) throw new Error("Unknown service type");
    return uploaders[serviceType](fileBlob, filename);
}

function applyEmbedProxy(url: string, ctx: EmbedContext, wait?: EmbedWait): Promise<string> {
    if (insecureHttpOrigin(ctx.service)) return Promise.resolve(url);
    return wrapForEmbed(url, ctx, wait);
}

let stopEmbedWait: (() => void) | null = null;

function startEmbedChecks(file: UploadBody, fileName: string, primary: ServiceType, target: UploadTarget, displayName: string): Promise<VideoDims | undefined> | undefined {
    if (!settings.store.embedProxyEnabled || !isVideoLink(`https://link.invalid/${encodeURIComponent(fileName)}`, file.type)) return undefined;
    void predictEmbedTarget({
        fileName,
        contentType: file.type,
        size: file.size,
        service: primary,
        endpoint: SERVICES[primary]?.privacy === "private" ? endpointOf(primary) : undefined,
        outputsCanEmbed: outputsCanEmbed("https://link.invalid/", target, displayName)
    }).then(predicted => {
        if (predicted) void probeEmbedTarget(predicted);
    }, error => logger.warn("Couldn't predict the video link's embed", error));
    return embedTarget()?.kind === "autocompressor" && file instanceof Blob ? readVideoDims(file) : undefined;
}

async function embedLink(link: string, ctx: EmbedContext): Promise<string> {
    let stop = () => { };
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    const shown: { status?: string; } = {};
    try {
        return await applyEmbedProxy(link, ctx, {
            onWait: name => {
                shown.status = uploadState.status;
                stopEmbedWait = stop;
                setUploadState({ status: `Checking ${name}…`, canCancel: true });
            },
            stop: stopped
        });
    } catch (error) {
        logger.warn("Couldn't wrap the video link. Posting it plain", error);
        return link;
    } finally {
        stopEmbedWait = null;
        if (shown.status !== undefined) setUploadState({ status: shown.status, canCancel: false });
    }
}

interface FileFacts {
    name: string;
    size: number;
}

type SkipKind = ConfigProblem["kind"] | "http" | "type" | "size" | "rule";

const FILE_SKIP_KINDS: ReadonlySet<SkipKind> = new Set(["type", "size", "rule"]);

interface Skip {
    service: ServiceType;
    kind: SkipKind;
    reason: string;
    limit?: number;
    needsProxy?: boolean;
}

interface UploadPlan {
    order: ServiceType[];
    skipped: Skip[];
    d4Dropped: boolean;
}

const askBeforeFallback = () => settings.store.primaryFailureMode === "ask" && !settings.store.disableFallbacks;

const autoFallbackAllowed = (primary: ServiceType, service: ServiceType) =>
    (SERVICES[primary] !== undefined && fallsBackToPublic(primary)) || isPrivateFallbackTarget(service);

function candidateHosts(primary: ServiceType): { hosts: ServiceType[]; d4Dropped: boolean; } {
    if (settings.store.disableFallbacks) return { hosts: [primary], d4Dropped: false };
    const fallbacks = getFallbackServices().filter(s => s !== primary);
    if (askBeforeFallback()) return { hosts: [primary, ...fallbacks], d4Dropped: false };
    const kept = fallbacks.filter(s => autoFallbackAllowed(primary, s));
    return { hosts: [primary, ...kept], d4Dropped: kept.length < fallbacks.length };
}

function endpointOf(service: ServiceType): string | undefined {
    const { store } = settings;
    switch (service) {
        case ServiceType.ZIPLINE: return store.serviceUrl;
        case ServiceType.S3: return store.s3Endpoint;
        case ServiceType.WEBDAV: return store.webdavUrl;
        case ServiceType.SHAREX:
            try {
                return parseShareXConfig(store.sharexConfig || "").RequestURL;
            } catch {
                return undefined;
            }
        default: return undefined;
    }
}

function httpOriginOf(service: ServiceType): string | null {
    if (SERVICES[service]?.web !== "user") return null;
    try {
        const url = new URL(endpointOf(service)?.trim() ?? "");
        return url.protocol === "http:" ? url.origin : null;
    } catch {
        return null;
    }
}

function httpFallbackAllowed(service: ServiceType): boolean {
    const origin = httpOriginOf(service);
    return origin === null || hasUploadedToHttpOrigin(origin);
}

function fileSkip(service: ServiceType, file: FileFacts): Skip | null {
    const info = SERVICES[service];
    const { label } = info;
    const ext = splitExtension(file.name)[1]?.toLowerCase();
    if (ext && info.blockedExtensions?.test(ext)) return { service, kind: "type", reason: `${label} doesn't accept .${ext} files` };
    const rule = info.blocks?.(file);
    if (rule) return { service, kind: "rule", reason: rule };
    const size = bodySize(file, service);
    if (service === ServiceType.S3 && size > S3_MAX_PUT_BYTES && !canMultipart()) return { service, kind: "rule", reason: MULTIPART_RESTART_TEXT };
    const proxyLimit = requestRoute(service) === "proxy" && service !== ServiceType.S3 ? proxyBodyLimit(getActiveCorsProxyUrl()) : null;
    const zipline = service === ServiceType.ZIPLINE;
    const maxBytes = zipline ? ziplineMaxBytes() : info.maxBytes;
    const limit = Math.min(maxBytes ?? Infinity, proxyLimit ?? Infinity);
    if (maxBytes != null && (zipline ? file.size : size) > maxBytes) return { service, kind: "size", reason: `${label} accepts up to ${formatSize(maxBytes, true)}`, limit };
    if (proxyLimit != null && size > proxyLimit) return { service, kind: "size", reason: `${label} can't take files over ${formatSize(proxyLimit, true)} through the CORS proxy`, limit };
    return null;
}

function planUpload(primary: ServiceType, file: FileFacts): UploadPlan {
    const { hosts, d4Dropped } = candidateHosts(primary);
    const order: ServiceType[] = [];
    const skipped: Skip[] = [];
    for (const service of hosts) {
        const problems = getServiceConfigProblems(service);
        const problem = PROBLEM_ORDER.map(kind => problems.find(p => p.kind === kind)).find(Boolean);
        const skip: Skip | null = problem ? { service, kind: problem.kind, reason: problem.message, needsProxy: problem.kind === "platform" && needsProxyHere(service) }
            : service !== primary && !httpFallbackAllowed(service) ? { service, kind: "http", reason: `${serviceLabel(service)} is not used as a fallback on this network (unencrypted http)` }
                : fileSkip(service, file);
        if (skip) skipped.push(skip);
        else order.push(service);
    }
    return { order, skipped, d4Dropped };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function formatSize(bytes: number, cap = false): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    const binary = cap && bytes >= 2 ** 20 && bytes % 2 ** 20 === 0 && bytes % 1e6 !== 0;
    const units = binary ? [["GB", 2 ** 30], ["MB", 2 ** 20], ["KB", 2 ** 10]] as const : [["GB", 1e9], ["MB", 1e6], ["KB", 1e3]] as const;
    for (const [unit, size] of units) {
        if (bytes >= size) return `${Number((bytes / size).toPrecision(3))} ${unit}`;
    }
    return `${bytes} B`;
}

const announcedSkips = new Set<string>();

function summarizeSkips(skips: readonly Skip[], file: FileFacts): string {
    const groups = new Map<SkipKind | "proxy", Skip[]>();
    for (const skip of skips) {
        if (!FILE_SKIP_KINDS.has(skip.kind)) {
            const key = `${skip.service}\n${skip.reason}`;
            if (announcedSkips.has(key)) continue;
            announcedSkips.add(key);
        }
        const group = skip.needsProxy ? "proxy" : skip.kind;
        groups.set(group, [...groups.get(group) ?? [], skip]);
    }
    const ext = splitExtension(file.name)[1]?.toLowerCase();
    const counted: Partial<Record<SkipKind | "proxy", (n: number) => string>> = {
        size: n => `Skipped ${plural(n, "host")} that don't accept ${formatSize(file.size)}`,
        type: n => `Skipped ${plural(n, "host")} that don't accept .${ext} files`,
        credentials: n => `Skipped ${plural(n, "host")} that aren't configured`,
        platform: n => `Skipped ${plural(n, "host")} that can't be used here`,
        proxy: n => `Skipped ${plural(n, "host")} that need ${neededProxy()}`,
        consent: n => `Skipped ${plural(n, "host")} waiting for your CORS-proxy answer`,
        http: n => `Skipped ${plural(n, "host")} not used as fallbacks on this network (unencrypted http)`
    };
    return [...groups].map(([kind, list]) => list.length > 1 && counted[kind] ? counted[kind]!(list.length) : list.map(s => s.reason).join("; ")).join(". ");
}

export function hostRetention(service: ServiceType, size?: number): string | undefined {
    const { litterboxExpiry, zeroX0Expiry, tmpfilesExpiry } = settings.store;
    return SERVICES[service]?.retention?.(size, { litterboxExpiry, zeroX0Expiry, tmpfilesExpiry });
}

function landingNote(service: ServiceType, primary: ServiceType, size: number): string | undefined {
    if (SERVICES[primary]?.confidential && service !== primary && !SERVICES[service].confidential) return "not encrypted";
    return hostRetention(service, size);
}

export interface WebDeclineOutlook {
    primary: ServiceType;
    primaryNeedsProxy: boolean;
    variant: "disabled" | "confidential" | "none" | "normal";
    host?: ServiceType;
    userHost?: ServiceType;
    suggestPublic: boolean;
}

export function webDeclineOutlook(): WebDeclineOutlook {
    const primary = selectedHost();
    const info = SERVICES[primary];
    const base = { primary, primaryNeedsProxy: info?.web === "proxy", suggestPublic: info !== undefined && fallsBackToPublic(primary) };
    if (settings.store.disableFallbacks) return { ...base, variant: "disabled" };
    if (info?.confidential) return { ...base, variant: "confidential" };
    const usable = getFallbackServices().filter(s => s !== primary && SERVICES[s] && autoFallbackAllowed(primary, s) && isHostConfigured(s) && httpFallbackAllowed(s));
    const direct = usable.findIndex(s => SERVICES[s].web === "direct" || SERVICES[s].web === "direct-simple");
    const userHost = usable.slice(0, direct < 0 ? undefined : direct).find(s => SERVICES[s].web === "user");
    return direct < 0 ? { ...base, variant: "none", userHost } : { ...base, variant: "normal", host: usable[direct], userHost };
}

function proxyNoHostMessage(primary: ServiceType, plan: UploadPlan): string | null {
    const primarySkip = plan.skipped.find(s => s.service === primary);
    const label = serviceLabel(primary);
    if (settings.store.disableFallbacks) {
        return primarySkip?.needsProxy
            ? `${label} needs the CORS proxy ${RENDERER_PLACE}, and fallback hosts are disabled, so files over Discord's limit are left to Discord. Accept the CORS proxy, or turn off Disable Fallback Hosts`
            : null;
    }
    if (primarySkip?.needsProxy && SERVICES[primary]?.confidential) {
        return `${label} needs the CORS proxy ${RENDERER_PLACE}. Its links carry the decryption key, so BigFileUpload never moves its files to an unencrypted public host by itself. Files over Discord's limit are left to Discord unless an active private host can take them. Accept the CORS proxy, or choose another upload host`;
    }
    if (plan.skipped.some(s => s.needsProxy) && !candidateHosts(primary).hosts.some(runsWithoutProxy)) {
        if (primarySkip?.needsProxy) return `${label} needs the CORS proxy ${RENDERER_PLACE}, and none of your active fallback hosts works without it. Turn on ${directWebHostNames("or")} under Fallback Order, or accept the CORS proxy`;
        return `No active fallback host works ${IS_WEB ? "on Vencord Web without the CORS proxy" : "here without the CORS proxy (this app is running without the native helper)"}. Turn on ${directWebHostNames("or")} under Fallback Order, or accept the CORS proxy`;
    }
    return null;
}

function noHostMessage(primary: ServiceType, file: FileFacts, plan: UploadPlan): string {
    const proxyText = proxyNoHostMessage(primary, plan);
    if (proxyText) return proxyText;

    const primarySkip = plan.skipped.find(s => s.service === primary);
    if (settings.store.disableFallbacks && primarySkip) return `${primarySkip.reason} and fallback hosts are disabled`;

    const fileSkips = plan.skipped.filter(s => FILE_SKIP_KINDS.has(s.kind));
    const sized = fileSkips.filter(s => s.kind === "size");
    const typed = fileSkips.filter(s => s.kind === "type");
    let text: string;
    if (sized.length && sized.length === fileSkips.length) {
        const largest = sized.reduce((a, b) => (b.limit ?? 0) > (a.limit ?? 0) ? b : a);
        text = `No configured host accepts a ${formatSize(file.size)} file (largest: ${serviceLabel(largest.service)}, ${formatSize(largest.limit ?? 0, true)}). Configure S3/WebDAV or a custom uploader`;
    } else if (typed.length && typed.length === fileSkips.length) {
        text = `No configured host accepts .${splitExtension(file.name)[1]?.toLowerCase()} files`;
    } else if (fileSkips.length) {
        text = `No configured host accepts ${file.name} (${formatSize(file.size)}): ${fileSkips.map(s => s.reason).join("; ")}`;
    } else {
        text = `No upload host can be used: ${plan.skipped.map(s => s.reason).join("; ") || "none is active"}`;
    }

    const active = getFallbackServices();
    const couldTake = fallbackServiceOrder.find(s => s !== primary && !active.includes(s)
        && getServiceConfigError(s) === null && httpFallbackAllowed(s) && !fileSkip(s, file));
    if (couldTake) text += ` (${serviceLabel(couldTake)} could take it, but it is off under Fallback Order)`;
    if (plan.d4Dropped) text += `. Public hosts are never used for files meant for ${serviceLabel(primary)}`;
    return text;
}

export function canAnyHostAccept(file: FileFacts): boolean {
    return planUpload(selectedHost(), file).order.length > 0 && !nativeCeilingText(file.size);
}

export function noHostText(file: FileFacts): string | null {
    const primary = selectedHost();
    const plan = planUpload(primary, file);
    const ceiling = plan.order.length ? nativeCeilingText(file.size) : null;
    if (ceiling) return ceiling;
    const text = noHostMessage(primary, file, plan);
    if (text === proxyNoHostMessage(primary, plan)) {
        const key = `no host\n${text}`;
        if (announcedSkips.has(key)) return null;
        announcedSkips.add(key);
    }
    return text;
}

export function finalizeUploadedUrl(url: string, service: ServiceType): string {
    if (!settings.store.stripQueryParams || service === ServiceType.ENCRYPTINGHOST) return url;
    if (!URL.canParse(url)) return url;
    if (getStripQueryMode() === "tracking") return service === ServiceType.SHAREX ? url : stripTrackingParams(url);

    const parsed = new URL(url);
    parsed.search = "";
    return parsed.href;
}

function decodeQueryKey(pair: string): string {
    const key = pair.split("=", 1)[0].replace(/\+/g, " ");
    try {
        return decodeURIComponent(key);
    } catch {
        return key;
    }
}

function isTrackingKey(key: string): boolean {
    const lower = key.toLowerCase();
    return lower.startsWith("utm_") || TRACKING_QUERY_KEYS.has(lower);
}

export function stripTrackingParams(url: string): string {
    const hashAt = url.indexOf("#");
    const head = hashAt < 0 ? url : url.slice(0, hashAt);
    const hash = hashAt < 0 ? "" : url.slice(hashAt);
    const q = head.indexOf("?");
    if (q < 0) return url;

    const kept = head.slice(q + 1).split("&").filter(p => p !== "" && !isTrackingKey(decodeQueryKey(p)));
    return head.slice(0, q) + (kept.length ? "?" + kept.join("&") : "") + hash;
}

export function isFileTypeAllowed(file: File): boolean {
    return fileTypePasses(file.name, parseFileTypeFilter(settings.store.uploadAllowedFileTypes));
}

function isPreformattedLink(value: string): boolean {
    return /^\[[^\]]*\]\([^)]*\)$/.test(trimAscii(value));
}

export function markdownLabel(name: string): string {
    return name.replace(/[[\])]/g, "");
}

export function isOriginComposerVisible(originChannelId: string): boolean {
    const selected = SelectedChannelStore.getChannelId();
    if (!selected) return false;
    if (originChannelId === selected) return true;
    try {
        return originChannelId === ChannelSectionStore.getCurrentSidebarChannelId(selected);
    } catch (error) {
        logger.warn("Couldn't read the open thread sidebar", error);
        return false;
    }
}

function describeChannel(channelId: string): string {
    try {
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return "the original chat";
        if (channel.guild_id) return `#${channel.name}`;
        const names = (channel.recipients ?? []).flatMap(id => {
            const user = UserStore.getUser(id);
            return user ? [user.globalName || user.username] : [];
        });
        if (channel.isGroupDM?.() || (channel.recipients?.length ?? 0) > 1) {
            if (channel.name) return channel.name;
            return names.length ? `your group DM with ${names.slice(0, 2).join(", ")}${names.length > 2 ? "…" : ""}` : "your group DM";
        }
        return names.length ? `your DM with ${names[0]}` : "the original chat";
    } catch {
        return "the original chat";
    }
}

function divertedNotice({ channelId }: UploadTarget, diverted: number, copied = diverted): string {
    const what = copied > 1 ? `${copied} links` : "Link";
    if (!channelId) return `${what} copied. No chat was open when the upload started`;
    const chat = describeChannel(channelId);
    return diverted < copied
        ? `${what} copied. ${diverted} weren't inserted because ${chat} isn't open in the main window`
        : `${what} for ${chat} copied. That chat isn't open in the main window`;
}

function reportStrandedLinks(urls: string[], why: string): void {
    logger.info(`Links ${why}:\n${urls.join("\n")}`);
    const what = urls.length > 1 ? `${urls.length} links` : "Link";
    showToast({ text: `${what} ${why}. Copy it from the console (Ctrl+Shift+I)`, duration: 15000 });
}

export interface UploadTarget {
    channelId?: string | null;
    draftType?: number;
    composer?: string;
    forceSend?: boolean;
    stillWanted?: () => boolean;
    automatic?: boolean;
    spoiler?: boolean;
    confirmed?: boolean;
}

interface BatchLinks {
    urls: string[];
    divertedUrls: string[];
    insertFailedUrls?: string[];
}

function insertedBracketed(link: string, displayName?: string): boolean {
    const { autoFormat, displayOriginalFilename } = settings.store;
    return Boolean(autoFormat) && !isPreformattedLink(link) && !(displayOriginalFilename && displayName);
}

const MAX_SENT_LENGTH = 2000;

const SEND_WAIT_MS = 15000;

function canSendTo({ channelId, draftType }: UploadTarget): boolean {
    if (channelId == null || draftType !== DraftType.ChannelMessage) return false;
    try {
        const channel = ChannelStore.getChannel(channelId);
        if (!channel || channel.isForumLikeChannel?.()) return false;
        if (!channel.guild_id) return true;
        return PermissionStore.can(channel.isThread?.() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES, channel);
    } catch (error) {
        logger.warn("Couldn't check whether the link can be sent there", error);
        return false;
    }
}

type LinkPlacement = "send" | "insert" | "divert" | "none";

function placeLink(target: UploadTarget): LinkPlacement {
    if (settings.store.autoSend && settings.store.sendImmediately && canSendTo(target)) return "send";
    if (!target.forceSend && !settings.store.autoSend) return "none";
    return target.channelId != null && isOriginComposerVisible(target.channelId) ? "insert" : "divert";
}

const DISCORD_EPOCH = 1420070400000;

const newNonce = () => (BigInt(Date.now() - DISCORD_EPOCH) << BigInt(22) | BigInt(Math.floor(Math.random() * 0x400000))).toString();

async function sendLink(channelId: string, text: string, recoveryLink = text): Promise<boolean> {
    const nonce = newNonce();
    const options = { nonce, allowedMentions: { parse: [], replied_user: false } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const sending = Promise.resolve().then(() => sendMessage(channelId, { content: text }, false, options));
    void sending.catch(error => {
        if (!pending) return;
        logger.warn("Discord reported a late send failure", redactText(error instanceof Error ? error.message : "Unknown error"));
        announceSendFailure(recoveryLink, describeChannel(channelId));
    });
    try {
        await Promise.race([
            sending,
            new Promise<void>(resolve => { timer = setTimeout(() => { pending = true; resolve(); }, SEND_WAIT_MS); })
        ]);
        return true;
    } catch (error) {
        logger.warn("Upload succeeded but sending the link failed", error);
        try {
            MessageActions.deleteMessage(channelId, nonce, true);
        } catch (e) {
            logger.warn("Couldn't remove the refused message", e);
        }
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function outputsCanEmbed(link: string, target: UploadTarget, displayName?: string): boolean {
    const placed = placeLink(target);
    if (settings.store.autoCopy || placed === "none" || placed === "divert") return true;
    return !insertedBracketed(link, displayName);
}

interface UploadLinks {
    plain: string;
    wrapped: string;
}

async function notifyUploadSuccess({ plain, wrapped: finalUrl }: UploadLinks, target: UploadTarget, displayName?: string, batch?: BatchLinks, spoiler = false): Promise<void> {
    const preformatted = isPreformattedLink(finalUrl);
    let placed = placeLink(target);

    const { autoFormat, displayOriginalFilename } = settings.store;
    let text = finalUrl;
    if (!preformatted) {
        if (displayOriginalFilename && displayName) {
            text = `[${markdownLabel(displayName)}](${finalUrl})`;
        } else if (autoFormat) {
            text = `<${plain}>`;
        }
    }
    if (spoiler) text = `||${text}||`;
    if (placed === "send" && text.length > MAX_SENT_LENGTH) {
        placed = target.channelId != null && isOriginComposerVisible(target.channelId) ? "insert" : "divert";
    }

    let sendFailed = false;
    let insertFailed = false;
    if (placed === "send" && !await sendLink(target.channelId!, text, finalUrl)) {
        sendFailed = true;
        placed = isOriginComposerVisible(target.channelId!) ? "insert" : "divert";
    }
    const diverted = placed === "divert";
    const copy = settings.store.autoCopy || diverted;

    if (placed === "insert") {
        try {
            insertTextIntoChatInputBox(`${text} `);
            if (sendFailed) showToast({ text: "Upload succeeded, but the link couldn't be sent. It was inserted into the chatbox instead", duration: 8000 });
        } catch (error) {
            logger.warn("Upload succeeded but inserting the link into the chat box failed", error);
            insertFailed = true;
        }
    }

    const sent = () => `link sent${isOriginComposerVisible(target.channelId!) ? "" : ` to ${describeChannel(target.channelId!)}`}`;
    if (copy || insertFailed) {
        if (batch) {
            batch.urls.push(finalUrl);
            if (diverted) batch.divertedUrls.push(finalUrl);
            if (insertFailed) (batch.insertFailedUrls ??= []).push(finalUrl);
            showToast({ text: placed === "send" ? `Upload successful, ${sent()}` : "Upload successful", variant: "success" });
        } else {
            try {
                await copyToClipboard(finalUrl);
                showToast(diverted
                    ? { text: divertedNotice(target, 1), duration: 8000 }
                    : insertFailed ? { text: "Upload succeeded, but the link couldn't be inserted. It was copied to your clipboard", duration: 8000 }
                        : { text: placed === "send" ? `Upload successful, ${sent()} and copied` : "Upload successful, link copied", variant: "success" });
            } catch (error) {
                logger.warn("Upload succeeded but clipboard copy failed", error);
                if (diverted || insertFailed) reportStrandedLinks([finalUrl], "uploaded but not inserted or copied");
                else showToast({ text: "Upload successful, but the link couldn't be copied" });
            }
        }
    } else if (placed === "send") {
        showToast({ text: `Upload successful, ${sent()}`, variant: "success" });
    } else if (placed === "insert") {
        if (!sendFailed) showToast({ text: "Upload successful", variant: "success" });
    } else {
        showToast({ text: `Upload successful: ${finalUrl}`, variant: "success", duration: 10000 });
    }
}

interface ProgressPoll {
    stop(): void;
    stalled(): boolean;
}

function pollNativeUploadProgress(): ProgressPoll {
    const native = Native;
    if (!native) return { stop: () => { }, stalled: () => false };
    const stallMs = getUploadTimeoutMs();
    let lastLoaded = -1;
    let lastProgressAt = Date.now();
    let aborted = false;
    let watched = false;
    let stopped = false;
    void native.resetUploadProgress();
    const interval = setInterval(async () => {
        try {
            const p = await native.getUploadProgress();
            if (stopped || !p || p.total <= 0 || p.phase === "downloading" || cancelRequested || aborted) return;
            if (p.stallWatch) watched = true;

            const { loaded, total } = spanned(p.loaded, p.total);
            if (loaded !== lastLoaded) {
                lastLoaded = loaded;
                lastProgressAt = Date.now();
                const percent = Math.round(Math.max(0, Math.min(100, loaded / total * 100)));
                setUploadState({ percent, transferredBytes: loaded, totalBytes: total });
            } else if (!watched) {
                const graceMs = p.loaded >= p.total ? Math.max(stallMs, RESPONSE_GRACE_MS) : stallMs;
                if (Date.now() - lastProgressAt > graceMs) {
                    aborted = true;
                    void native.cancelUpload("stalled");
                }
            }
        } catch { }
    }, 150);
    return {
        stop: () => {
            stopped = true;
            clearInterval(interval);
        },
        stalled: () => aborted
    };
}

function isProxiedNetworkError(error: unknown): boolean {
    return error instanceof TransportError && error.kind === "network" && error.viaProxy;
}

function keptUploadEntry(raw: unknown, service: ServiceType, fileName: string, size: number, kept: KeptNow, committed?: CommittedUploadError, cancelled = false): LateCancelEntry | null {
    const isPrivate = Boolean(committed);
    let url: string;
    try {
        url = finalizeUploadedUrl(validateUploadedUrl(raw, service), service);
    } catch {
        return null;
    }
    const link = linkOf(url);
    return {
        url: link,
        fileName,
        hostLabel: serviceLabel(service),
        retention: isPrivate ? undefined : hostRetention(service, size),
        private: isPrivate,
        shareInterrupted: committed?.shareInterrupted,
        id: keepInHistory(link, service, size, kept, cancelled)
    };
}

function lateCancelError(raw: unknown, service: ServiceType, fileName: string, size: number, kept: KeptNow, committed?: CommittedUploadError): Error {
    const entry = keptUploadEntry(raw, service, fileName, size, kept, committed, true);
    return entry ? new LateCancelError(entry) : new UploadCancelledError();
}

class RateLimitError extends Error { }

const RETRY_MAX_WAIT_MS = 15000;

interface FailureVerdict {
    retry: boolean;
    down: boolean;
    waitMs: number;
    status(seconds: number): string;
}

const HTTP_DATE = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4}|[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2}) \d{2}:\d{2}:\d{2} GMT/;

function retryAfterMs(value: string | null | undefined): number | null {
    const v = value?.trim() ?? "";
    const seconds = /^(\d+(?:\.\d+)?)\s*(?:,|$)/.exec(v);
    if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
    const date = HTTP_DATE.exec(v);
    const at = date ? Date.parse(date[0]) : NaN;
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function judgeFailure(service: ServiceType, error: unknown, stalled: boolean): FailureVerdict | null {
    const label = serviceLabel(service);
    const { status, retryAfter, error: transport, rerouted: wasRerouted } = lastOutcome ?? {};
    const wait = (ms: number) => Math.min(ms, RETRY_MAX_WAIT_MS, getUploadTimeoutMs());
    const verdict = (down: boolean, waitMs: number, text: (s: number) => string): FailureVerdict => ({ retry: true, down, waitMs, status: text });
    const moveOn: FailureVerdict = { retry: false, down: true, waitMs: 0, status: () => "" };
    if (stalled || transport?.kind === "timeout") return moveOn;
    if (transport) return transport.unsent && !wasRerouted ? verdict(true, wait(1000), s => `Couldn't reach ${label}, retrying in ${s}s...`) : moveOn;
    if (status === 429 || error instanceof RateLimitError) return verdict(false, wait(retryAfterMs(retryAfter) ?? 5000), s => `Rate-limited by ${label}, retrying in ${s}s...`);
    if (status && status >= 500 && status < 600) return verdict(true, wait(retryAfterMs(retryAfter) ?? 2000), s => `${label} answered ${status}, retrying in ${s}s...`);
    return null;
}

let wakeRetryWait: (() => void) | null = null;

let attemptPoll: ProgressPoll | null = null;

let requestsRetried = false;

async function retryRequest(error: unknown, { transient = false, resend = false }: RetryOptions = {}): Promise<boolean> {
    const service = currentAttemptService;
    if (!service || isUploadCancelledError(error) || (error instanceof SpoolError || error instanceof NativeBusyError) || error instanceof CommittedUploadError) return false;
    const label = serviceLabel(service);
    const stalled = attemptPoll?.stalled() ?? false;
    const wait = (ms: number) => Math.min(ms, getUploadTimeoutMs());
    let verdict = judgeFailure(service, error, stalled);
    if (!verdict && transient) verdict = { retry: true, down: false, waitMs: wait(2000), status: s => `${label} reported an internal error, retrying in ${s}s...` };
    if (!verdict?.retry && resend && !stalled && lastOutcome?.error?.kind === "network") verdict = { retry: true, down: true, waitMs: wait(1000), status: s => `Couldn't reach ${label}, retrying in ${s}s...` };
    if (!verdict?.retry) return false;
    logger.warn(`A request to ${label} failed, trying it once more: ${error instanceof Error ? error.message : "Unknown error"}`);
    await waitToRetry(verdict);
    setUploadState({ phase: "uploading", status: uploadingStatus() });
    return true;
}

async function waitToRetry(verdict: FailureVerdict): Promise<void> {
    const end = Date.now() + verdict.waitMs;
    setUploadState({ phase: "retrying", indeterminate: false, canCancel: true, ...!multipart && { percent: 0, transferredBytes: 0 } });
    try {
        for (let left = verdict.waitMs; left > 0 && !cancelRequested; left = end - Date.now()) {
            setUploadState({ status: verdict.status(Math.ceil(left / 1000)) });
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, Math.min(1000, left));
                wakeRetryWait = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
        }
    } finally {
        wakeRetryWait = null;
    }
    if (cancelRequested) throw new UploadCancelledError();
}

function healthKey(service: ServiceType): string {
    const apiHost = SERVICES[service]?.apiHost;
    if (apiHost) return `https://${apiHost}`;
    try {
        const { origin } = new URL(endpointOf(service)?.trim() ?? "");
        if (origin !== "null") return origin;
    } catch { }
    return service;
}

interface BatchMemory {
    lastSuccess: ServiceType | null;
    failed: Set<ServiceType>;
}

let batchMemory: BatchMemory | null = null;

function breakerOrder(order: readonly ServiceType[]): ServiceType[] {
    if (checkRoutingSettings(withDeclaredDefaults(settings.plain ?? {})) && batchMemory) batchMemory = { lastSuccess: null, failed: new Set() };
    const up = order.filter(s => !isHostDown(healthKey(s)));
    const down = order.filter(s => !up.includes(s));
    const last = batchMemory?.lastSuccess;
    const from = last ? up.indexOf(last) : -1;
    const to = up.findIndex(s => batchMemory?.failed.has(s));
    if (from > 0 && to >= 0 && to < from) up.splice(to, 0, ...up.splice(from, 1));
    return [...up, ...down];
}

function attemptOrder(primary: ServiceType, plan: UploadPlan): ServiceType[] {
    return askBeforeFallback() && plan.order[0] === primary
        ? [primary, ...breakerOrder(plan.order.slice(1))]
        : breakerOrder(plan.order);
}

function describeForAsk(service: ServiceType, primary: ServiceType, size: number): string {
    if (service === ServiceType.SHAREX) {
        let name = "";
        try {
            name = parseShareXConfig(settings.store.sharexConfig || "").Name?.trim() ?? "";
        } catch { }
        return `${name || serviceLabel(service)} (custom uploader, may be public, not encrypted)`;
    }
    const info = SERVICES[service];
    const notes = [
        info.privacy === "public" ? "public" : "",
        SERVICES[primary]?.confidential && !info.confidential ? "not encrypted" : "",
        hostRetention(service, size)?.replace(/^public(, )?/, "") ?? ""
    ].filter(Boolean);
    return notes.length ? `${info.label} (${notes.join(", ")})` : info.label;
}

async function confirmFallback(service: ServiceType, primary: ServiceType, lead: string, fileName: string, size: number): Promise<boolean> {
    const label = serviceLabel(service);
    setUploadState({ phase: "retrying", currentService: service, currentServiceLabel: label, status: `Waiting for your answer: upload to ${label}?`, percent: 0, transferredBytes: 0, indeterminate: false, canCancel: true });
    const dialog = askToUseHost({
        title: `Upload ${fileName} to another host?`,
        question: `${lead}. Upload to ${describeForAsk(service, primary, size)} instead?`,
        confirmText: `Upload to ${label}`
    });
    wakeRetryWait = dialog.close;
    try {
        const ok = await dialog.answer;
        if (cancelRequested) throw new UploadCancelledError();
        if (!ok && dialog.failed) throw new UploadCancelledError(`The question before uploading to ${label} couldn't be shown, so the upload was cancelled`);
        return ok;
    } finally {
        wakeRetryWait = null;
    }
}

async function uploadWithFallbacks(fileBlob: UploadBody, filename: string, primary: ServiceType, displayName = filename): Promise<{ url: string; service: ServiceType; kept: KeptNow; }> {
    noticeProxyChange();
    await loadGofileGuest();
    proxyJob = { proxyUnreachable: false };
    gofileResent = false;
    const file = { name: filename, size: fileBlob.size };
    const plan = planUpload(primary, file);
    const rerun = rerunConfirmed?.service ?? null;
    const ordered = attemptOrder(primary, plan);
    const uploadOrder = rerun ? ordered.filter(s => s === rerun) : ordered;
    const moved = !rerun && uploadOrder[0] !== plan.order[0];

    if (!uploadOrder.length) {
        const message = rerun ? `${serviceLabel(rerun)} can no longer take ${displayName}` : noHostMessage(primary, file, plan);
        setUploadState({ phase: "failed", status: `${message}.`, canCancel: false, percent: 0 });
        throw new Error(message);
    }

    const ceiling = nativeCeilingText(file.size);
    if (ceiling) {
        setUploadState({ phase: "failed", status: `${ceiling}.`, canCancel: false, percent: 0 });
        throw new Error(ceiling);
    }

    const primarySkip = plan.skipped.find(s => s.service === primary);
    let summaryShown = false;
    const takeSummary = () => {
        if (summaryShown) return "";
        summaryShown = true;
        return summarizeSkips(plan.skipped.filter(s => s !== primarySkip), file);
    };
    if (primarySkip && !askBeforeFallback() && !rerun) {
        const key = `primary\n${primary}\n${primarySkip.reason}`;
        const repeat = (primarySkip.kind === "platform" || primarySkip.kind === "consent") && announcedSkips.has(key);
        announcedSkips.add(key);
        const note = landingNote(uploadOrder[0], primary, fileBlob.size);
        const direct = primarySkip.needsProxy && SERVICES[uploadOrder[0]].web === "user"
            ? `. ${serviceLabel(uploadOrder[0])} is tried directly and works only if its server allows discord.com` : "";
        const head = repeat ? "" : `${primarySkip.reason}. Using ${serviceLabel(uploadOrder[0])}${note ? ` (${note})` : ""}${direct}`;
        const text = [head, takeSummary()].filter(Boolean).join(". ");
        if (text) showToast({ text, duration: 8000 });
    }

    const attempted: string[] = [];
    let lastError = "Unknown error";
    let proxyNetworkErrors = 0;

    setUploadState({
        phase: "uploading",
        fileName: filename,
        totalAttempts: uploadOrder.length,
        attempt: 1,
        percent: 5,
        transferredBytes: 0,
        totalBytes: fileBlob.size,
        status: `Starting upload via ${serviceLabel(uploadOrder[0])}...`,
        currentService: uploadOrder[0],
        currentServiceLabel: serviceLabel(uploadOrder[0]),
        canCancel: true
    });

    const stillActive = (service: ServiceType) => service === settings.store.serviceType
        || (!settings.store.disableFallbacks && isFallbackActive(service) && httpFallbackAllowed(service));

    let withdrawn: string | null = null;
    let lateSkip: string | null = null;
    const ziplineSkip = async (service: ServiceType, facts: FileFacts): Promise<boolean> => {
        const { serviceUrl } = settings.store;
        if (!serviceUrl || typeof Native?.probeUrl !== "function" || !/^https:/i.test(serviceUrl.trim())) return false;
        if (ziplineProbeUrl(serviceUrl)) {
            setUploadState({ currentService: service, currentServiceLabel: serviceLabel(service), status: `Checking ${serviceLabel(service)}'s upload limits...`, canCancel: true });
        }
        await discoverZipline(serviceUrl);
        if (cancelRequested) throw new UploadCancelledError();
        const skip = fileSkip(service, facts);
        if (!skip) return false;
        plan.skipped.push(skip);
        lateSkip = skip.reason;
        return true;
    };

    hosts: for (const service of uploadOrder) {
        if (cancelRequested) throw new UploadCancelledError();

        if (!stillActive(service)) continue;
        const configError = getServiceConfigError(service);
        if (configError) {
            lastError = `${serviceLabel(service)} is not configured (${configError})`;
            continue;
        }

        if (service !== primary && rerun) {
            if (!askBeforeFallback() && !autoFallbackAllowed(primary, service)) continue;
        } else if (service !== primary) {
            if (askBeforeFallback()) {
                const failedLast = attempted.length ? `${attempted[attempted.length - 1]} failed` : primarySkip?.reason;
                const lead = lateSkip ? failedLast ? `${failedLast}, and ${lateSkip}` : lateSkip : failedLast ?? `${serviceLabel(primary)} failed`;
                if (!await confirmFallback(service, primary, lead, displayName, fileBlob.size)) throw new UploadCancelledError();
                if (!stillActive(service) || getServiceConfigError(service) || fileSkip(service, file)) {
                    withdrawn = serviceLabel(service);
                    continue;
                }
            } else if (!autoFallbackAllowed(primary, service)) {
                continue;
            }
        }

        if (service === ServiceType.ZIPLINE && await ziplineSkip(service, file)) {
            if (service !== primary && askBeforeFallback() && !attempted.length) withdrawn = serviceLabel(service);
            continue;
        }
        withdrawn = null;
        lateSkip = null;

        const attempt = attempted.length + 1;

        setUploadState({
            phase: attempt === 1 ? "uploading" : "retrying",
            attempt,
            currentService: service,
            currentServiceLabel: serviceLabel(service),
            transferredBytes: 0,
            totalBytes: fileBlob.size,
            percent: 0,
            indeterminate: false,
            status: attempt === 1
                ? `Uploading via ${serviceLabel(service)}...`
                : `Retrying with ${serviceLabel(service)} (${attempt}/${uploadOrder.length})...`
        });

        proxyPinned = null;
        pinnedOrigins.clear();
        for (let tries = 0; tries < 2; tries++) {
            const retried = tries > 0;
            attemptPoll = pollNativeUploadProgress();
            lastOutcome = null;
            requestsRetried = false;
            attemptProxy = null;
            attemptKept = {};
            proxyNote = null;
            try {
                const uploadedUrl = await withAttemptService(service, () => uploadToService(service, fileBlob, filename));

                if (cancelRequested) {
                    throw lateCancelError(uploadedUrl, service, displayName, fileBlob.size, keptNow());
                }

                const url = validateUploadedUrl(uploadedUrl, service);

                const origin = httpOriginOf(service);
                if (origin) rememberHttpOrigin(origin);
                if (batchMemory) batchMemory.lastSuccess = service;
                const proxied = attemptProxy as AttemptProxy | null;
                if (proxied?.remember) markProxyFirst(proxied.remember, proxied.proxy);
                if (proxied) announceProxiedUpload(proxied);

                if (service !== primary && (service !== uploadOrder[0] || (moved && !primarySkip))) {
                    const note = landingNote(service, primary, fileBlob.size);
                    const reason = attempted.length
                        ? `${attempted[attempted.length - 1]} failed`
                        : moved && !primarySkip
                            ? `${serviceLabel(plan.order[0])} failed recently`
                            : `${serviceLabel(uploadOrder[0])} was skipped`;
                    const summary = takeSummary();
                    showToast({
                        text: `${reason}. Uploaded via ${serviceLabel(service)} instead${note ? ` (${note})` : ""}${summary ? `. ${summary}` : ""}`,
                        variant: "success",
                        duration: 6000
                    });
                }

                setUploadState({
                    phase: "success",
                    percent: 100,
                    attempt,
                    currentService: service,
                    currentServiceLabel: serviceLabel(service),
                    status: `Uploaded successfully via ${serviceLabel(service)}${proxied ? proxied.anonymous ? " (anonymously, through the CORS proxy, so you can't delete it from your account)" : " (through the CORS proxy)" : ""}`,
                    canCancel: false
                });

                return { url, service, kept: keptNow() };
            } catch (error) {
                if (error instanceof CommittedUploadError) {
                    if (cancelRequested) throw lateCancelError(error.objectUrl, service, displayName, fileBlob.size, keptNow(), error);
                    const entry = service === ServiceType.WEBDAV ? keptUploadEntry(error.objectUrl, service, displayName, fileBlob.size, keptNow(), error) : null;
                    if (entry) {
                        entry.shareFailed = true;
                        setUploadState({ keptLink: entry });
                        announceKeptUpload(entry);
                    }
                    throw error;
                }
                if (isUploadCancelledError(error) || (error instanceof SpoolError || error instanceof NativeBusyError)) {
                    throw error;
                }
                const status = (lastOutcome as RequestOutcome | null)?.status ?? 0;
                if (attemptProxy as AttemptProxy | null && status >= 200 && status < 300 && !(error instanceof TransportError) && !(error instanceof RateLimitError)
                    && SERVICES[service].privacy === "public") {
                    throw new CommittedUploadError(`${serviceLabel(service)} may already have received the file through the CORS proxy, but no link came back. No other host was tried`);
                }

                const verdict = judgeFailure(service, error, attemptPoll?.stalled() ?? false);
                const proxyDown = isProxiedNetworkError(error) && ++proxyNetworkErrors >= 2;
                if (verdict?.retry && !retried && !proxyDown && !requestsRetried) {
                    logger.warn(`${serviceLabel(service)} failed, trying it once more: ${error instanceof Error ? error.message : "Unknown error"}`);
                    attemptPoll?.stop();
                    await waitToRetry(verdict);
                    if (stillActive(service) && !getServiceConfigError(service)) {
                        setUploadState({ status: `Trying ${serviceLabel(service)} again...`, percent: 0, transferredBytes: 0 });
                        continue;
                    }
                }

                if (verdict?.down && !isProxiedNetworkError(error)) markHostDown(healthKey(service));
                batchMemory?.failed.add(service);

                const why = proxyNote as ProxyNote | null;
                const note = why?.reason ? `; not retried through the CORS proxy: ${why.reason}`
                    : why?.hint ? ". Answer the CORS-proxy question when BigFileUpload asks at the next start" : "";
                const message = (error instanceof Error ? error.message : "Unknown error") + note;

                attempted.push(serviceLabel(service));
                lastError = message;
                logger.warn(`Upload failed for ${serviceLabel(service)}: ${message}`);
                setUploadState({
                    phase: "retrying",
                    attempt,
                    currentService: service,
                    currentServiceLabel: serviceLabel(service),
                    status: `${serviceLabel(service)} failed: ${message}`,
                    percent: Math.min(95, 10 + Math.round((attempt / uploadOrder.length) * 80))
                });

                if (proxyDown) {
                    lastError = `the CORS proxy (${describeRequestTarget(getActiveCorsProxyUrl())}) is unavailable (down, over its daily quota, or blocked). Check the proxy under BigFileUpload settings → Network`;
                    break hosts;
                }
                break;
            } finally {
                attemptPoll?.stop();
                attemptPoll = null;
                multipart = null;
                attemptKept = {};
                clearLateWaitTimer();
            }
        }
    }

    if (withdrawn) throw new UploadCancelledError(`${withdrawn} can no longer take ${displayName}, and no other active host can, so the upload was cancelled`);

    if (lateSkip && !attempted.length) {
        const message = noHostMessage(primary, file, planUpload(primary, file));
        setUploadState({ phase: "failed", status: `${message}.`, canCancel: false, percent: 0 });
        throw new Error(message);
    }

    const summary = takeSummary();
    const skippedNote = summary ? `. ${summary}` : "";
    const failed = `All upload services failed (${clientName()}, ${transportName()} transport). Last error: ${lastError}${skippedNote}`;
    setUploadState({
        phase: "failed",
        status: failed,
        canCancel: false,
        percent: 0
    });

    throw new Error(`${failed}. Tried: ${attempted.join(", ")}`);
}

const MAX_FILENAME_BYTES = 200;

const SNIFFED_ALIASES: Record<string, string[]> = {
    jpg: ["jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp"],
    png: ["png", "apng"],
    apng: ["png", "apng"],
    gif: ["gif"],
    webp: ["webp"]
};

function splitExtension(name: string): [stem: string, ext: string | undefined] {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1) : "";
    return /^[a-z0-9]{1,16}$/i.test(ext) ? [name.slice(0, dot), ext] : [name, undefined];
}

function decodeUrlSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function sanitizeFilename(name: string): string {
    return name.replace(/[\\/\x00-\x1f\x7f]/g, "_");
}

function capFilename(name: string): string {
    const encoder = new TextEncoder();
    const bytes = (text: string) => encoder.encode(text).length;
    if (bytes(name) <= MAX_FILENAME_BYTES) return name;

    const [stem, ext] = splitExtension(name);
    const tail = ext ? `.${ext}` : "";
    let left = MAX_FILENAME_BYTES - bytes(tail);
    let head = "";
    for (const char of stem) {
        left -= bytes(char);
        if (left < 0) break;
        head += char;
    }
    return head + tail;
}

async function normalizeUploadBlob(blob: UploadBody, sourceUrl?: string): Promise<{ blob: UploadBody; filename: string; originalFilename: string; }> {
    let sourceFileName = "";
    if (blob instanceof File && blob.name) {
        sourceFileName = blob.name;
    } else if (sourceUrl && URL.canParse(sourceUrl)) {
        const segment = new URL(sourceUrl).pathname.split("/").pop();
        if (segment) sourceFileName = decodeUrlSegment(segment);
    }
    sourceFileName = sanitizeFilename(sourceFileName);

    const sniffable = (body: UploadBody) => isSpooled(body) ? body.head : body;
    const sniffed = await getExtensionFromBytes(sniffable(blob), isSpooled(blob) ? spoolBytes(blob) : undefined);
    let [stem, ext] = splitExtension(sourceFileName);
    if (!sourceFileName) {
        ext = sniffed || getExtensionFromMime(blob.type) || (sourceUrl ? getUrlExtension(sourceUrl) : undefined);
    } else if (sniffed && !SNIFFED_ALIASES[sniffed].includes(ext?.toLowerCase() ?? "")) {
        ext = sniffed === "apng" ? "png" : sniffed;
    }

    if (sniffed === "apng" && settings.store.apngToGif) {
        if (blob.size > APNG_TO_GIF_MAX_BYTES) {
            showToast({ text: "APNG is too large to convert to GIF. Uploading as APNG" });
        } else {
            const gifBlob = await convertApngToGif(isSpooled(blob) ? await readSpooledFile(blob) : blob, () => {
                if (cancelRequested) throw new UploadCancelledError();
            });
            if (gifBlob) {
                blob = gifBlob;
                ext = "gif";
            } else {
                showToast({ text: "Couldn't convert the APNG to GIF. Uploading as APNG", variant: "critical" });
            }
        }
    }

    const mappedMime = /^(?:ogg|oga|opus)$/i.test(ext ?? "") && await isOggVideo(sniffable(blob)) ? "video/ogg" : getMimeFromExtension(ext);
    const mimeType = mappedMime !== "application/octet-stream" ? mappedMime : (blob.type || mappedMime);
    const filename = settings.store.preserveOriginalFilename && sourceFileName
        ? (ext ? `${stem}.${ext}` : stem)
        : `upload.${ext || "bin"}`;

    return {
        blob: isSpooled(blob) ? { ...blob, type: mimeType } : new Blob([blob], { type: mimeType }),
        filename: capFilename(filename),
        originalFilename: sourceFileName
    };
}

const SPOILER_PREFIX = "SPOILER_";

const checkedBuckets = new Set<string>();

export const canCheckS3PublicRead = () => IS_WEB || typeof Native?.probeUrl === "function";

async function checkS3PublicRead(url: string): Promise<void> {
    try {
        const { s3PublicUrl, s3Endpoint, s3Bucket } = settings.store;
        if (s3PublicUrl?.trim() || !URL.canParse(url) || hasSecretQuery(new URL(url))) return;
        const bucket = `${s3Endpoint?.trim()} ${s3Bucket?.trim()}`;
        if (checkedBuckets.has(bucket) || !canCheckS3PublicRead()) return;
        let status: number | undefined;
        if (IS_WEB) {
            const response = await fetch(url, { method: "HEAD", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(10000) }).catch(() => null);
            status = response?.status;
        } else if (new URL(url).protocol === "https:") {
            const result = await Native!.probeUrl(url, "HEAD").catch(() => null);
            if (result?.ok) status = result.status;
        }
        if (status === undefined || checkedBuckets.has(bucket)) return;
        checkedBuckets.add(bucket);
        if (status !== 401 && status !== 403) return;
        showToast({ text: `The S3 link isn't publicly readable (HTTP ${status}). Set a Public Base URL, or allow anonymous reads on the bucket`, duration: 10000 });
    } catch (error) {
        logger.warn("S3 read check failed", error);
    }
}

async function uploadPreparedBlob(blob: UploadBody, target: UploadTarget, sourceUrl?: string, batch?: BatchLinks, item?: OfferItem): Promise<string> {
    currentTarget = target;
    currentItem = item ?? null;
    try {
        const primary = selectedHost();
        const { blob: normalizedBlob, filename, originalFilename } = await normalizeUploadBlob(blob, sourceUrl);
        setUploadState({ fileName: filename, status: "File ready, starting upload...", percent: 4 });
        const displayName = originalFilename || filename;
        const spoiler = Boolean(target.spoiler) || originalFilename.startsWith(SPOILER_PREFIX);
        const dims = startEmbedChecks(normalizedBlob, filename, primary, target, displayName);
        let result: Awaited<ReturnType<typeof uploadWithFallbacks>>;
        try {
            result = await uploadWithFallbacks(normalizedBlob, filename, primary, displayName);
        } catch (error) {
            if (isUploadCancelledError(error)) settleOfferItem(item);
            throw error;
        }
        settleOfferItem(item);
        const { url: uploadedUrl, service, kept } = result;
        const plain = finalizeUploadedUrl(uploadedUrl, service);
        const wrapped = outputsCanEmbed(plain, target, displayName)
            ? await embedLink(plain, { service, size: normalizedBlob.size, contentType: normalizedBlob.type, dims })
            : plain;
        if (cancelRequested) throw lateCancelError(uploadedUrl, service, displayName, normalizedBlob.size, kept);
        keepInHistory(linkOf(plain), service, normalizedBlob.size, kept);
        await notifyUploadSuccess({ plain, wrapped }, target, displayName, batch, spoiler);
        if (service === ServiceType.S3) void checkS3PublicRead(uploadedUrl);
        return wrapped;
    } finally {
        void releaseSpool();
        currentItem = null;
    }
}

function endUploadSession() {
    if (droppedJobs) showToast({ text: `Cancelled ${queuedName(droppedJobs)}` });
    droppedJobs = 0;
    isUploading = false;
    multipart = null;
    batchMemory = null;
    activeAbortController = null;
    activeXhr = null;
    clearLateWaitTimer();
    cancelStage = "none";
    finishUploadState();
}

function failureText(error: unknown): string {
    const message = error instanceof Error ? error.message : "Unknown error";
    return error instanceof CommittedUploadError ? message : `Upload failed: ${message}`;
}

function reportCancel(error: unknown): void {
    cancelStage = "none";
    clearLateWaitTimer();
    if (error instanceof LateCancelError) {
        const { entry } = error;
        announceLateCancel(entry);
        const dropped = takeDroppedCount();
        if (dropped) showToast({ text: `Cancelled ${queuedName(dropped)}` });
        setUploadState({ phase: "cancelled", status: `Cancelled after upload. ${entry.fileName} is on ${entry.hostLabel}`, canCancel: false, lateWait: false, percent: 0, keptLink: entry });
        return;
    }
    const dropped = takeDroppedCount();
    const reason = error instanceof UploadCancelledError ? error.reason : undefined;
    const text = lateWaitHost
        ? `${dropped ? cancelledAll(dropped) : "Cancelled"}. ${lateWaitHost} may have kept the file, but no link came back`
        : reason
            ? dropped ? `${reason}. Also cancelled ${queuedName(dropped)}` : reason
            : dropped ? cancelledAll(dropped) : "Upload cancelled";
    showToast({ text });
    setUploadState({ phase: "cancelled", status: reason || "Upload cancelled", canCancel: false, lateWait: false, percent: 0 });
}

async function copyBatchLinks({ urls, divertedUrls, insertFailedUrls = [] }: BatchLinks, target: UploadTarget, text: string): Promise<void> {
    try {
        await copyToClipboard(urls.join("\n"));
        showToast(insertFailedUrls.length
            ? { text: "Links copied. Some couldn't be inserted into the chatbox", duration: 8000 }
            : divertedUrls.length
            ? { text: divertedNotice(target, divertedUrls.length, urls.length), duration: 8000 }
            : { text, variant: "success" });
    } catch (error) {
        logger.warn("Batch upload succeeded but clipboard copy failed", error);
        const stranded = [...divertedUrls, ...insertFailedUrls];
        if (stranded.length) reportStrandedLinks(stranded, "uploaded but not inserted or copied");
        else showToast({ text: "Uploads succeeded, but the links couldn't be copied" });
    }
}

export async function uploadFile(url: string, target: UploadTarget = { channelId: SelectedChannelStore.getChannelId() }, discordProxyUrl?: string): Promise<void> {
    const blocked = uploadBlocker();
    if (blocked) {
        showToast({ text: blocked, variant: "critical", duration: 8000 });
        return;
    }

    const segment = URL.canParse(url) ? new URL(url).pathname.split("/").pop() : "";
    const name = sanitizeFilename(segment ? decodeUrlSegment(segment) : "");
    await enqueueUpload(name || "the file", job => runUrlUpload(url, target, discordProxyUrl, job), name ? [name] : []);
}

async function runUrlUpload(url: string, target: UploadTarget, discordProxyUrl: string | undefined, job: UploadJob): Promise<boolean> {
    const blocked = uploadBlocker();
    if (blocked) {
        showToast({ text: blocked, variant: "critical", duration: 8000 });
        return false;
    }

    beginUploadSession();
    clearScheduledResetUploadState();
    setUploadState({
        phase: "preparing",
        channelId: target.channelId ?? null,
        draftType: target.draftType ?? null,
        composer: target.composer ?? null,
        fileName: "",
        currentService: null,
        currentServiceLabel: "",
        attempt: 0,
        totalAttempts: 0,
        percent: 1,
        transferredBytes: 0,
        totalBytes: 0,
        status: "Preparing upload...",
        canCancel: true,
        lateWait: false,
        keptLink: job.queuedBehind ? uploadState.keptLink : null
    });

    try {
        const sources = [discordProxyUrl, url]
            .filter((source): source is string => Boolean(source))
            .map(source => source.includes("/stickers/") && source.includes("passthrough=false")
                ? source.replace("passthrough=false", "passthrough=true")
                : source);
        const fetchUrl = sources[sources.length - 1];
        const isPageInstead = (source: string, type: string | undefined) => source !== sources[sources.length - 1] && /^text\/html/i.test(type || "");

        let blob: UploadBody | null = null;
        let contentType = "";
        const limit = downloadLimit();
        const maxBytes = limit ?? undefined;
        let refused: string | null = null;
        const refusalOf = (source: string, res: { success: boolean; policy?: true; error?: string; }) =>
            !res.success && res.policy && source === fetchUrl ? `Couldn't download ${describeRequestTarget(source)}: ${res.error}` : null;
        let originalFailure: SourceFailureFacts | null = null;

        if (Native) {
            const native = Native;
            const streamed = canSpool() && typeof native.fetchToSpool === "function" && typeof native.spoolRead === "function";
            const download = (source: string, viaProxy?: true) => streamed
                ? native.fetchToSpool(source, getUploadTimeoutMs(), SPOOL_SESSION, maxBytes, viaProxy)
                : native.fetchFile(source, getUploadTimeoutMs(), maxBytes, viaProxy);
            const take = (res: Awaited<ReturnType<typeof download>>, source: string, proxied = false): boolean => {
                if ("busy" in res && res.busy) throw new NativeBusyError(res.error);
                const page = res.success && isPageInstead(source, res.contentType);
                if (res.success && "id" in res && (cancelRequested || page)) void native.spoolRelease(res.id).catch(() => {});
                if (cancelRequested || ("cancelled" in res && res.cancelled)) throw new UploadCancelledError();
                if (!res.success && res.tooLarge) throw downloadTooLarge(source, res.size ?? 0);
                if (!res.success) {
                    logger.warn(`Couldn't download ${describeRequestTarget(source)} ${proxied ? "through the CORS proxy" : "in the main process"}: ${res.error}`);
                    refused ??= refusalOf(source, res);
                    if (source === fetchUrl) originalFailure = res;
                    return false;
                }
                if (page) return false;
                contentType = res.contentType || "";
                if ("id" in res) {
                    blob = { kind: "spool", id: res.id, size: res.size, type: contentType, head: new Blob([res.head]), sha256: res.sha256 };
                    adoptSpool(blob);
                } else if (res.data) {
                    blob = new Blob([res.data], { type: contentType });
                }
                return blob !== null;
            };
            for (const source of sources) {
                const stopPoll = pollNativeDownload();
                if (take(await download(source).finally(stopPoll), source)) break;
            }
            if (!blob && refused) throw new Error(refused);
            if (!blob && originalFailure && sourceProxyAllowed(fetchUrl, originalFailure)) {
                take(await fetchFileThroughProxy(fetchUrl, viaProxy => download(viaProxy, true)), fetchUrl, true);
            }
            if (!blob) {
                const held = streamed ? Math.min(limit ?? Infinity, NATIVE_MAX_BUFFER) : limit;
                const tooLarge = (source: string, size: number) => streamed && (limit === null || size <= limit)
                    ? new DownloadTooLargeError("The desktop app couldn't download this file itself, and files over 1.9 GB can't be downloaded any other way")
                    : downloadTooLarge(source, size);
                const fetched = await fetchBlobWithTimeout(fetchUrl, false, held, tooLarge);
                blob = fetched.blob;
                contentType = fetched.contentType;
            }
        } else {
            let fetched: { blob: Blob; contentType: string; } | null = null;
            let directError: unknown = null;
            for (const source of sources) {
                try {
                    fetched = await fetchBlobWithTimeout(source, false, limit);
                    if (!isPageInstead(source, fetched.contentType)) break;
                    fetched = null;
                } catch (error) {
                    if (isUploadCancelledError(error) || error instanceof DownloadTooLargeError) throw error;
                    if (source === fetchUrl) directError = error;
                    else directError ??= error;
                }
            }

            if (!fetched && proxyAllowedHere() && URL.canParse(fetchUrl) && proxySourceAllowed(new URL(fetchUrl))) {
                fetched = await fetchBlobWithTimeout(fetchUrl, true, limit);
            }

            if (!fetched) {
                throw directError instanceof Error ? directError : new Error("Couldn't download the file (network error)");
            }
            blob = fetched.blob;
            contentType = fetched.contentType;
        }

        if (contentType && !blob.type && !isSpooled(blob)) {
            blob = new Blob([blob], { type: contentType });
        }

        setUploadState({ phase: "preparing", indeterminate: false, percent: 1, transferredBytes: 0, totalBytes: 0, status: "Preparing upload..." });
        await uploadPreparedBlob(blob, target, url, undefined, { kind: "url", url, discordProxyUrl });
        return true;
    } catch (error) {
        if (isUploadCancelledError(error)) {
            reportCancel(error);
        } else {
            const message = failureText(error);
            showToast({ text: message, variant: "critical", duration: 8000 });
            logger.error("Upload error", loggable(error));
            setUploadState({ phase: "failed", status: message, canCancel: false, percent: 0 });
        }
        return false;
    } finally {
        void releaseSpool();
        endUploadSession();
    }
}

export async function uploadPickedFile(target: UploadTarget = { channelId: SelectedChannelStore.getChannelId() }): Promise<void> {
    const blocked = uploadBlocker();
    if (blocked) {
        showToast({ text: blocked, variant: "critical", duration: 8000 });
        return;
    }

    const file = await chooseFile("*/*");
    if (!file) return;

    if (!isFileTypeAllowed(file)) {
        showToast({ text: "This file type is excluded under Allowed File Types", variant: "critical" });
        return;
    }

    await uploadProvidedFiles([file], target);
}

export async function uploadProvidedFiles(files: readonly File[], target: UploadTarget = { channelId: SelectedChannelStore.getChannelId() }): Promise<boolean> {
    const blocked = uploadBlocker();
    if (blocked) {
        showToast({ text: blocked, variant: "critical", duration: 8000 });
        return false;
    }

    if (!files.length) return false;

    const uploadFiles = files.filter(file => Boolean(file) && (target.confirmed || isFileTypeAllowed(file)));
    if (!uploadFiles.length) return false;

    const name = uploadFiles.length > 1 ? `${uploadFiles.length} files` : uploadFiles[0].name || "the file";
    return enqueueUpload(name, job => runFilesUpload(uploadFiles, target, job), uploadFiles.map(f => f.name), uploadFiles.reduce((sum, f) => sum + f.size, 0));
}

export function takeoverNoticeText(file: FileFacts, alwaysIntercept: boolean): string | null {
    const primary = selectedHost();
    const plan = planUpload(primary, file);
    const first = plan.order[0];
    if (first === undefined) return null;
    const why = first === primary ? undefined : plan.skipped.find(s => s.service === primary)?.reason;
    const what = alwaysIntercept ? "Files you attach" : "Files over Discord's limit";
    return `${what} will be uploaded to ${describeForAsk(first, primary, file.size)}${why ? `, because ${why}` : ""}.`;
}

export function offerHost(file: FileFacts): { service: ServiceType; label: string; description: string; } | null {
    const primary = selectedHost();
    const first = attemptOrder(primary, planUpload(primary, file))[0];
    return first === undefined ? null : { service: first, label: serviceLabel(first), description: describeForAsk(first, primary, file.size) };
}

async function firstTakeoverNotice(files: readonly File[]): Promise<boolean> {
    if (settings.store.takeoverNoticeShown) return true;
    await whenPromptIdle();
    const alwaysIntercept = !settings.store.bypassDiscordUploadOnlyOverLimit;
    const text = takeoverNoticeText(files[0], alwaysIntercept);
    if (!text) {
        showToast({ text: "No upload host is available. Check your host settings, then attach again", duration: 8000 });
        return false;
    }
    if (alwaysIntercept) {
        settings.store.takeoverNoticeShown = true;
        notifyTakeover(text);
        return true;
    }
    const answer = await askTakeover(text);
    if (answer === "upload" || answer === "choose") settings.store.takeoverNoticeShown = true;
    if (answer === "upload") return true;
    const what = files.length > 1 ? `${files.length} files weren't` : `${files[0].name} wasn't`;
    showToast({ text: answer === "choose" ? `${what} sent. Choose an upload host, then attach again` : `${what} sent. ${answer === "failed" ? "The upload question couldn't be shown. " : ""}Attach again to retry`, duration: 8000 });
    if (answer === "choose") openPluginSettings();
    return false;
}

async function runFilesUpload(uploadFiles: File[], target: UploadTarget, job: UploadJob): Promise<boolean> {
    const blocked = uploadBlocker();
    if (blocked) {
        showToast({ text: blocked, variant: "critical", duration: 8000 });
        return false;
    }
    if (target.stillWanted && !target.stillWanted()) {
        showToast({ text: `${uploadFiles[0].name} was removed from the draft, so it wasn't uploaded` });
        return false;
    }
    if (target.automatic && !await firstTakeoverNotice(uploadFiles)) return false;

    beginUploadSession();
    clearScheduledResetUploadState();
    setUploadState({ channelId: target.channelId ?? null, draftType: target.draftType ?? null, composer: target.composer ?? null, keptLink: job.queuedBehind ? uploadState.keptLink : null, lateWait: false });

    const batch: BatchLinks | undefined = uploadFiles.length > 1 ? { urls: [], divertedUrls: [] } : undefined;
    batchMemory = batch ? { lastSuccess: null, failed: new Set() } : null;

    try {
        const failures: string[] = [];

        for (let i = 0; i < uploadFiles.length; i++) {
            const file = uploadFiles[i];
            const current = i + 1;
            const suffix = uploadFiles.length > 1 ? ` (${current}/${uploadFiles.length})` : "";

            setUploadState({
                phase: "preparing",
                fileName: file.name,
                currentService: null,
                currentServiceLabel: "",
                attempt: 0,
                totalAttempts: 0,
                percent: 2,
                transferredBytes: 0,
                totalBytes: 0,
                status: `Preparing ${file.name}${suffix}...`,
                canCancel: true
            });

            try {
                await uploadPreparedBlob(file, target, undefined, batch, { kind: "file", file });
            } catch (error) {
                if (isUploadCancelledError(error) || error instanceof NativeBusyError || uploadFiles.length === 1) throw error;

                const message = error instanceof Error ? error.message : "Unknown error";
                failures.push(`${file.name} (${message})`);
                logger.error(`Upload failed for ${file.name}`, loggable(error));
            }
        }

        if (batch?.urls.length) {
            await copyBatchLinks(batch, target, `Upload complete. ${batch.urls.length} URLs copied to clipboard`);
        }

        if (failures.length) {
            const summary = `Uploaded ${uploadFiles.length - failures.length} of ${uploadFiles.length} files. Failed: ${failures.join("; ")}`;
            showToast({ text: summary, variant: "critical", duration: 10000 });
            setUploadState({ phase: "failed", status: summary, canCancel: false, percent: 0 });
            return false;
        }

        return true;
    } catch (error) {
        const cancelled = isUploadCancelledError(error);
        if (cancelled) reportCancel(error);
        if (batch?.urls.length && (!cancelled || settings.store.autoCopy)) {
            const n = batch.urls.length;
            await copyBatchLinks(batch, target, `${n} ${n === 1 ? "link" : "links"} copied`);
        } else if (batch && (batch.divertedUrls.length || batch.insertFailedUrls?.length)) {
            reportStrandedLinks([...batch.divertedUrls, ...batch.insertFailedUrls ?? []], "uploaded but not inserted or copied");
        }
        if (!cancelled) {
            const message = failureText(error);
            showToast({ text: message, variant: "critical", duration: 8000 });
            logger.error("Manual upload error", loggable(error));
            setUploadState({ phase: "failed", status: message, canCancel: false, percent: 0 });
        }

        return false;
    } finally {
        endUploadSession();
    }
}

const HOST_CHANGED = "This host's settings changed. Delete the file on the server";

const DELETE_RESTART_TEXT = "Fully restart Discord or Vesktop to finish updating BigFileUpload, then delete it again";

const originOf = (raw: unknown) => typeof raw === "string" && URL.canParse(raw.trim()) ? new URL(raw.trim()).origin : null;

export function deletionProblem(entry: HistoryEntry): string | null {
    const { deletion } = entry;
    if (!deletion) return null;
    const { store } = settings;
    switch (deletion.kind) {
        case "catbox":
            if (!store.catboxUserhash?.trim()) return HOST_CHANGED;
            break;
        case "pixeldrain":
            if (!store.pixelDrainKey?.trim()) return HOST_CHANGED;
            break;
        case "webdav":
            if (originOf(store.webdavUrl) !== entry.endpoint.origin || originOf(deletion.url) !== entry.endpoint.origin) return HOST_CHANGED;
            break;
        case "s3":
            if (!entry.s3 || store.s3Endpoint?.trim() !== entry.s3.endpoint || store.s3Bucket?.trim() !== entry.s3.bucket
                || !store.s3AccessKeyId || !store.s3SecretAccessKey) return HOST_CHANGED;
            break;
        case "0x0":
            if (!Native) return "Deleting from 0x0.st works in Discord Desktop and Vesktop only";
            break;
        case "sharex":
            if (!Native && deletion.url.startsWith("http:")) return "Deleting over plain http works in Discord Desktop and Vesktop only";
            break;
    }
    const target = "url" in deletion && URL.canParse(deletion.url) ? new URL(deletion.url) : null;
    if (target?.protocol === "http:" && httpHostKind(target.hostname) === "public") return "BigFileUpload deletes over plain http only on a local network. Delete the file on the server";
    if (deletion.kind !== "sharex" && needsProxyHere(entry.service)) return `Deleting it needs ${neededProxy()}`;
    if (deletion.kind !== "sharex" && SERVICES[entry.service]?.web === "proxy" && credentialHeldBack(entry.service)) {
        return "Deleting it sends your credential through the CORS proxy: accept the CORS proxy on this device first (BigFileUpload → Network)";
    }
    return null;
}

interface DeleteRequest {
    url: string;
    method: "GET" | "POST" | "DELETE";
    headers?: Record<string, string>;
    form?: Record<string, string>;
    publicOnly?: boolean;
}

async function deleteRequestFor(entry: HistoryEntry, deletion: Deletion): Promise<DeleteRequest> {
    const { store } = settings;
    switch (deletion.kind) {
        case "catbox":
            return { url: "https://catbox.moe/user/api.php", method: "POST", form: { reqtype: "deletefiles", userhash: store.catboxUserhash!.trim(), files: deletion.file } };
        case "0x0":
            return { url: deletion.url, method: "POST", headers: { "User-Agent": ZEROX0_USER_AGENT }, form: { token: deletion.token, delete: "" } };
        case "pixeldrain":
            return { url: `https://pixeldrain.com/api/file/${encodeURIComponent(deletion.id)}`, method: "DELETE", headers: { Authorization: `Basic ${utf8ToBase64(`:${store.pixelDrainKey!.trim()}`)}` } };
        case "webdav": {
            const auth = buildWebdavAuthHeader();
            return { url: deletion.url, method: "DELETE", headers: auth ? { Authorization: auth } : {} };
        }
        case "s3":
            return { url: deletion.url, method: "DELETE", headers: await signS3Delete(deletion.url) };
        case "sharex": {
            const { protocol, origin } = new URL(deletion.url);
            const sameOrigin = origin === entry.endpoint.origin;
            if (protocol !== "https:" && !(protocol === "http:" && sameOrigin)) throw new Error("its deletion link isn't https");
            return { url: deletion.url, method: "GET", publicOnly: !sameOrigin };
        }
    }
}

const MAX_DELETE_ANSWER = 16384;

const UNREAD_STATUS = -1;

async function sendDeleteRequest(service: ServiceType, kind: Deletion["kind"], request: DeleteRequest): Promise<{ status: number; text: string; }> {
    if (Native) {
        if (typeof Native.deleteRequest !== "function") throw new Error(DELETE_RESTART_TEXT);
        const result = await Native.deleteRequest(request);
        if (!result.success) throw new Error(result.error || "Unknown error");
        return { status: result.status ?? 0, text: result.body ?? "" };
    }
    if (request.publicOnly && !isProxyReachableHost(new URL(request.url).hostname)) throw new Error("its deletion link points to a local address");
    const sharex = kind === "sharex";
    const viaProxy = !sharex && requestRoute(service) === "proxy";
    let response: Response;
    try {
        response = await fetch(viaProxy ? viaCorsProxy(request.url) : request.url, {
            method: request.method,
            headers: request.headers,
            ...request.form && { body: new URLSearchParams(request.form) },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "manual",
            signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
        });
    } catch (error) {
        if (sharex && error instanceof TypeError) return { status: UNREAD_STATUS, text: "" };
        throw error;
    }
    if (response.type === "opaqueredirect") return { status: 302, text: "" };
    return { status: response.status, text: await readCapped(response, MAX_DELETE_ANSWER) };
}

type DeleteOutcome = { done: "deleted" | "gone"; } | { failed: string; } | { unread: true; };

const CREDENTIALED_DELETES: ReadonlySet<Deletion["kind"]> = new Set(["webdav", "pixeldrain", "s3"]);

function judgeDeletion(service: ServiceType, kind: Deletion["kind"], status: number, text: string): DeleteOutcome {
    if (status === UNREAD_STATUS) return { unread: true };
    if (status === 404 || status === 410) {
        return CREDENTIALED_DELETES.has(kind)
            ? { failed: "no file there with the current login. It may already be gone. If so, remove it from the history" }
            : { done: "gone" };
    }
    if (kind === "sharex") return status >= 200 && status < 400 ? { done: "deleted" } : { failed: describeHttpFailure(service, status, text) };
    if (status >= 200 && status < 300) {
        if (kind === "catbox" && !/deleted|success/i.test(text)) return { failed: cleanHostText(text) || "Catbox didn't confirm the deletion" };
        return { done: "deleted" };
    }
    if (status >= 300 && status < 400) return { failed: `${status} (a redirect, which isn't followed)` };
    return { failed: describeHttpFailure(service, status, text) };
}

export async function deleteFromHistory(entry: HistoryEntry): Promise<boolean> {
    const { deletion } = entry;
    const label = serviceLabel(entry.service);
    if (!deletion || isDeleting(entry.id)) return false;
    const problem = deletionProblem(entry);
    if (problem) {
        showToast({ text: problem });
        return false;
    }
    setDeleting(entry.id, true);
    try {
        const request = await deleteRequestFor(entry, deletion);
        if (!request.publicOnly && !await originApproved(request.url)) {
            showToast({ text: "Deletion cancelled" });
            return false;
        }
        const { status, text } = await sendDeleteRequest(entry.service, deletion.kind, request);
        const outcome = judgeDeletion(entry.service, deletion.kind, status, text);
        if ("failed" in outcome) {
            showToast({ text: `Couldn't delete it from ${label}: ${outcome.failed}`, variant: "critical", duration: 8000 });
            return false;
        }
        if ("unread" in outcome) {
            showToast({ text: `Tried to delete it from ${label}, but its answer can't be read here. Check the link. If the file is gone, remove it from the history`, duration: 8000 });
            return false;
        }
        await removeHistoryEntry(entry.id);
        showToast({
            text: outcome.done === "gone" ? `It was already gone from ${label}`
                : deletion.kind === "sharex" ? `${label} accepted the deletion request` : `Deleted from ${label}`,
            variant: "success"
        });
        return true;
    } catch (error) {
        const message = redactText(error instanceof Error ? error.message : "Unknown error");
        logger.warn(`Couldn't delete a file from ${label}: ${message}`);
        showToast({ text: `Couldn't delete it from ${label}: ${message}`, variant: "critical", duration: 8000 });
        return false;
    } finally {
        setDeleting(entry.id, false);
    }
}

setDeleteActions(entry => ({
    label: `Delete from ${serviceLabel(entry.service)}`,
    problem: deletionProblem(entry),
    run: () => deleteFromHistory(entry)
}));
