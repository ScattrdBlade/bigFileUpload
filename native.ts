/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, Hash, randomUUID } from "crypto";
import { subscribe } from "diagnostics_channel";
import { lookup } from "dns/promises";
import { IpcMainInvokeEvent, WebContents } from "electron";
import { constants, rmSync } from "fs";
import { FileHandle, lstat, mkdir, open, readdir, stat, statfs, unlink } from "fs/promises";
import { isIP } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { classifyFetchError, classifyHttpBlock, describeNetworkError, firstErrorCode, httpHostKind, httpLanOnlyText, isDnsCode, isPrivateAddress, isPublicSourceAddress, NATIVE_MAX_BUFFER, NativeErrorCode, PROXY_RETRY_KINDS, RESPONSE_GRACE_MS, SPOOL_HEAD_BYTES, SPOOL_MAX_BYTES, SPOOL_SLICE_BYTES, SpoolSource, UploadAbortError, UploadFailure } from "./utils/shared";

let uploadProgress: { loaded: number; total: number; phase?: "downloading"; } = { loaded: 0, total: 0 };

export async function getUploadProgress(_: IpcMainInvokeEvent): Promise<{ loaded: number; total: number; phase: "uploading" | "downloading"; stallWatch: true; }> {
    const { loaded, total, phase = "uploading" } = uploadProgress;
    return { loaded, total, phase, stallWatch: true };
}

let abortLatch: UploadAbortError | null = null;

let uploadRunning = false;

function latchAbort(reason: UploadAbortError["reason"]): void {
    if (!abortLatch || reason === "user") abortLatch = new UploadAbortError(reason);
    if (reason === "user") stallText = null;
    activeUploadController?.abort(abortLatch);
    activeUploadController = null;
}

let lateCancel = false;

let pendingTarget: string | null = null;

let bodySent = false;

const isPending = (message: unknown) => {
    const { request } = message as { request?: { origin?: unknown; path?: unknown; }; };
    return Boolean(pendingTarget && request && `${request.origin}${request.path}` === pendingTarget);
};

subscribe("undici:request:bodySent", message => {
    if (isPending(message)) bodySent = true;
});

let headersSent = false;

let sendHeadersSeen = false;

let pulls = 0;

const PREFETCH_PULLS = 2;

let remoteAddress: string | undefined;

subscribe("undici:client:sendHeaders", message => {
    sendHeadersSeen = true;
    if (!isPending(message)) return;
    headersSent = true;
    const address = (message as { socket?: { remoteAddress?: unknown; }; }).socket?.remoteAddress;
    if (typeof address === "string") remoteAddress = address;
});

function addressesOf(error: unknown): string[] {
    const found = new Set<string>();
    const queue = [error];
    for (let i = 0; i < 16 && queue.length; i++) {
        const e = queue.shift() as { address?: unknown; cause?: unknown; errors?: unknown; } | null;
        if (!e || typeof e !== "object") continue;
        if (typeof e.address === "string") found.add(e.address);
        if (e.cause) queue.push(e.cause);
        if (Array.isArray(e.errors)) queue.push(...e.errors);
    }
    return [...found];
}

function failureOf(error: unknown): UploadFailure {
    const stage = bodySent ? "response" : headersSent || pulls > PREFETCH_PULLS ? "body" : "connect";
    const stageReliable = sendHeadersSeen || stage !== "connect";
    const addresses = addressesOf(error);
    return {
        stage, code: firstErrorCode(error), stageReliable,
        kind: classifyFetchError(error, stage, stageReliable, abortLatch?.reason),
        ...addresses.length && { addresses }
    };
}

let stallText: string | null = null;

const userCancelled = () => abortLatch?.reason === "user" || lateCancel;

const stoppedMessage = () => userCancelled() ? "Upload cancelled by user" : stallText ?? "No upload progress, so the request was stopped";

const DEFAULT_STALL_MS = 60000;

const duration = (ms: number) => ms >= 120000 && ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 1000)} s`;

let lastProgressAt = 0;

const touch = () => {
    lastProgressAt = Date.now();
};

let bodyDone = false;

function watchForStall(stallMs: number): () => void {
    touch();
    bodyDone = false;
    const timer = setInterval(() => {
        if (abortLatch) return;
        const answering = bodyDone || (uploadProgress.total > 0 && uploadProgress.loaded >= uploadProgress.total);
        const limit = answering ? Math.max(stallMs, RESPONSE_GRACE_MS) : stallMs;
        if (Date.now() - lastProgressAt <= limit) return;
        stallText = answering
            ? `No answer for ${duration(limit)} after the ${uploadProgress.total > 0 ? "whole file" : "request"} was sent, so the request was stopped`
            : `No upload progress for ${duration(limit)}, so the request was stopped`;
        latchAbort("stalled");
    }, Math.min(1000, Math.max(50, stallMs / 4)));
    return () => clearInterval(timer);
}

export async function resetUploadProgress(_: IpcMainInvokeEvent): Promise<void> {
    uploadProgress = { loaded: 0, total: 0 };
    abortLatch = null;
    lateCancel = false;
    stallText = null;
}

let activeUploadController: AbortController | null = null;

export async function cancelUpload(_: IpcMainInvokeEvent, reason: "user" | "stalled" = "user"): Promise<void> {
    latchAbort(reason === "stalled" ? "stalled" : "user");
}

export async function cancelUploadUnlessBodySent(_: IpcMainInvokeEvent): Promise<boolean> {
    if (uploadRunning && bodySent) {
        lateCancel = true;
        return true;
    }
    latchAbort("user");
    return false;
}

interface Spool {
    owner: number;
    session: string;
    path: string;
    dev: number;
    ino: number;
    limit: number;
    written: number;
    hash: Hash;
    sha256?: string;
    file?: FileHandle;
    writing?: Promise<unknown>;
}

const spools = new Map<string, Spool>();

const MAX_SPOOLS = 8;

const SPOOL_FREE_MARGIN = 512 * 1024 * 1024;

const ROOM_CHECK_BYTES = 256 * 1024 * 1024;

const SPOOL_NAME = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STALE_SPOOL_MS = 2 * 24 * 60 * 60 * 1000;

const spoolDir = () => {
    const uid = process.getuid?.();
    return join(tmpdir(), uid === undefined ? "vc-bigfileupload" : `vc-bigfileupload-${uid}`);
};

async function isPrivateDir(dir: string): Promise<boolean> {
    if (process.platform === "win32" || typeof process.getuid !== "function") return true;
    try {
        const info = await lstat(dir);
        return info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0;
    } catch {
        return false;
    }
}

async function openSpoolFile(spool: { path: string; dev: number; ino: number; }): Promise<FileHandle> {
    const file = await open(spool.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const { dev, ino } = await file.stat();
        if (dev !== spool.dev || ino !== spool.ino) throw new Error("The temporary upload file was replaced");
        return file;
    } catch (error) {
        await file.close().catch(() => { });
        throw error;
    }
}

const errorCodeOf = (error: unknown) => (error as { code?: unknown; } | null)?.code;

const gigabytes = (bytes: number) => bytes % 2 ** 30 === 0 ? `${bytes / 2 ** 30} GB` : `${Math.ceil(bytes / 1e8) / 10} GB`;

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCodeOf(error) === "EPERM";
    }
}

async function sweepSpools(): Promise<void> {
    const dir = spoolDir();
    if (!await isPrivateDir(dir)) return;
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return;
    }
    const ours = new Set([...spools.values()].map(spool => spool.path));
    for (const name of names) {
        const match = SPOOL_NAME.exec(name);
        const path = join(dir, name);
        if (!match || ours.has(path)) continue;
        const pid = Number(match[1]);
        try {
            const { mtimeMs } = await stat(path);
            if (pid === process.pid || !isRunning(pid) || Date.now() - mtimeMs > STALE_SPOOL_MS) await unlink(path);
        } catch { }
    }
}

void sweepSpools();

process.once("exit", () => {
    for (const spool of spools.values()) {
        try {
            rmSync(spool.path, { force: true });
        } catch { }
    }
});

async function hasRoomFor(dir: string, bytes: number): Promise<boolean> {
    if (typeof statfs !== "function") return true;
    try {
        const { bavail, bsize } = await statfs(dir);
        return bavail * bsize >= bytes + SPOOL_FREE_MARGIN;
    } catch {
        return true;
    }
}

async function releaseSpool(id: string): Promise<void> {
    const spool = spools.get(id);
    if (!spool) return;
    spools.delete(id);
    await spool.writing?.catch(() => { });
    await spool.file?.close().catch(() => { });
    spool.file = undefined;
    try {
        await unlink(spool.path);
    } catch { }
}

const watchedSenders = new Set<number>();

function watchSender(sender: WebContents): void {
    const { id } = sender;
    if (watchedSenders.has(id) || typeof sender?.once !== "function") return;
    watchedSenders.add(id);
    sender.once("destroyed", () => {
        watchedSenders.delete(id);
        for (const [spoolId, spool] of spools) if (spool.owner === id) void releaseSpool(spoolId);
    });
}

function ownedSpool(e: IpcMainInvokeEvent, id: unknown): Spool | undefined {
    const spool = typeof id === "string" ? spools.get(id) : undefined;
    return spool?.owner === e.sender.id ? spool : undefined;
}

async function createSpool(e: IpcMainInvokeEvent, expected: number | undefined, session: string, limit: number): Promise<{ id: string; spool: Spool; } | { error: string; }> {
    const owner = e.sender.id;
    for (const [id, spool] of spools) if (spool.owner === owner && spool.session !== session) await releaseSpool(id);
    watchSender(e.sender);
    if (spools.size >= MAX_SPOOLS) return { error: "Too many files are waiting to be uploaded" };

    const dir = spoolDir();
    try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
        return { error: `Couldn't create BigFileUpload's temporary folder (${errorCodeOf(error) ?? "unknown error"})` };
    }
    if (!await isPrivateDir(dir)) return { error: "BigFileUpload's temporary folder isn't private to this user" };
    if (expected !== undefined && !await hasRoomFor(dir, expected)) {
        return { error: `Not enough free disk space to prepare the upload (it needs ${gigabytes(expected + SPOOL_FREE_MARGIN)} free)` };
    }

    const id = randomUUID();
    const path = join(dir, `${process.pid}-${id}`);
    try {
        const file = await open(path, "wx", 0o600);
        const { dev, ino } = await file.stat().catch(async error => {
            await file.close().catch(() => { });
            await unlink(path).catch(() => { });
            throw error;
        });
        const spool: Spool = { owner, session, path, dev, ino, limit, written: 0, hash: createHash("sha256"), file };
        spools.set(id, spool);
        return { id, spool };
    } catch (error) {
        return { error: `Couldn't create a temporary file (${errorCodeOf(error) ?? "unknown error"})` };
    }
}

async function appendToSpool(spool: Spool, bytes: Uint8Array): Promise<void> {
    const { file } = spool;
    if (!file) throw new Error("The temporary file is closed");
    const work = (async () => {
        for (let done = 0; done < bytes.length;) {
            const { bytesWritten } = await file.write(bytes, done, bytes.length - done, spool.written + done);
            if (bytesWritten <= 0) throw new Error("Writing the temporary file made no progress");
            done += bytesWritten;
        }
        spool.hash.update(bytes);
        spool.written += bytes.length;
    })();
    spool.writing = work;
    try {
        await work;
    } finally {
        if (spool.writing === work) spool.writing = undefined;
    }
}

async function completeSpool(spool: Spool): Promise<string> {
    await spool.file?.close();
    spool.file = undefined;
    return spool.sha256 = spool.hash.digest("hex");
}

function asBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}

export async function spoolOpen(e: IpcMainInvokeEvent, size: number, session = ""): Promise<{ success: boolean; id?: string; error?: string; }> {
    if (!Number.isSafeInteger(size) || size <= 0) return { success: false, error: "Invalid file size" };
    if (size > SPOOL_MAX_BYTES) return { success: false, error: `Files over ${gigabytes(SPOOL_MAX_BYTES)} can't be uploaded from the desktop app` };
    const created = await createSpool(e, size, String(session), size);
    return "error" in created ? { success: false, error: created.error } : { success: true, id: created.id };
}

export async function spoolWrite(e: IpcMainInvokeEvent, id: string, offset: number, chunk: ArrayBuffer | ArrayBufferView): Promise<{ success: boolean; written?: number; sha256?: string; error?: string; cancelled?: true; }> {
    const spool = ownedSpool(e, id);
    if (!spool) return { success: false, error: "The temporary upload file is gone" };
    if (abortLatch?.reason === "user") return { success: false, cancelled: true, error: "Upload cancelled by user" };
    if (spool.sha256 !== undefined || spool.writing) return { success: false, error: "The temporary upload file isn't writable now" };
    if (offset !== spool.written) return { success: false, error: "File slices arrived out of order" };
    const bytes = chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk) ? asBytes(chunk) : null;
    if (!bytes?.length || bytes.length > SPOOL_SLICE_BYTES * 2 || bytes.length > spool.limit - spool.written) {
        return { success: false, error: "Invalid file slice" };
    }
    try {
        await appendToSpool(spool, bytes);
        const sha256 = spool.written === spool.limit ? await completeSpool(spool) : undefined;
        return { success: true, written: spool.written, sha256 };
    } catch (error) {
        return { success: false, error: `Writing the temporary upload file failed (${errorCodeOf(error) ?? (error instanceof Error ? error.message : "unknown error")})` };
    }
}

export async function spoolRead(e: IpcMainInvokeEvent, id: string, offset: number, length: number): Promise<{ success: boolean; error?: string; data?: ArrayBuffer; }> {
    const spool = ownedSpool(e, id);
    if (!spool?.sha256) return { success: false, error: "The temporary upload file is gone" };
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > SPOOL_SLICE_BYTES || length > spool.written - offset) {
        return { success: false, error: "Invalid read range" };
    }
    let file: FileHandle | undefined;
    try {
        file = await openSpoolFile(spool);
        const data = new Uint8Array(length);
        for (let done = 0; done < length;) {
            const { bytesRead } = await file.read(data, done, length - done, offset + done);
            if (!bytesRead) throw new Error("The temporary upload file ended early");
            done += bytesRead;
        }
        return { success: true, data: data.buffer };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Reading the temporary upload file failed" };
    } finally {
        await file?.close().catch(() => { });
    }
}

export async function spoolRelease(e: IpcMainInvokeEvent, id: string): Promise<void> {
    if (ownedSpool(e, id)) await releaseSpool(id);
}

export async function spoolHash(e: IpcMainInvokeEvent, id: string, offset: number, length: number): Promise<{ success: boolean; sha256?: string; error?: string; }> {
    const spool = ownedSpool(e, id);
    if (!spool?.sha256) return { success: false, error: "The temporary upload file is gone" };
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > spool.written - offset) {
        return { success: false, error: "Invalid read range" };
    }
    let file: FileHandle | undefined;
    try {
        file = await openSpoolFile(spool);
        const hash = createHash("sha256");
        const buffer = new Uint8Array(Math.min(SPOOL_READ_CHUNK, length));
        for (let done = 0; done < length;) {
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, length - done), offset + done);
            if (!bytesRead) throw new Error("The temporary upload file ended early");
            hash.update(buffer.subarray(0, bytesRead));
            done += bytesRead;
        }
        return { success: true, sha256: hash.digest("hex") };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Reading the temporary upload file failed" };
    } finally {
        await file?.close().catch(() => { });
    }
}

function withoutHeaders(headers: Record<string, string>, names: string[]): Record<string, string> {
    const drop = names.map(name => name.toLowerCase());
    return Object.fromEntries(Object.entries(headers).filter(([key]) => !drop.includes(key.toLowerCase())));
}

const UPLOAD_CHUNK_SIZE = 262144;

const SPOOL_READ_CHUNK = 1024 * 1024;

interface FileRange {
    path: string;
    dev: number;
    ino: number;
    start: number;
    length: number;
}

type BodyPart = Uint8Array | FileRange;

let bodyReadError: string | null = null;

let streamGeneration = 0;

function progressStream(parts: BodyPart[], signal: AbortSignal): ReadableStream<Uint8Array> {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const generation = ++streamGeneration;
    uploadProgress = { loaded: 0, total };
    bodyDone = false;
    let index = 0;
    let offset = 0;
    let loaded = 0;
    let file: FileHandle | null = null;
    const closeFile = async () => {
        const handle = file;
        file = null;
        await handle?.close().catch(() => { });
    };
    return new ReadableStream({
        async pull(controller) {
            if (signal.aborted || generation !== streamGeneration) {
                await closeFile();
                controller.error(new Error("The request was stopped"));
                return;
            }
            while (index < parts.length && offset >= parts[index].length) {
                await closeFile();
                index++;
                offset = 0;
            }
            if (index >= parts.length) {
                bodyDone = true;
                controller.close();
                return;
            }
            pulls++;
            const part = parts[index];
            let chunk: Uint8Array;
            if (part instanceof Uint8Array) {
                chunk = part.subarray(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, part.length));
            } else {
                chunk = new Uint8Array(Math.min(SPOOL_READ_CHUNK, part.length - offset));
                try {
                    file ??= await openSpoolFile(part);
                    for (let done = 0; done < chunk.length;) {
                        const { bytesRead } = await file.read(chunk, done, chunk.length - done, part.start + offset + done);
                        if (!bytesRead) throw new Error("it ended early");
                        done += bytesRead;
                    }
                } catch (error) {
                    bodyReadError = `Reading the temporary upload file failed (${errorCodeOf(error) ?? (error instanceof Error ? error.message : "unknown error")})`;
                    await closeFile();
                    throw new Error(bodyReadError);
                }
            }
            controller.enqueue(chunk);
            offset += chunk.length;
            loaded += chunk.length;
            uploadProgress = { loaded, total };
            touch();
        },
        cancel: closeFile
    });
}

async function streamFetch(url: string, method: string, headers: Record<string, string>, parts: BodyPart[], contentType?: string, insecureOrigin?: string, viaProxy = false): Promise<Response> {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const base = withoutHeaders(headers, contentType ? ["content-length", "content-type"] : ["content-length"]);
    const finalHeaders: Record<string, string> = { ...base, "Content-Length": String(total) };
    if (contentType) finalHeaders["Content-Type"] = contentType;

    const controller = new AbortController();
    activeUploadController = controller;

    const { origin } = new URL(url);
    let currentUrl = url;
    for (let attempt = 0; attempt < 4; attempt++) {
        const target = new URL(currentUrl);
        pendingTarget = target.origin + target.pathname + target.search;
        bodySent = headersSent = false;
        pulls = 0;
        const response = await fetch(currentUrl, {
            method,
            headers: finalHeaders,
            body: progressStream(parts, controller.signal),
            duplex: "half",
            redirect: "manual",
            signal: controller.signal
        } as RequestInit & { duplex: "half"; });

        touch();
        if (viaProxy && response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => { });
            throw new RedirectRefusal(`The CORS proxy answered with a redirect (${response.status}), which isn't followed`);
        }
        const location = response.headers.get("location");
        const redirected = (response.status === 307 || response.status === 308) && location;
        if (redirected || [301, 302, 303].includes(response.status)) await response.body?.cancel().catch(() => { });

        if (redirected) {
            if (abortLatch || lateCancel) throw new Error(stoppedMessage());
            const next = new URL(location, currentUrl);
            if (next.origin !== origin || await uploadUrlProblem(next.toString(), insecureOrigin)) {
                throw new RedirectRefusal(`Upload endpoint redirected to a different or insecure origin (${next.origin}). Update the configured URL to the final address`);
            }
            currentUrl = next.toString();
            continue;
        }

        if ([301, 302, 303].includes(response.status)) {
            const shown = location && URL.canParse(location, currentUrl) ? new URL(location, currentUrl) : null;
            throw new RedirectRefusal(`Upload endpoint redirected (${response.status}${shown ? ` to ${shown.origin}${shown.pathname}` : ""}). Update the configured URL to the final address`);
        }

        return response;
    }

    throw new RedirectRefusal("Too many redirects from upload endpoint");
}

class RedirectRefusal extends Error { }

const MAX_RESPONSE_BYTES = 1024 * 1024;

const MAX_RESPONSE_HEADERS = 200;

async function readResponseText(response: Response): Promise<{ text: string; truncated: boolean; }> {
    const reader = response.body?.getReader();
    if (!reader) return { text: "", truncated: false };
    const decoder = new TextDecoder();
    let text = "";
    let received = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return { text: text + decoder.decode(), truncated: false };
            touch();
            if (!value?.length) continue;
            const room = MAX_RESPONSE_BYTES - received;
            if (value.length > room) {
                text += decoder.decode(value.subarray(0, room));
                await reader.cancel().catch(() => { });
                return { text, truncated: true };
            }
            received += value.length;
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
}

function multipartFetch(url: string, fields: Record<string, string>, fileFieldName: string, file: BodyPart, filename: string, headers: Record<string, string> = {}, fileContentType = "application/octet-stream", method = "POST", insecureOrigin?: string, viaProxy = false): Promise<Response> {
    const boundary = `----BigFileUpload${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const encoder = new TextEncoder();
    const escapeName = (value: string) => value.replace(/["\r\n]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
    const safeName = escapeName(filename);
    const safeContentType = (fileContentType || "application/octet-stream").replace(/[\r\n]/g, "");
    let head = "";
    for (const [name, value] of Object.entries(fields)) {
        head += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(name)}"\r\n\r\n${value.replace(/[\r\n]/g, "")}\r\n`;
    }
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(fileFieldName)}"; filename="${safeName}"\r\nContent-Type: ${safeContentType}\r\n\r\n`;
    const parts = [encoder.encode(head), file, encoder.encode(`\r\n--${boundary}--\r\n`)];
    return streamFetch(url, method, headers, parts, `multipart/form-data; boundary=${boundary}`, insecureOrigin, viaProxy);
}

function rawFetch(url: string, method: string, file: BodyPart, headers: Record<string, string> = {}, insecureOrigin?: string, viaProxy = false): Promise<Response> {
    return streamFetch(url, method, headers, [file], undefined, insecureOrigin, viaProxy);
}

function isValidHttpsUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function isPublicSourceUrl(url: string): boolean {
    if (!isValidHttpsUrl(url)) return false;
    const host = new URL(url).hostname.toLowerCase();
    if (host.startsWith("[") || isIP(host)) return isPublicSourceAddress(host);
    return httpHostKind(host) === "public";
}

const MAX_SOURCE_REDIRECTS = 5;

const UPLOAD_URL_RULE = "Upload URL must be https (or http on a local/private network)";

const DNS_TIMEOUT_MS = 10000;

async function resolveAll(host: string): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`DNS lookup of ${host} timed out`), { code: "EAI_AGAIN" })), DNS_TIMEOUT_MS);
    });
    try {
        const answers = await Promise.race([lookup(host, { all: true }), timeout]);
        return answers.map(answer => answer.address);
    } finally {
        clearTimeout(timer);
    }
}

type UrlProblem = { error: string; lookupError?: undefined; } | { error?: undefined; lookupError: unknown; };

async function uploadUrlProblem(url: string, insecureOrigin?: unknown): Promise<UrlProblem | null> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { error: UPLOAD_URL_RULE };
    }
    if (parsed.protocol === "https:") return null;
    if (parsed.protocol !== "http:") return { error: UPLOAD_URL_RULE };
    if (typeof insecureOrigin === "string" && parsed.origin === insecureOrigin) return null;
    const kind = httpHostKind(parsed.hostname);
    if (kind === "private") return null;
    if (kind === "public") return { error: httpLanOnlyText(parsed.host, false) };
    let addresses: string[];
    try {
        addresses = await resolveAll(parsed.hostname);
    } catch (error) {
        return { lookupError: error };
    }
    return addresses.length && addresses.every(isPrivateAddress) ? null : { error: httpLanOnlyText(parsed.hostname, true) };
}

function lookupFailure(error: unknown): CustomUploadResponse {
    const described = describeNetworkError(error, "connect");
    if (described.code === "local") return { success: false, ...described };
    return { success: false, ...described, failure: { stage: "connect", code: firstErrorCode(error), stageReliable: true } };
}

export async function checkHttpHost(_: IpcMainInvokeEvent, url: string): Promise<{ lan: boolean | null; }> {
    if (typeof url !== "string") return { lan: false };
    const problem = await uploadUrlProblem(url);
    return { lan: !problem ? true : problem.lookupError !== undefined ? null : false };
}

export interface CustomUploadRequestOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    bodyType: "multipart" | "binary" | "json";
    fields?: Record<string, string>;
    fileFieldName?: string;
    filename?: string;
    fileContentType?: string;
    stallTimeoutMs?: number;
    insecureOrigin?: string;
    viaProxy?: boolean;
    resolveAddresses?: boolean;
}

export interface CustomUploadResponse {
    success: boolean;
    status?: number;
    statusText?: string;
    contentType?: string;
    responseText?: string;
    responseTruncated?: true;
    retryAfter?: string;
    etag?: string;
    headers?: [string, string][];
    url?: string;
    error?: string;
    code?: NativeErrorCode;
    cancelled?: true;
    failure?: UploadFailure;
    block?: true;
    server?: string;
    remoteAddress?: string;
}

const isSpoolSource = (body: unknown): body is SpoolSource =>
    typeof body === "object" && body !== null && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer) && (body as SpoolSource).kind === "spool";

function requestBody(e: IpcMainInvokeEvent, body: ArrayBuffer | ArrayBufferView | SpoolSource | null | undefined): BodyPart | string {
    if (!isSpoolSource(body)) return body ? asBytes(body) : new Uint8Array(0);
    const spool = ownedSpool(e, body.id);
    if (!spool?.sha256) return "The file prepared for upload is no longer available";
    const start = body.offset ?? 0;
    const length = body.length ?? spool.written - start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || length > spool.written - start) {
        return "Invalid range of the prepared file";
    }
    return { path: spool.path, dev: spool.dev, ino: spool.ino, start, length };
}

export async function customUploadRequest(
    e: IpcMainInvokeEvent,
    options: CustomUploadRequestOptions,
    body: ArrayBuffer | SpoolSource
): Promise<CustomUploadResponse> {
    const {
        url,
        method = "POST",
        headers = {},
        bodyType,
        fields = {},
        fileFieldName = "file",
        filename = "upload.bin",
        fileContentType,
        stallTimeoutMs
    } = options;
    const insecureOrigin = typeof options.insecureOrigin === "string" ? options.insecureOrigin : undefined;
    const viaProxy = options.viaProxy === true;

    const problem = await uploadUrlProblem(url, insecureOrigin);
    if (problem) return problem.lookupError !== undefined ? lookupFailure(problem.lookupError) : { success: false, code: "local", error: problem.error };

    if (abortLatch || lateCancel) {
        return userCancelled() ? { success: false, cancelled: true, code: "cancelled", error: stoppedMessage() } : { success: false, code: "stalled", error: stoppedMessage() };
    }

    const file = bodyType === "json" ? new Uint8Array(0) : requestBody(e, body);
    if (typeof file === "string") return { success: false, code: "local", error: file };

    const hasHeader = (name: string) => Object.keys(headers).some(header => header.toLowerCase() === name);

    uploadRunning = true;
    bodyReadError = null;
    remoteAddress = undefined;
    const stallMs = typeof stallTimeoutMs === "number" && Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0 ? Math.max(1000, stallTimeoutMs) : DEFAULT_STALL_MS;
    const stopWatch = watchForStall(stallMs);
    try {
        let response: Response;

        if (bodyType === "multipart") {
            response = await multipartFetch(url, fields, fileFieldName, file, filename, headers, fileContentType, method, insecureOrigin, viaProxy);
        } else if (bodyType === "binary") {
            const binaryHeaders = { ...headers };
            if (fileContentType && !hasHeader("content-type")) {
                binaryHeaders["Content-Type"] = fileContentType;
            }
            response = await rawFetch(url, method, file, binaryHeaders, insecureOrigin, viaProxy);
        } else if (bodyType === "json") {
            const payload = new TextEncoder().encode(JSON.stringify(fields));
            const jsonHeaders = { ...headers };
            if (!hasHeader("content-type")) {
                jsonHeaders["Content-Type"] = "application/json";
            }
            response = await streamFetch(url, method, jsonHeaders, [payload], undefined, insecureOrigin, viaProxy);
        } else {
            return { success: false, code: "local", error: `Unsupported body type: ${bodyType}` };
        }

        const { text, truncated } = await readResponseText(response);
        const server = response.headers.get("server")?.slice(0, 100);
        const address = remoteAddress as string | undefined;
        return {
            success: true,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get("content-type") || "",
            retryAfter: response.headers.get("retry-after") ?? undefined,
            etag: response.headers.get("etag") ?? undefined,
            headers: [...response.headers].slice(0, MAX_RESPONSE_HEADERS),
            url: response.url || undefined,
            ...truncated && { responseTruncated: true as const },
            ...classifyHttpBlock(response.status, name => response.headers.get(name), text.slice(0, 8192)) && { block: true as const },
            ...server && { server },
            ...address && { remoteAddress: address },
            responseText: text
        };
    } catch (e) {
        if (userCancelled()) return { success: false, cancelled: true, code: "cancelled", error: "Upload cancelled by user" };
        if (abortLatch) return { success: false, code: "stalled", error: stoppedMessage(), failure: failureOf(e) };
        if (e instanceof RedirectRefusal) return { success: false, code: "http", error: e.message };
        if (bodyReadError) return { success: false, code: "local", error: bodyReadError };
        const failure = failureOf(e);
        const described = describeNetworkError(e, failure.stage);
        if (options.resolveAddresses === true && !failure.addresses && PROXY_RETRY_KINDS.has(failure.kind!) && !isDnsCode(failure.code)) {
            const { hostname } = new URL(url);
            if (!hostname.startsWith("[") && !isIP(hostname)) {
                const addresses = await resolveAll(hostname).catch(() => []);
                if (addresses.length) failure.addresses = addresses;
            }
        }
        if (described.code === "local" && e instanceof TypeError && /invalid header/i.test(e.message)) {
            return { success: false, code: "local", error: "A request header is invalid (check the host's token or ShareX headers)" };
        }
        return described.code === "local" ? { success: false, ...described } : { success: false, ...described, failure };
    } finally {
        stopWatch();
        uploadRunning = false;
        pendingTarget = null;
        bodySent = headersSent = false;
        remoteAddress = undefined;
        if (isSpoolSource(body) && body.offset !== undefined) uploadProgress = { loaded: 0, total: 0 };
    }
}

const CLEANUP_TIMEOUT_MS = 15000;

export interface CleanupRequestOptions {
    url: string;
    method: "DELETE";
    headers?: Record<string, string>;
    insecureOrigin?: string;
}

export async function cleanupRequest(_: IpcMainInvokeEvent, options: CleanupRequestOptions): Promise<{ success: boolean; status?: number; error?: string; }> {
    const { url, method, headers = {}, insecureOrigin } = options ?? {};
    if (typeof url !== "string") return { success: false, error: UPLOAD_URL_RULE };
    if (method !== "DELETE") return { success: false, error: "Only DELETE is supported" };
    const problem = await uploadUrlProblem(url, insecureOrigin);
    if (problem) return { success: false, error: problem.error ?? describeNetworkError(problem.lookupError).error };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try {
        const response = await fetch(url, { method, headers, redirect: "manual", signal: controller.signal });
        await response.body?.cancel().catch(() => { });
        return { success: true, status: response.status };
    } catch (e) {
        return { success: false, error: controller.signal.aborted ? `No answer within ${CLEANUP_TIMEOUT_MS / 1000} s` : describeNetworkError(e).error };
    } finally {
        clearTimeout(timer);
    }
}

const MAX_DELETE_ANSWER = 16 * 1024;

export interface DeleteRequestOptions {
    url: string;
    method: "GET" | "POST" | "DELETE";
    headers?: Record<string, string>;
    form?: Record<string, string>;
    publicOnly?: boolean;
}

export async function deleteRequest(_: IpcMainInvokeEvent, options: DeleteRequestOptions): Promise<{ success: boolean; status?: number; body?: string; error?: string; }> {
    const { url, method, headers = {}, form, publicOnly } = options ?? {};
    if (typeof url !== "string") return { success: false, error: UPLOAD_URL_RULE };
    if (method !== "GET" && method !== "POST" && method !== "DELETE") return { success: false, error: "Only GET, POST and DELETE are supported" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try {
        if (publicOnly === true) {
            const refused = sourceUrlError(url) ?? await sourceAddressProblem(url, controller.signal);
            if (refused) return { success: false, error: refused };
        } else {
            const problem = await uploadUrlProblem(url);
            if (problem) return { success: false, error: problem.error ?? describeNetworkError(problem.lookupError).error };
        }
        const body = method === "POST" && form && typeof form === "object" ? new URLSearchParams(form) : undefined;
        const response = await fetch(url, { method, headers, body, redirect: "manual", signal: controller.signal });
        return { success: true, status: response.status, body: await readResponseHead(response, MAX_DELETE_ANSWER) };
    } catch (e) {
        return { success: false, error: controller.signal.aborted ? `No answer within ${CLEANUP_TIMEOUT_MS / 1000} s` : describeNetworkError(e).error };
    } finally {
        clearTimeout(timer);
    }
}

const PROBE_TIMEOUT_MS = 10000;

const MAX_PROBE_BODY = 64 * 1024;

export async function probeUrl(_: IpcMainInvokeEvent, url: string, method: "HEAD" | "GET" = "HEAD", userAgent?: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; status?: number; contentType?: string; server?: string; body?: string; error?: string; }> {
    if (typeof url !== "string" || !isValidHttpsUrl(url)) return { ok: false, error: "Only https URLs can be checked" };
    if (method !== "HEAD" && method !== "GET") return { ok: false, error: "Only HEAD and GET are supported" };
    const wait = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1000), PROBE_TIMEOUT_MS) : PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), wait);
    try {
        const headers: Record<string, string> = typeof userAgent === "string" && userAgent ? { "User-Agent": userAgent.slice(0, 200) } : {};
        const response = await fetch(url, { method, headers, redirect: "manual", signal: controller.signal });
        const body = method === "GET" ? await readResponseHead(response, MAX_PROBE_BODY) : (await response.body?.cancel().catch(() => { }), undefined);
        return {
            ok: true,
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            server: response.headers.get("server")?.slice(0, 100) ?? "",
            ...body !== undefined && { body }
        };
    } catch (e) {
        return { ok: false, error: controller.signal.aborted ? `No answer within ${wait / 1000} s` : describeNetworkError(e).error };
    } finally {
        clearTimeout(timer);
    }
}

function sourceUrlError(url: string): string | null {
    if (!isValidHttpsUrl(url)) return "Refusing to fetch a non-HTTPS URL";
    if (!isPublicSourceUrl(url)) return "Refusing to fetch a local address";
    return null;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let onAbort = () => { };
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

async function sourceAddressProblem(url: string, signal: AbortSignal): Promise<string | null> {
    const host = new URL(url).hostname.replace(/\.$/, "");
    if (host.startsWith("[") || isIP(host)) return null;
    const addresses = await abortable(resolveAll(host), signal);
    return addresses.length && addresses.every(isPublicSourceAddress) ? null : `${host} resolves to a local address`;
}

type SourceRefusal = { error: string; code: NativeErrorCode; policy: true; };

const refusal = (error: string, code: NativeErrorCode): SourceRefusal => ({ error, code, policy: true });

async function openSource(url: string, signal: AbortSignal, viaProxy = false): Promise<{ response: Response; } | SourceRefusal | { error: string; code: NativeErrorCode; block?: true; }> {
    let current = url;
    for (let hop = 0; ; hop++) {
        const local = await sourceAddressProblem(current, signal);
        if (local) return hop ? refusal(`Refusing a redirect to ${new URL(current).origin} (${local})`, "http") : refusal(`Refusing to fetch a local address (${local})`, "local");
        const response = await fetch(current, { signal, redirect: "manual" });
        if (viaProxy && response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => { });
            return { error: `The CORS proxy answered with a redirect (${response.status}), which isn't followed`, code: "http" };
        }
        const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get("location") : null;
        if (!location) {
            if (response.ok) return { response };
            const head = response.status === 403 || response.status === 451 ? await readResponseHead(response, 8192) : "";
            const block = classifyHttpBlock(response.status, name => response.headers.get(name), head);
            await response.body?.cancel().catch(() => { });
            const reason = response.statusText.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 80);
            return { error: `Fetch failed: ${response.status}${reason ? ` ${reason}` : ""}`, code: "http", ...block && { block: true as const } };
        }
        await response.body?.cancel().catch(() => { });
        const next = URL.canParse(location, current) ? new URL(location, current).href : null;
        if (!next) return { error: `Fetch failed: ${response.status} with an invalid Location`, code: "http" };
        if (hop >= MAX_SOURCE_REDIRECTS) return refusal("Too many redirects", "http");
        if (!isPublicSourceUrl(next)) return refusal(`Refusing a redirect to ${new URL(next).origin}`, "http");
        current = next;
    }
}

async function readResponseHead(response: Response, max: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let text = "";
    try {
        while (text.length < max) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.length) text += decoder.decode(value, { stream: true });
        }
    } catch { } finally {
        await reader.cancel().catch(() => { });
    }
    return text.slice(0, max);
}

function startSourceDownload(timeoutMs: number) {
    const controller = new AbortController();
    activeUploadController = controller;
    abortLatch = null;
    let stalled = false;
    const stall = () => {
        stalled = true;
        controller.abort();
    };
    let timeout = setTimeout(stall, timeoutMs);
    uploadProgress = { loaded: 0, total: 0, phase: "downloading" };
    return {
        controller,
        timeoutMs,
        stalled: () => stalled,
        progress(loaded: number, total = 0) {
            uploadProgress = { loaded, total, phase: "downloading" };
        },
        resetStall() {
            clearTimeout(timeout);
            timeout = setTimeout(stall, timeoutMs);
        },
        end() {
            clearTimeout(timeout);
            if (activeUploadController === controller) activeUploadController = null;
            if (uploadProgress.phase === "downloading") uploadProgress = { loaded: 0, total: 0 };
        }
    };
}

type SourceFailure = { success: false; error: string; code: NativeErrorCode; cancelled?: true; tooLarge?: true; size?: number; policy?: true; failure?: UploadFailure; block?: true; };

function sourceLimit(maxBytes: unknown, cap: number): number {
    return typeof maxBytes === "number" && Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? Math.min(maxBytes, cap) : cap;
}

function tooLargeFailure(size: number, limit: number, cap: number, capText: string): SourceFailure {
    return { success: false, code: "local", tooLarge: true, size, error: limit === cap ? capText : `The file is larger than any active upload host accepts (${size} bytes, limit ${limit})` };
}

function declaredLength(response: Response): number | undefined {
    const declared = Number(response.headers.get("content-length") ?? NaN);
    return Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined;
}

function sourceFailure(e: unknown, download: ReturnType<typeof startSourceDownload>, responded: boolean): SourceFailure {
    if (abortLatch?.reason === "user") return { success: false, cancelled: true, code: "cancelled", error: "Upload cancelled by user" };
    if (download.stalled()) return { success: false, code: "stalled", error: `No download progress for ${duration(download.timeoutMs)}, so the download was stopped` };
    const described = describeNetworkError(e);
    if (described.code === "local") return { success: false, ...described };
    const stage = responded ? "body" : "connect";
    return { success: false, ...described, failure: { stage, code: firstErrorCode(e), stageReliable: true, kind: classifyFetchError(e, stage, true) } };
}

export async function fetchFile(
    _: IpcMainInvokeEvent,
    url: string,
    timeoutMs: number = 300000,
    maxBytes?: number,
    viaProxy?: boolean
): Promise<{ success: boolean; contentType?: string; error?: string; code?: NativeErrorCode; cancelled?: true; tooLarge?: true; size?: number; policy?: true; failure?: UploadFailure; block?: true; data?: ArrayBuffer; }> {
    const refused = sourceUrlError(url);
    if (refused) return { success: false, code: "local", error: refused, policy: true };

    const limit = sourceLimit(maxBytes, NATIVE_MAX_BUFFER);
    const tooLarge = (size: number) => tooLargeFailure(size, limit, NATIVE_MAX_BUFFER, "Files over 1.9 GB can't be uploaded from the desktop app yet (fully restart Discord or Vesktop to finish updating BigFileUpload)");
    const download = startSourceDownload(timeoutMs);
    let responded = false;
    try {
        const opened = await openSource(url, download.controller.signal, viaProxy === true);
        if ("error" in opened) return { success: false, ...opened };
        const { response } = opened;
        responded = true;
        const contentType = response.headers.get("content-type") || "";
        const declared = declaredLength(response);
        if (declared !== undefined && declared > limit) {
            await response.body?.cancel().catch(() => { });
            return tooLarge(declared);
        }
        download.progress(0, declared);

        if (!response.body) {
            const data = await response.arrayBuffer();
            return { success: true, contentType, data };
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            download.resetStall();
            if (value) {
                if (received + value.length > limit) {
                    await reader.cancel().catch(() => { });
                    return tooLarge(received + value.length);
                }
                chunks.push(value);
                received += value.length;
                download.progress(received, declared);
            }
        }

        const data = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        return { success: true, contentType, data: data.buffer as ArrayBuffer };
    } catch (e) {
        return sourceFailure(e, download, responded);
    } finally {
        download.end();
    }
}

export type FetchToSpoolResult =
    | { success: true; id: string; size: number; contentType: string; sha256: string; head: ArrayBuffer; }
    | SourceFailure;

export async function fetchToSpool(e: IpcMainInvokeEvent, url: string, timeoutMs = 300000, session = "", maxBytes?: number, viaProxy?: boolean): Promise<FetchToSpoolResult> {
    const refused = sourceUrlError(url);
    if (refused) return { success: false, code: "local", error: refused, policy: true };

    const limit = sourceLimit(maxBytes, SPOOL_MAX_BYTES);
    const tooLarge = (size: number) => tooLargeFailure(size, limit, SPOOL_MAX_BYTES, `Files over ${gigabytes(SPOOL_MAX_BYTES)} can't be uploaded from the desktop app`);
    const download = startSourceDownload(timeoutMs);
    let id: string | undefined;
    let responded = false;
    try {
        const opened = await openSource(url, download.controller.signal, viaProxy === true);
        if ("error" in opened) return { success: false, ...opened };
        const { response } = opened;
        responded = true;
        const contentType = response.headers.get("content-type") || "";

        const declared = declaredLength(response);
        if (declared !== undefined && declared > limit) {
            await response.body?.cancel().catch(() => { });
            return tooLarge(declared);
        }
        const created = await createSpool(e, declared || undefined, String(session), limit);
        if ("error" in created) {
            await response.body?.cancel().catch(() => { });
            return { success: false, code: "local", error: created.error };
        }
        ({ id } = created);
        const { spool } = created;
        download.progress(0, declared);

        const head = new Uint8Array(SPOOL_HEAD_BYTES);
        let headLength = 0;
        let roomFor = declared ? Infinity : 0;
        const reader = response.body?.getReader();
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            download.resetStall();
            if (!value?.length) continue;
            if (value.length > spool.limit - spool.written) {
                await reader.cancel().catch(() => { });
                return tooLarge(spool.written + value.length);
            }
            if (spool.written + value.length > roomFor) {
                roomFor = Math.min(spool.limit, spool.written + value.length + ROOM_CHECK_BYTES);
                if (!await hasRoomFor(spoolDir(), roomFor - spool.written)) {
                    await reader.cancel().catch(() => { });
                    return { success: false, code: "local", error: "Not enough free disk space to prepare the upload" };
                }
            }
            if (headLength < head.length) {
                const n = Math.min(head.length - headLength, value.length);
                head.set(value.subarray(0, n), headLength);
                headLength += n;
            }
            try {
                await appendToSpool(spool, value);
            } catch (error) {
                void reader.cancel().catch(() => { });
                return { success: false, code: "local", error: `Writing the temporary upload file failed (${errorCodeOf(error) ?? (error instanceof Error ? error.message : "unknown error")})` };
            }
            download.progress(spool.written, declared);
        }
        const sha256 = await completeSpool(spool);
        const result: FetchToSpoolResult = { success: true, id, size: spool.written, contentType, sha256, head: head.slice(0, headLength).buffer };
        id = undefined;
        return result;
    } catch (e) {
        return sourceFailure(e, download, responded);
    } finally {
        download.end();
        if (id) await releaseSpool(id);
    }
}
