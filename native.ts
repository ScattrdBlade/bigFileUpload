/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import crypto from "crypto";
import { BrowserWindow, dialog, WebContents } from "electron";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";

// Type definitions for upload service responses
interface GoFileResponse {
    status: "ok" | "error";
    data?: {
        downloadPage?: string;
        code?: string;
        fileName?: string;
        fileId?: string;
    };
    error?: string;
}

type LoggingLevel = "errors" | "info" | "debug";
const levelPriority: Record<LoggingLevel, number> = {
    errors: 0,
    info: 1,
    debug: 2
};

let currentLoggingLevel: LoggingLevel = "errors";

// Uploaders that don't support EXE files
const EXE_BLOCKED_UPLOADERS = ["Catbox", "Litterbox", "0x0.st"];
const EXE_FALLBACK_UPLOADER = "GoFile";

// Security: Maximum response body size to prevent memory exhaustion from server responses
// Note: This does NOT limit upload file size - files stream directly from disk with no memory limit
// This only limits the JSON/text response from the upload service (1MB is plenty for any valid response)
const MAX_RESPONSE_SIZE = 1 * 1024 * 1024;

// Nitro upload limits (used to decide whether to use Discord's native upload)
const NITRO_LIMITS: Record<string, number> = {
    none: 10 * 1024 * 1024,     // 10MB for no Nitro
    basic: 50 * 1024 * 1024,    // 50MB for Nitro Basic
    full: 500 * 1024 * 1024,    // 500MB for full Nitro
};

function isExeFile(fileName: string): boolean {
    return fileName.toLowerCase().endsWith(".exe");
}

function getEffectiveUploader(fileName: string, selectedUploader: string): string {
    if (isExeFile(fileName) && EXE_BLOCKED_UPLOADERS.includes(selectedUploader)) {
        nativeLog.info(`[BigFileUpload] ${selectedUploader} doesn't support EXE files, using ${EXE_FALLBACK_UPLOADER} instead`);
        return EXE_FALLBACK_UPLOADER;
    }
    return selectedUploader;
}

/**
 * Check if an IP address is in a private/reserved range (SSRF protection)
 */
function isPrivateOrReservedIP(hostname: string): boolean {
    // Check for localhost variations
    if (hostname === "localhost" || hostname === "localhost.localdomain") {
        return true;
    }

    // Check if it's an IP address
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const [, a, b, c] = ipv4Match.map(Number);

        // Loopback (127.0.0.0/8)
        if (a === 127) return true;

        // Private Class A (10.0.0.0/8)
        if (a === 10) return true;

        // Private Class B (172.16.0.0/12)
        if (a === 172 && b >= 16 && b <= 31) return true;

        // Private Class C (192.168.0.0/16)
        if (a === 192 && b === 168) return true;

        // Link-local (169.254.0.0/16) - includes cloud metadata service
        if (a === 169 && b === 254) return true;

        // Current network (0.0.0.0/8)
        if (a === 0) return true;

        // Broadcast
        if (a === 255) return true;
    }

    // Check for IPv6 loopback
    if (hostname === "::1" || hostname === "[::1]") {
        return true;
    }

    // Check for IPv6 link-local or private
    if (hostname.startsWith("fe80:") || hostname.startsWith("[fe80:")) {
        return true;
    }
    if (hostname.startsWith("fc") || hostname.startsWith("[fc") ||
        hostname.startsWith("fd") || hostname.startsWith("[fd")) {
        return true;
    }

    return false;
}

/**
 * Validate that a URL returned from an upload service is safe to use
 * Prevents malformed URLs, injection attacks, and SSRF
 */
function validateUploadUrl(url: string): boolean {
    if (!url || typeof url !== "string") return false;

    // Must be a valid URL
    try {
        const parsed = new URL(url);

        // Must be http or https
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            nativeLog.warn(`[BigFileUpload] Invalid URL protocol: ${parsed.protocol}`);
            return false;
        }

        // Must have a valid hostname
        if (!parsed.hostname || parsed.hostname.length < 3) {
            nativeLog.warn(`[BigFileUpload] Invalid URL hostname: ${parsed.hostname}`);
            return false;
        }

        // SSRF protection: reject private/reserved IPs and localhost
        if (isPrivateOrReservedIP(parsed.hostname)) {
            nativeLog.warn(`[BigFileUpload] Blocked private/reserved IP in URL: ${parsed.hostname}`);
            return false;
        }

        // Reject hostnames that are just numbers (likely IP obfuscation)
        if (/^\d+$/.test(parsed.hostname)) {
            nativeLog.warn(`[BigFileUpload] Blocked numeric-only hostname: ${parsed.hostname}`);
            return false;
        }

        // Hostname should contain at least one dot (basic TLD check)
        if (!parsed.hostname.includes(".")) {
            nativeLog.warn(`[BigFileUpload] Invalid hostname (no TLD): ${parsed.hostname}`);
            return false;
        }

        return true;
    } catch {
        nativeLog.warn(`[BigFileUpload] Invalid URL format: ${url.substring(0, 100)}`);
        return false;
    }
}

/**
 * Dangerous headers that should not be set by users (security risk)
 */
const BLOCKED_HEADERS = new Set([
    "host",
    "connection",
    "upgrade",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "keep-alive",
    "expect",
    "cookie",
    "set-cookie",
    "authorization", // Prevent credential theft via custom uploaders
    "www-authenticate",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded"
]);

/**
 * Sanitize custom headers to prevent header injection attacks
 * Removes dangerous headers that could be used for SSRF or credential theft
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase().trim();

        // Skip blocked headers
        if (BLOCKED_HEADERS.has(lowerKey)) {
            nativeLog.warn(`[BigFileUpload] Blocked dangerous header: ${key}`);
            continue;
        }

        // Skip empty keys
        if (!key || key.trim() === "") {
            continue;
        }

        // Validate header value (no newlines to prevent header injection)
        if (typeof value === "string" && !value.includes("\n") && !value.includes("\r")) {
            sanitized[key] = value;
        } else {
            nativeLog.warn(`[BigFileUpload] Blocked header with invalid value: ${key}`);
        }
    }

    return sanitized;
}

/**
 * Safely parse JSON with a fallback default value
 */
function parseJsonSafe<T>(json: string | undefined, defaultValue: T): T {
    if (!json || json.trim() === "") return defaultValue;
    try {
        return JSON.parse(json);
    } catch {
        nativeLog.warn(`[BigFileUpload] Failed to parse JSON: ${json.substring(0, 100)}`);
        return defaultValue;
    }
}

/**
 * Navigate a JSON object using a path that supports:
 * - Dot notation: "data.url"
 * - Array indices: "files[0].url" or "files.0.url"
 * - Nested paths: "response.data.files[0].link"
 */
function navigateJsonPath(obj: any, pathParts: string[]): any {
    let current = obj;

    for (const part of pathParts) {
        if (current === null || current === undefined) {
            return undefined;
        }

        // Handle array index notation: "files[0]" -> access files then index 0
        const arrayMatch = part.match(/^([^\[]+)\[(\d+)\]$/);
        if (arrayMatch) {
            const [, key, index] = arrayMatch;
            if (key) {
                current = current[key];
                if (current === null || current === undefined) return undefined;
            }
            current = current[parseInt(index, 10)];
        }
        // Handle numeric string as array index
        else if (/^\d+$/.test(part) && Array.isArray(current)) {
            current = current[parseInt(part, 10)];
        }
        // Standard object property access
        else {
            current = current[part];
        }
    }

    return current;
}

/**
 * Extract URL from response text using multiple strategies
 */
function extractUrlFromResponse(responseText: string, responseType: string, urlPath: string[], baseUrl?: string): string {
    const trimmed = responseText.trim();

    // Strategy 1: JSON response parsing
    if (responseType === "JSON" || (responseType === "Text" && trimmed.startsWith("{") || trimmed.startsWith("["))) {
        try {
            const parsed = JSON.parse(trimmed);

            // If urlPath is provided, use it
            if (urlPath.length > 0) {
                const extracted = navigateJsonPath(parsed, urlPath);
                if (typeof extracted === "string" && extracted.length > 0) {
                    return resolveUrl(extracted, baseUrl);
                }
            }

            // Auto-detect common URL fields if no path or path failed
            const commonFields = [
                ["url"], ["link"], ["href"], ["file"], ["download"],
                ["data", "url"], ["data", "link"], ["data", "file"],
                ["result", "url"], ["result", "link"],
                ["response", "url"], ["response", "link"],
                ["files", "0", "url"], ["files", "0", "link"],
                ["image", "url"], ["image", "link"],
                ["upload", "url"], ["upload", "link"]
            ];

            for (const path of commonFields) {
                const value = navigateJsonPath(parsed, path);
                if (typeof value === "string" && (value.startsWith("http") || value.startsWith("/"))) {
                    nativeLog.debug(`[BigFileUpload] Auto-detected URL at path: ${path.join(".")}`);
                    return resolveUrl(value, baseUrl);
                }
            }

            // If the response is just a string URL in JSON
            if (typeof parsed === "string" && (parsed.startsWith("http") || parsed.startsWith("/"))) {
                return resolveUrl(parsed, baseUrl);
            }

            throw new Error(`Could not find URL in JSON response. Try specifying a URL path.`);
        } catch (e) {
            if (responseType === "JSON") {
                throw e;
            }
            // Fall through to text parsing if auto-detect JSON failed
        }
    }

    // Strategy 2: Direct URL (response is just a URL)
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        // Take only the first line if multi-line
        const firstLine = trimmed.split(/[\r\n]/)[0].trim();
        if (firstLine.startsWith("http")) {
            return firstLine;
        }
    }

    // Strategy 3: Extract URL from text using regex
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
    const matches = trimmed.match(urlRegex);
    if (matches && matches.length > 0) {
        // Prefer longer URLs (more likely to be the actual file URL)
        const bestMatch = matches.reduce((a, b) => a.length >= b.length ? a : b);
        nativeLog.debug(`[BigFileUpload] Extracted URL from text response: ${bestMatch}`);
        return bestMatch;
    }

    // Strategy 4: Handle relative URLs
    if (trimmed.startsWith("/") && baseUrl) {
        return resolveUrl(trimmed, baseUrl);
    }

    // If nothing worked, return trimmed response (might be a valid URL)
    return trimmed;
}

/**
 * Resolve potentially relative URL against a base URL
 */
function resolveUrl(url: string, baseUrl?: string): string {
    if (!url) return "";

    // Already absolute
    if (url.startsWith("http://") || url.startsWith("https://")) {
        return url;
    }

    // Relative URL - need base
    if (baseUrl) {
        try {
            const base = new URL(baseUrl);
            if (url.startsWith("/")) {
                return `${base.protocol}//${base.host}${url}`;
            }
            // Relative path
            return new URL(url, baseUrl).href;
        } catch {
            // Failed to construct URL
        }
    }

    // Return as-is
    return url;
}

const nativeLog = {
    info: (...args: any[]) => {
        if (levelPriority[currentLoggingLevel] >= levelPriority.info) {
            console.log(...args);
        }
    },
    debug: (...args: any[]) => {
        if (levelPriority[currentLoggingLevel] >= levelPriority.debug) {
            console.debug(...args);
        }
    },
    warn: (...args: any[]) => console.warn(...args),
    error: (...args: any[]) => console.error(...args)
};

function updateLoggingLevel(level?: LoggingLevel) {
    currentLoggingLevel = level ?? "errors";
}

/**
 * Save ArrayBuffer to temporary file (fallback when file.path not available)
 * Uses timestamp + random UUID to prevent collisions with concurrent uploads
 */
async function saveTempFile(fileBuffer: ArrayBuffer, fileName: string): Promise<string> {
    const tempDir = os.tmpdir();
    // Use both timestamp and random string to prevent collision in concurrent uploads
    const uniqueId = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const tempFileName = `vencord-upload-${uniqueId}-${fileName}`;
    const tempPath = path.join(tempDir, tempFileName);

    await fs.promises.writeFile(tempPath, Buffer.from(fileBuffer));

    return tempPath;
}

/**
 * Race multiple upload promises and return the first successful one.
 * Unlike Promise.race(), this ignores rejections/nulls and waits for the first success.
 * If all promises reject or return null, returns null.
 */
async function raceToFirstSuccess<T>(
    promises: Array<Promise<T | null>>
): Promise<T | null> {
    if (promises.length === 0) return null;

    return new Promise(resolve => {
        let settled = false;
        let pendingCount = promises.length;

        for (const promise of promises) {
            promise
                .then(result => {
                    if (!settled && result !== null) {
                        settled = true;
                        resolve(result);
                    } else {
                        pendingCount--;
                        if (pendingCount === 0 && !settled) {
                            resolve(null);
                        }
                    }
                })
                .catch(() => {
                    pendingCount--;
                    if (pendingCount === 0 && !settled) {
                        resolve(null);
                    }
                });
        }
    });
}

/**
 * Delete temporary file
 */
async function deleteTempFile(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
        nativeLog.debug(`[BigFileUpload] Temp file deleted: ${filePath}`);
    } catch (error) {
        // Log cleanup errors at debug level to help diagnose orphaned temp files
        // Don't throw - cleanup failure shouldn't break the upload flow
        const errorMsg = error instanceof Error ? error.message : String(error);
        nativeLog.debug(`[BigFileUpload] Failed to delete temp file ${filePath}: ${errorMsg}`);
    }
}

async function getGoFileUploadUrl(): Promise<string> {
    // GoFile API updated May 2025 - uses global upload endpoint
    // Regional endpoints available: upload-eu-par, upload-na-phx, upload-ap-sgp, etc.
    return "https://upload.gofile.io/uploadfile";
}

/**
 * Stream file upload using PUT request (for transfer.sh)
 * Streams file directly without multipart encoding
 */
function streamFilePutUpload(
    url: string,
    filePath: string,
    fileName: string,
    customHeaders: Record<string, string> = {},
    webContents?: WebContents,
    uploadId?: string,
    timeout: number = 300000
): Promise<string> {
    let isCancelled = false;

    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === "https:";
        const client = isHttps ? https : http;

        // Verify file exists and get size
        if (!fs.existsSync(filePath)) {
            reject(new Error(`File not found: ${filePath}`));
            return;
        }

        const fileStats = fs.statSync(filePath);
        const fileSize = fileStats.size;

        // Validate file size is non-zero
        if (fileSize === 0) {
            reject(new Error(`File is empty (0 bytes): ${filePath}`));
            return;
        }

        // Validate file is readable
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
        } catch (err) {
            reject(new Error(`File is not readable: ${filePath}`));
            return;
        }

        const options: any = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": fileSize,
                ...customHeaders
            }
        };

        // Add TLS options for HTTPS connections to prevent handshake issues
        if (isHttps) {
            // Create a custom agent with proper TLS settings
            options.agent = new https.Agent({
                keepAlive: true,
                timeout: 30000,
                rejectUnauthorized: true
            });
        }

        const startTime = Date.now();
        let lastProgressTime = Date.now();
        let uploadedBytes = 0;

        // Stall detection
        const stallCheckInterval = setInterval(() => {
            const timeSinceLastProgress = Date.now() - lastProgressTime;
            if (timeSinceLastProgress > 300000) { // 5 minutes
                clearInterval(stallCheckInterval);
                req.destroy();
                reject(new Error("Upload stalled - no progress for 5 minutes"));
            }
        }, 10000);

        const req = client.request(options, res => {
            let responseData = "";
            let responseTruncated = false;

            // Set socket timeout to prevent hanging connections
            res.socket.setTimeout(60000); // 60 second timeout for responses

            res.on("data", chunk => {
                // Security: Limit response size to prevent memory exhaustion
                if (responseData.length + chunk.length > MAX_RESPONSE_SIZE) {
                    if (!responseTruncated) {
                        nativeLog.warn(`[BigFileUpload] Response exceeded ${MAX_RESPONSE_SIZE} bytes, truncating`);
                        responseTruncated = true;
                    }
                    return; // Stop accumulating data
                }
                responseData += chunk;
            });

            res.on("end", () => {
                clearInterval(stallCheckInterval);

                if (uploadId) {
                    activeRequests.delete(uploadId);
                }

                // Check if this upload was cancelled before resolving
                if (uploadId && cancelledUploads.has(uploadId)) {
                    cancelledUploads.delete(uploadId);
                    reject(new Error("Upload cancelled by user"));
                    return;
                }

                // Reject truncated responses to prevent JSON parsing errors
                if (responseTruncated) {
                    reject(new Error(`Response exceeded maximum size (${MAX_RESPONSE_SIZE} bytes) and was truncated. The upload may have succeeded but the response could not be processed.`));
                    return;
                }

                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    // Clean up from cancelled set only on successful completion
                    if (uploadId) {
                        cancelledUploads.delete(uploadId);
                    }
                    resolve(responseData);
                } else {

                    let errorMessage = `HTTP ${res.statusCode}: ${res.statusMessage}`;

                    if (res.statusCode === 500) {
                        errorMessage = "HTTP 500: Server Internal Error - The upload service is experiencing issues. Try using a different uploader (temp.sh, Catbox, 0x0.st, or file.io).";
                    } else if (res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) {
                        errorMessage = `HTTP ${res.statusCode}: Service Unavailable - The upload service is temporarily down or overloaded. Try using a different uploader.`;
                    } else if (res.statusCode === 429) {
                        errorMessage = "HTTP 429: Rate Limited - Too many requests. Please wait before trying again.";
                    } else if (res.statusCode === 413) {
                        errorMessage = "HTTP 413: File Too Large - The file exceeds the service's size limit.";
                    }

                    if (responseData && responseData.length > 0 && responseData.length < 500) {
                        errorMessage += `\nServer response: ${responseData}`;
                    }

                    reject(new Error(errorMessage));
                }
            });
        });

        // Set request timeout (user-configurable, default 5 minutes)
        req.setTimeout(timeout);

        req.on("timeout", () => {
            clearInterval(stallCheckInterval);
            if (uploadId) {
                activeRequests.delete(uploadId);
            }
            req.destroy();
            reject(new Error("Request timeout - The server took too long to respond."));
        });

        req.on("error", error => {
            clearInterval(stallCheckInterval);
            if (uploadId) {
                activeRequests.delete(uploadId);
            }
            if (isCancelled) {
                reject(new Error("Upload cancelled by user"));
            } else {
                const errorMessage = error.message || String(error);
                if (errorMessage.includes("ECONNRESET") || errorMessage.includes("Client network socket disconnected")) {
                    // More detailed error for connection reset
                    const serviceName = url.includes("0x0.st") ? "0x0.st" :
                        url.includes("tmpfiles.org") ? "tmpfiles.org" :
                            url.includes("catbox") ? "Catbox/Litterbox" :
                                "the upload service";

                    let alternativeServices = "";
                    if (url.includes("catbox") || url.includes("litterbox")) {
                        alternativeServices = "Please try using: 0x0.st, tmpfiles.org, temp.sh, file.io, or transfer.sh instead.";
                    } else if (url.includes("0x0.st") || url.includes("tmpfiles")) {
                        alternativeServices = "Please try using: Catbox, Litterbox, temp.sh, file.io, or transfer.sh instead.";
                    } else {
                        alternativeServices = "Please try using a different uploader service.";
                    }

                    reject(new Error(`Connection blocked to ${serviceName} - This could mean:\n` +
                        "1. Your network/firewall is blocking SSL/TLS connections to this service\n" +
                        "2. The service is blocked by your ISP or organization\n" +
                        "3. There's a proxy interfering with the connection\n\n" +
                        "Try using a VPN, proxy, or connecting from a different network.\n\n" +
                        alternativeServices));
                } else if (errorMessage.includes("ETIMEDOUT")) {
                    reject(new Error("Connection timed out - The upload service did not respond in time. Try again or use a different uploader."));
                } else if (errorMessage.includes("ENOTFOUND")) {
                    reject(new Error("Service not found - Cannot reach the upload service. Check your internet connection."));
                } else if (errorMessage.includes("EPIPE") || errorMessage.includes("ECONNABORTED")) {
                    reject(new Error("Connection aborted - The server terminated the connection. This may be due to file size limits or server issues. Try a different uploader."));
                } else if (errorMessage.includes("self signed certificate") || errorMessage.includes("SELF_SIGNED") ||
                    errorMessage.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") || errorMessage.includes("DEPTH_ZERO_SELF_SIGNED_CERT")) {
                    // Certificate errors - likely behind corporate proxy or firewall
                    const serviceName = url.includes("0x0.st") ? "0x0.st" :
                        url.includes("tmpfiles.org") ? "tmpfiles.org" :
                            url.includes("catbox") ? "Catbox/Litterbox" :
                                url.includes("temp.sh") ? "temp.sh" :
                                    url.includes("filebin.net") ? "filebin.net" :
                                        url.includes("buzzheavier") ? "buzzheavier.com" :
                                            url.includes("gofile") ? "GoFile" :
                                                "the upload service";

                    reject(new Error(`SSL certificate error with ${serviceName} - You may be behind a corporate firewall or proxy that uses self-signed certificates. ` +
                        "The plugin will try alternative uploaders automatically."));
                } else {
                    reject(error);
                }
            }
        });

        // Progress tracking helper
        const logProgress = () => {
            // Don't send progress for cancelled uploads
            if (uploadId && cancelledUploads.has(uploadId)) {
                return;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const uploadSpeed = uploadedBytes / elapsed / 1024 / 1024; // MB/s
            const percentComplete = (uploadedBytes / fileSize) * 100;
            const remaining = elapsed > 0 ? (fileSize - uploadedBytes) / (uploadedBytes / elapsed) : 0;

            if (webContents && !webContents.isDestroyed() && uploadId) {
                const progressData = {
                    uploadId,
                    fileName,
                    loaded: uploadedBytes,
                    total: fileSize,
                    percent: percentComplete,
                    speed: uploadSpeed,
                    eta: remaining
                };

                latestProgress = progressData;
            }
        };

        // Stream file directly from disk
        const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
        let lastLogBytes = 0;

        fileStream.on("data", chunk => {
            // Stop processing if cancelled (use local flag, not global set)
            if (isCancelled) {
                fileStream.destroy();
                return;
            }

            const canContinue = req.write(chunk);
            uploadedBytes += chunk.length;
            lastProgressTime = Date.now();

            // Progress logging
            let logInterval: number;
            if (fileSize > 100 * 1024 * 1024) {
                logInterval = 5 * 1024 * 1024; // 5MB for large files
            } else if (fileSize > 10 * 1024 * 1024) {
                logInterval = 2 * 1024 * 1024; // 2MB for medium files
            } else {
                logInterval = 512 * 1024; // 512KB for small files
            }

            if (uploadedBytes - lastLogBytes >= logInterval || uploadedBytes === chunk.length) {
                logProgress();
                lastLogBytes = uploadedBytes;
            }

            if (!canContinue) {
                fileStream.pause();
                req.once("drain", () => {
                    fileStream.resume();
                });
            }
        });

        fileStream.on("end", () => {
            // Don't finish the request if upload was cancelled (use local flag)
            if (isCancelled) {
                req.destroy();
                return;
            }
            logProgress();
            req.end();
        });

        fileStream.on("error", error => {
            clearInterval(stallCheckInterval);
            req.destroy();
            reject(error);
        });

        // Store request for cancellation
        if (uploadId) {
            activeRequests.set(uploadId, {
                req,
                cleanup: () => {
                    isCancelled = true;
                    clearInterval(stallCheckInterval);
                    // Destroy file stream first to stop reading
                    try {
                        fileStream.destroy();
                    } catch (e) {
                        // Ignore errors
                    }
                    // Aggressively abort the request without flushing
                    try {
                        // Destroy underlying socket immediately to prevent any more data transmission
                        if (req.socket) {
                            req.socket.destroy();
                        }
                        // Also destroy the request itself
                        req.destroy();
                    } catch (e) {
                        // Ignore errors
                    }
                }
            });
        }
    });
}

/**
 * Stream binary file upload for custom uploaders (PUT/PATCH/POST with raw body)
 * Similar to streamFilePutUpload but with configurable method and content type
 * Used for ShareX-style binary uploads where the file is sent as raw request body
 */
function streamFileBinaryCustom(
    url: string,
    filePath: string,
    fileName: string,
    fileType: string,
    method: "PUT" | "PATCH" | "POST",
    customHeaders: Record<string, string> = {},
    webContents?: WebContents,
    uploadId?: string,
    timeout: number = 300000
): Promise<string> {
    let isCancelled = false;

    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === "https:";
        const client = isHttps ? https : http;

        // SSRF protection: reject private/reserved IPs
        if (isPrivateOrReservedIP(urlObj.hostname)) {
            reject(new Error(`Custom uploader: Blocked request to private/reserved IP: ${urlObj.hostname}`));
            return;
        }

        // Verify file exists and get size
        if (!fs.existsSync(filePath)) {
            reject(new Error(`File not found: ${filePath}`));
            return;
        }

        const fileStats = fs.statSync(filePath);
        const fileSize = fileStats.size;

        // Validate file size is non-zero
        if (fileSize === 0) {
            reject(new Error(`File is empty (0 bytes): ${filePath}`));
            return;
        }

        // Validate file is readable
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
        } catch (err) {
            reject(new Error(`File is not readable: ${filePath}`));
            return;
        }

        // Sanitize custom headers to remove dangerous headers
        const sanitizedHeaders = sanitizeHeaders(customHeaders);

        const options: any = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: {
                "Content-Type": fileType || "application/octet-stream",
                "Content-Length": fileSize,
                "User-Agent": "Vencord-BigFileUpload/1.0",
                ...sanitizedHeaders
            }
        };

        // Add TLS options for HTTPS connections
        if (isHttps) {
            options.agent = new https.Agent({
                keepAlive: true,
                timeout: 30000,
                rejectUnauthorized: true
            });
        }

        const startTime = Date.now();
        let lastProgressTime = Date.now();
        let uploadedBytes = 0;

        // Stall detection
        const stallCheckInterval = setInterval(() => {
            const timeSinceLastProgress = Date.now() - lastProgressTime;
            if (timeSinceLastProgress > 300000) { // 5 minutes
                clearInterval(stallCheckInterval);
                req.destroy();
                reject(new Error("Upload stalled - no progress for 5 minutes"));
            }
        }, 10000);

        const req = client.request(options, res => {
            let responseData = "";
            let responseTruncated = false;

            res.socket.setTimeout(60000);

            res.on("data", chunk => {
                if (responseData.length + chunk.length > MAX_RESPONSE_SIZE) {
                    if (!responseTruncated) {
                        nativeLog.warn(`[BigFileUpload] Response exceeded ${MAX_RESPONSE_SIZE} bytes, truncating`);
                        responseTruncated = true;
                    }
                    return;
                }
                responseData += chunk;
            });

            res.on("end", () => {
                clearInterval(stallCheckInterval);

                if (uploadId) {
                    activeRequests.delete(uploadId);
                }

                if (uploadId && cancelledUploads.has(uploadId)) {
                    cancelledUploads.delete(uploadId);
                    reject(new Error("Upload cancelled by user"));
                    return;
                }

                if (responseTruncated) {
                    reject(new Error(`Response exceeded maximum size (${MAX_RESPONSE_SIZE} bytes) and was truncated.`));
                    return;
                }

                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    if (uploadId) {
                        cancelledUploads.delete(uploadId);
                    }
                    resolve(responseData);
                } else {
                    let errorMessage = `HTTP ${res.statusCode}: ${res.statusMessage}`;

                    if (res.statusCode === 500) {
                        errorMessage = "HTTP 500: Server Internal Error - The custom upload service is experiencing issues.";
                    } else if (res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) {
                        errorMessage = `HTTP ${res.statusCode}: Service Unavailable - The custom upload service is temporarily down.`;
                    } else if (res.statusCode === 429) {
                        errorMessage = "HTTP 429: Rate Limited - Too many requests to the custom uploader.";
                    } else if (res.statusCode === 413) {
                        errorMessage = "HTTP 413: File Too Large - The file exceeds the custom service's size limit.";
                    }

                    if (responseData && responseData.length > 0 && responseData.length < 500) {
                        errorMessage += `\nServer response: ${responseData}`;
                    }

                    reject(new Error(errorMessage));
                }
            });
        });

        // Set request timeout (user-configurable, default 5 minutes)
        req.setTimeout(timeout);

        req.on("timeout", () => {
            clearInterval(stallCheckInterval);
            if (uploadId) {
                activeRequests.delete(uploadId);
            }
            req.destroy();
            reject(new Error("Request timeout - The custom uploader took too long to respond."));
        });

        req.on("error", error => {
            clearInterval(stallCheckInterval);
            if (uploadId) {
                activeRequests.delete(uploadId);
            }
            if (isCancelled) {
                reject(new Error("Upload cancelled by user"));
            } else {
                reject(error);
            }
        });

        // Progress tracking
        const logProgress = () => {
            if (uploadId && cancelledUploads.has(uploadId)) {
                return;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const uploadSpeed = uploadedBytes / elapsed / 1024 / 1024;
            const percentComplete = (uploadedBytes / fileSize) * 100;
            const remaining = elapsed > 0 ? (fileSize - uploadedBytes) / (uploadedBytes / elapsed) : 0;

            if (webContents && !webContents.isDestroyed() && uploadId) {
                latestProgress = {
                    uploadId,
                    fileName,
                    loaded: uploadedBytes,
                    total: fileSize,
                    percent: percentComplete,
                    speed: uploadSpeed,
                    eta: remaining
                };
            }
        };

        // Stream file directly from disk
        const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
        let lastLogBytes = 0;

        fileStream.on("data", chunk => {
            if (isCancelled) {
                fileStream.destroy();
                return;
            }

            const canContinue = req.write(chunk);
            uploadedBytes += chunk.length;
            lastProgressTime = Date.now();

            let logInterval: number;
            if (fileSize > 100 * 1024 * 1024) {
                logInterval = 5 * 1024 * 1024;
            } else if (fileSize > 10 * 1024 * 1024) {
                logInterval = 2 * 1024 * 1024;
            } else {
                logInterval = 512 * 1024;
            }

            if (uploadedBytes - lastLogBytes >= logInterval || uploadedBytes === chunk.length) {
                logProgress();
                lastLogBytes = uploadedBytes;
            }

            if (!canContinue) {
                fileStream.pause();
                req.once("drain", () => {
                    fileStream.resume();
                });
            }
        });

        fileStream.on("end", () => {
            if (isCancelled) {
                req.destroy();
                return;
            }
            logProgress();
            req.end();
        });

        fileStream.on("error", error => {
            clearInterval(stallCheckInterval);
            req.destroy();
            reject(error);
        });

        // Store request for cancellation
        if (uploadId) {
            activeRequests.set(uploadId, {
                req,
                cleanup: () => {
                    isCancelled = true;
                    clearInterval(stallCheckInterval);
                    try {
                        fileStream.destroy();
                    } catch (e) { /* ignore */ }
                    try {
                        if (req.socket) {
                            req.socket.destroy();
                        }
                        req.destroy();
                    } catch (e) { /* ignore */ }
                }
            });
        }
    });
}

/**
 * Stream file upload with multipart/form-data encoding built on-the-fly
 * Streams directly from the file's original location on disk
 * NO ArrayBuffer conversion needed - NO RAM limitation!
 */
function streamFileUpload(
    url: string,
    filePath: string,
    fileName: string,
    fileType: string,
    fileFieldName: string,
    fields: Record<string, string>,
    customHeaders: Record<string, string> = {},
    webContents?: WebContents,
    uploadId?: string,
    timeout: number = 300000
): Promise<string> {
    // Track cancellation state outside Promise to allow cleanup function to modify it
    let isCancelled = false;

    return new Promise((resolve, reject) => {
        const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === "https:";
        const client = isHttps ? https : http;

        // Verify file exists and get size
        if (!fs.existsSync(filePath)) {
            reject(new Error(`File not found: ${filePath}`));
            return;
        }

        const fileStats = fs.statSync(filePath);
        const fileSize = fileStats.size;

        // Validate file size is non-zero
        if (fileSize === 0) {
            reject(new Error(`File is empty (0 bytes): ${filePath}`));
            return;
        }

        // Validate file is readable
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
        } catch (err) {
            reject(new Error(`File is not readable: ${filePath}`));
            return;
        }

        // Build header parts of multipart form data
        const preludeChunks: Buffer[] = [];

        // Add text fields
        for (const [key, value] of Object.entries(fields)) {
            if (key && key.trim() !== "") {
                preludeChunks.push(Buffer.from(
                    `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
                    `${value}\r\n`
                ));
            }
        }

        // Add file header
        preludeChunks.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\n` +
            `Content-Type: ${fileType || "application/octet-stream"}\r\n\r\n`
        ));

        const prelude = Buffer.concat(preludeChunks);
        const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);

        const totalSize = prelude.length + fileSize + epilogue.length;

        const options: any = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: "POST",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": totalSize,
                ...customHeaders
            }
        };

        // Add TLS options for HTTPS connections to prevent handshake issues
        if (isHttps) {
            // Create a custom agent with proper TLS settings
            options.agent = new https.Agent({
                keepAlive: true,
                timeout: 30000,
                rejectUnauthorized: true
            });
        }

        const startTime = Date.now();
        let lastProgressTime = Date.now();
        let uploadedBytes = 0;

        // Stall detection
        const stallCheckInterval = setInterval(() => {
            const timeSinceLastProgress = Date.now() - lastProgressTime;
            if (timeSinceLastProgress > 300000) { // 5 minutes
                clearInterval(stallCheckInterval);
                req.destroy();
                reject(new Error("Upload stalled - no progress for 5 minutes"));
            }
        }, 10000);

        const req = client.request(options, res => {
            let responseData = "";
            let responseTruncated = false;

            // Set socket timeout to prevent hanging connections
            res.socket.setTimeout(60000); // 60 second timeout for responses

            res.on("data", chunk => {
                // Security: Limit response size to prevent memory exhaustion
                if (responseData.length + chunk.length > MAX_RESPONSE_SIZE) {
                    if (!responseTruncated) {
                        nativeLog.warn(`[BigFileUpload] Response exceeded ${MAX_RESPONSE_SIZE} bytes, truncating`);
                        responseTruncated = true;
                    }
                    return; // Stop accumulating data
                }
                responseData += chunk;
            });

            res.on("end", () => {
                clearInterval(stallCheckInterval);

                // Remove from active requests on completion
                if (uploadId) {
                    activeRequests.delete(uploadId);
                }

                // Check if this upload was cancelled before resolving
                if (uploadId && cancelledUploads.has(uploadId)) {
                    cancelledUploads.delete(uploadId);
                    reject(new Error("Upload cancelled by user"));
                    return;
                }

                // Reject truncated responses to prevent JSON parsing errors
                if (responseTruncated) {
                    reject(new Error(`Response exceeded maximum size (${MAX_RESPONSE_SIZE} bytes) and was truncated. The upload may have succeeded but the response could not be processed.`));
                    return;
                }

                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    // Clean up from cancelled set only on successful completion
                    if (uploadId) {
                        cancelledUploads.delete(uploadId);
                    }
                    resolve(responseData);
                } else {
                    // Enhanced error messages based on status code
                    let errorMessage = `HTTP ${res.statusCode}: ${res.statusMessage}`;

                    if (res.statusCode === 500) {
                        errorMessage = "HTTP 500: Server Internal Error - The upload service is experiencing issues. This is a server-side problem, not a client error.";
                    } else if (res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) {
                        errorMessage = `HTTP ${res.statusCode}: Service Unavailable - The upload service is temporarily down or overloaded.`;
                    } else if (res.statusCode === 429) {
                        errorMessage = "HTTP 429: Rate Limited - Too many requests. Please wait before trying again.";
                    } else if (res.statusCode === 413) {
                        errorMessage = "HTTP 413: File Too Large - The file exceeds the service's size limit.";
                    } else if (res.statusCode && res.statusCode >= 400 && res.statusCode < 500) {
                        errorMessage = `HTTP ${res.statusCode}: Client Error - ${res.statusMessage}`;
                    }

                    if (responseData && responseData.length > 0 && responseData.length < 500) {
                        errorMessage += `\nServer response: ${responseData}`;
                    }

                    reject(new Error(errorMessage));
                }
            });
        });

        // Set request timeout (user-configurable, default 5 minutes)
        req.setTimeout(timeout);

        req.on("timeout", () => {
            clearInterval(stallCheckInterval);
            if (uploadId) {
                activeRequests.delete(uploadId);
            }
            req.destroy();
            reject(new Error("Request timeout - The server took too long to respond."));
        });

        req.on("error", error => {
            clearInterval(stallCheckInterval);
            // Remove from active requests on error
            if (uploadId) {
                activeRequests.delete(uploadId);
            }
            // If cancelled, reject with a specific cancellation error instead of socket hang up
            if (isCancelled) {
                reject(new Error("Upload cancelled by user"));
            } else {
                // Enhance error messages for common network issues
                const errorMessage = error.message || String(error);
                if (errorMessage.includes("ECONNRESET") || errorMessage.includes("Client network socket disconnected")) {
                    // More detailed error for connection reset
                    const serviceName = url.includes("0x0.st") ? "0x0.st" :
                        url.includes("tmpfiles.org") ? "tmpfiles.org" :
                            url.includes("catbox") ? "Catbox/Litterbox" :
                                "the upload service";

                    let alternativeServices = "";
                    if (url.includes("catbox") || url.includes("litterbox")) {
                        alternativeServices = "Please try using: 0x0.st, tmpfiles.org, temp.sh, file.io, or transfer.sh instead.";
                    } else if (url.includes("0x0.st") || url.includes("tmpfiles")) {
                        alternativeServices = "Please try using: Catbox, Litterbox, temp.sh, file.io, or transfer.sh instead.";
                    } else {
                        alternativeServices = "Please try using a different uploader service.";
                    }

                    reject(new Error(`Connection blocked to ${serviceName} - This could mean:\n` +
                        "1. Your network/firewall is blocking SSL/TLS connections to this service\n" +
                        "2. The service is blocked by your ISP or organization\n" +
                        "3. There's a proxy interfering with the connection\n\n" +
                        "Try using a VPN, proxy, or connecting from a different network.\n\n" +
                        alternativeServices));
                } else if (errorMessage.includes("ETIMEDOUT")) {
                    reject(new Error("Connection timed out - The upload service did not respond in time. Try again or use a different uploader."));
                } else if (errorMessage.includes("ENOTFOUND")) {
                    reject(new Error("Service not found - Cannot reach the upload service. Check your internet connection."));
                } else if (errorMessage.includes("EPIPE") || errorMessage.includes("ECONNABORTED")) {
                    reject(new Error("Connection aborted - The server terminated the connection. This may be due to file size limits or server issues. Try a different uploader."));
                } else if (errorMessage.includes("self signed certificate") || errorMessage.includes("SELF_SIGNED") ||
                    errorMessage.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") || errorMessage.includes("DEPTH_ZERO_SELF_SIGNED_CERT")) {
                    // Certificate errors - likely behind corporate proxy or firewall
                    const serviceName = url.includes("0x0.st") ? "0x0.st" :
                        url.includes("tmpfiles.org") ? "tmpfiles.org" :
                            url.includes("catbox") ? "Catbox/Litterbox" :
                                url.includes("temp.sh") ? "temp.sh" :
                                    url.includes("filebin.net") ? "filebin.net" :
                                        url.includes("buzzheavier") ? "buzzheavier.com" :
                                            url.includes("gofile") ? "GoFile" :
                                                "the upload service";

                    reject(new Error(`SSL certificate error with ${serviceName} - You may be behind a corporate firewall or proxy that uses self-signed certificates. ` +
                        "The plugin will try alternative uploaders automatically."));
                } else {
                    reject(error);
                }
            }
        });

        // Progress tracking helper
        const logProgress = () => {
            // Don't send progress for cancelled uploads
            if (uploadId && cancelledUploads.has(uploadId)) {
                return;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const uploadSpeed = uploadedBytes / elapsed / 1024 / 1024; // MB/s
            const percentComplete = (uploadedBytes / totalSize) * 100;
            const remaining = elapsed > 0 ? (totalSize - uploadedBytes) / (uploadedBytes / elapsed) : 0;

            // Send IPC progress update to renderer if webContents provided
            if (webContents && !webContents.isDestroyed() && uploadId) {
                const progressData = {
                    uploadId,
                    fileName,
                    loaded: uploadedBytes,
                    total: totalSize,
                    percent: percentComplete,
                    speed: uploadSpeed,
                    eta: remaining
                };

                // Store for polling
                latestProgress = progressData;
            }
        };

        // Write prelude
        req.write(prelude);
        uploadedBytes += prelude.length;
        lastProgressTime = Date.now();

        // Stream file directly from disk in 256KB chunks
        const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
        let lastLogBytes = 0;
        let fileStreamBytes = 0; // Track file bytes separately for accurate progress

        fileStream.on("data", chunk => {
            // Stop processing if cancelled (use local flag, not global set)
            if (isCancelled) {
                fileStream.destroy();
                return;
            }

            const canContinue = req.write(chunk);
            uploadedBytes += chunk.length;
            fileStreamBytes += chunk.length;
            lastProgressTime = Date.now();

            // More frequent progress logging: every 5MB for large files (>100MB), every 2MB for medium files (>10MB), every 512KB for small files
            let logInterval: number;
            if (fileSize > 100 * 1024 * 1024) {
                logInterval = 5 * 1024 * 1024; // 5MB for large files
            } else if (fileSize > 10 * 1024 * 1024) {
                logInterval = 2 * 1024 * 1024; // 2MB for medium files
            } else {
                logInterval = 512 * 1024; // 512KB for small files
            }

            if (fileStreamBytes - lastLogBytes >= logInterval || fileStreamBytes === chunk.length) {
                logProgress();
                lastLogBytes = fileStreamBytes;
            }

            if (!canContinue) {
                fileStream.pause();
                req.once("drain", () => {
                    fileStream.resume();
                });
            }
        });

        fileStream.on("end", () => {
            // Don't finish the request if upload was cancelled (use local flag)
            if (isCancelled) {
                req.destroy();
                return;
            }

            // Write epilogue
            req.write(epilogue);
            uploadedBytes += epilogue.length;
            lastProgressTime = Date.now();

            logProgress();

            // For small files, add a small delay to ensure data is flushed
            if (fileSize < 1024 * 1024) { // Less than 1MB
                setTimeout(() => {
                    req.end();
                }, 100);
            } else {
                req.end();
            }
        });

        fileStream.on("error", error => {
            clearInterval(stallCheckInterval);
            req.destroy();
            reject(error);
        });

        // Store request for cancellation if uploadId provided
        if (uploadId) {
            activeRequests.set(uploadId, {
                req,
                cleanup: () => {
                    isCancelled = true; // Mark as cancelled
                    clearInterval(stallCheckInterval);
                    // Destroy file stream first to stop reading
                    try {
                        fileStream.destroy();
                    } catch (e) {
                        // Ignore errors
                    }
                    // Aggressively abort the request without flushing
                    try {
                        // Destroy underlying socket immediately to prevent any more data transmission
                        if (req.socket) {
                            req.socket.destroy();
                        }
                        // Also destroy the request itself
                        req.destroy();
                    } catch (e) {
                        // Ignore errors
                    }
                }
            });
        }
    });
}

/**
 * GoFile upload - streams from disk (path or temp file)
 */
export async function uploadFileToGofileNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, token?: string, uploadId?: string, timeout: number = 300000): Promise<GoFileResponse> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        // Check if we got a path string or ArrayBuffer
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            // Fallback: Save ArrayBuffer to temp file
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for GoFile upload");
        }

        const fields: Record<string, string> = {};
        if (token) {
            fields.token = token;
        }

        const uploadUrl = await getGoFileUploadUrl();
        const responseText = await streamFileUpload(
            uploadUrl,
            filePath,
            fileName,
            "application/octet-stream",
            "file",
            fields,
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        const result = JSON.parse(responseText);

        // Clean up temp file if we created one
        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return result;
    } catch (error) {
        // Clean up temp file even on error
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * Catbox upload - streams from disk (path or temp file)
 */
export async function uploadFileToCatboxNative(event: Electron.IpcMainInvokeEvent, url: string, filePathOrBuffer: string | ArrayBuffer, fileName: string, fileType: string, userHash: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for Catbox upload");
        }

        const fields: Record<string, string> = {
            reqtype: "fileupload"
        };

        const trimmedHash = userHash?.trim();
        if (trimmedHash) {
            fields.userhash = trimmedHash;
        }

        const result = await streamFileUpload(
            url,
            filePath,
            fileName,
            fileType,
            "fileToUpload",
            fields,
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return result;
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * Litterbox upload - streams from disk (path or temp file)
 */
export async function uploadFileToLitterboxNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, fileType: string, time: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for Litterbox upload");
        }

        const fields: Record<string, string> = {
            reqtype: "fileupload",
            time: time
        };

        const result = await streamFileUpload(
            "https://litterbox.catbox.moe/resources/internals/api.php",
            filePath,
            fileName,
            fileType,
            "fileToUpload",
            fields,
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return result;
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * transfer.sh upload - streams from disk (path or temp file)
 * Max size: ~10 GB, retention: 14 days (default, configurable via Max-Days header)
 * Uses PUT request as documented by transfer.sh
 */
export async function uploadFileToTransferShNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, maxDays?: string, maxDownloads?: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for transfer.sh upload");
        }

        const customHeaders: Record<string, string> = {
            "User-Agent": "Vencord-BigFileUpload/1.0"
        };

        // Add Max-Days header if specified
        if (maxDays && maxDays.trim() !== "") {
            customHeaders["Max-Days"] = maxDays;
        }

        // Add Max-Downloads header if specified
        if (maxDownloads && maxDownloads.trim() !== "") {
            customHeaders["Max-Downloads"] = maxDownloads;
        }

        // transfer.sh uses PUT request (not multipart form data)
        const result = await streamFilePutUpload(
            `https://transfer.sh/${encodeURIComponent(fileName)}`,
            filePath,
            fileName,
            customHeaders,
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return result.trim();
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * temp.sh upload - streams from disk (path or temp file)
 * Max size: 4 GB, retention: 3 days (automatic)
 */
export async function uploadFileToTempShNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for temp.sh upload");
        }

        // temp.sh uses standard multipart form upload
        const result = await streamFileUpload(
            "https://temp.sh/upload",
            filePath,
            fileName,
            "application/octet-stream",
            "file",
            {},
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return result.trim();
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * tmpfiles.org upload - streams from disk (path or temp file)
 * Max size: 100 MB, retention: 60 minutes (automatic)
 */
export async function uploadFileToTmpFilesNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for tmpfiles.org upload");
        }

        // tmpfiles.org uses standard multipart form upload
        const responseText = await streamFileUpload(
            "https://tmpfiles.org/api/v1/upload",
            filePath,
            fileName,
            "application/octet-stream",
            "file",
            {},
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        // Parse JSON response
        const result = JSON.parse(responseText);
        if (result.status === "success" && result.data?.url) {
            if (isTempFile) {
                await deleteTempFile(filePath);
            }

            // Convert URL to /dl/ format for proper embedding
            let downloadUrl = result.data.url;
            if (downloadUrl.includes("tmpfiles.org/") && !downloadUrl.includes("/dl/")) {
                downloadUrl = downloadUrl.replace(/tmpfiles\.org\/(\d+)/, "tmpfiles.org/dl/$1");
            }

            return downloadUrl;
        } else {
            throw new Error(`tmpfiles.org upload failed: ${responseText}`);
        }
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * filebin.net upload - streams from disk (path or temp file)
 * Max size: Unlimited, retention: 6 days (automatic)
 * Uses 3-step process: generate bin ID, upload file, get URL
 */
export async function uploadFileToFilebinNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for filebin.net upload");
        }

        // Generate a random bin ID
        const binId = crypto.randomBytes(6).toString("hex");

        // Upload file to bin
        await streamFileUpload(
            `https://filebin.net/${binId}/${encodeURIComponent(fileName)}`,
            filePath,
            fileName,
            "application/octet-stream",
            "file",
            {},
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        // Return the filebin URL
        return `https://filebin.net/${binId}/${encodeURIComponent(fileName)}`;
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * buzzheavier.com upload - streams from disk (path or temp file)
 * Max size: Unlimited, retention: permanent with 30+ downloads every 60 days (free), otherwise 8 days + 2 days per download
 * Uses PUT request
 */
export async function uploadFileToBuzzheavierNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for buzzheavier.com upload");
        }

        // buzzheavier uses PUT request (similar to transfer.sh)
        const responseText = await streamFilePutUpload(
            `https://w.buzzheavier.com/${encodeURIComponent(fileName)}`,
            filePath,
            fileName,
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        // Parse JSON response and extract download URL
        try {
            const result = JSON.parse(responseText);
            if (result.code === 201 && result.data?.id) {
                // Construct download URL from the file ID (without /f/ prefix)
                const downloadUrl = `https://buzzheavier.com/${result.data.id}`;
                return downloadUrl;
            } else {
                throw new Error(`Unexpected buzzheavier.com response: ${responseText}`);
            }
        } catch (parseError) {
            // If JSON parsing fails, return the raw response (fallback)
            return responseText.trim();
        }
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}


/**
 * file.io upload - streams from disk (path or temp file)
 * Max size: 4 GB (free tier), retention: ~14 days or after first download
 */
export async function uploadFileToFileIoNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, expires?: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for file.io upload");
        }

        // Build URL with expires query parameter if specified
        // Using the correct file.io API endpoint
        let uploadUrl = "https://file.io/";
        if (expires && expires.trim() !== "") {
            uploadUrl += `?expires=${encodeURIComponent(expires)}`;
        }

        const responseText = await streamFileUpload(
            uploadUrl,
            filePath,
            fileName,
            "application/octet-stream",
            "file",
            {},
            {
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        const result = JSON.parse(responseText);
        if (result.success && result.link) {
            if (isTempFile) {
                await deleteTempFile(filePath);
            }
            return result.link;
        } else {
            throw new Error(`file.io upload failed: ${responseText}`);
        }
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * 0x0.st upload - streams from disk (path or temp file)
 * Max size: 512 MiB, retention: at least 30 days (default, up to 1 year configurable via expires form field)
 */
export async function uploadFileTo0x0StNative(event: Electron.IpcMainInvokeEvent, filePathOrBuffer: string | ArrayBuffer, fileName: string, expires?: string, uploadId?: string, timeout: number = 300000): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for 0x0.st upload");
        }

        const fields: Record<string, string> = {};

        // Add expires field if specified (in hours or UNIX timestamp)
        if (expires && expires.trim() !== "") {
            fields.expires = expires;
        }

        const result = await streamFileUpload(
            "https://0x0.st",
            filePath,
            fileName,
            "application/octet-stream",
            "file",
            fields,
            {
                // 0x0.st blocks Mozilla/* and browser-like UAs
                // Use a simple custom identifier as recommended by the 0x0.st admin
                "User-Agent": "VencordBigFileUpload/1.0"
            },
            event.sender,
            uploadId,
            timeout
        );

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return result.trim();
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * Custom upload - streams from disk (path or temp file)
 */
export async function uploadFileCustomNative(
    event: Electron.IpcMainInvokeEvent,
    url: string,
    filePathOrBuffer: string | ArrayBuffer,
    fileName: string,
    fileType: string,
    fileFormName: string,
    customArgs: Record<string, string>,
    customHeaders: Record<string, string>,
    responseType: string,
    urlPath: string[],
    uploadId?: string,
    requestMethod?: string,
    bodyType?: string,
    timeout: number = 300000
): Promise<string> {
    let filePath: string | undefined;
    let isTempFile = false;

    // Default to POST and MultipartFormData if not specified
    const method = (requestMethod || "POST") as "PUT" | "PATCH" | "POST";
    const body = bodyType || "MultipartFormData";

    try {
        if (typeof filePathOrBuffer === "string") {
            filePath = filePathOrBuffer;
        } else {
            filePath = await saveTempFile(filePathOrBuffer, fileName);
            isTempFile = true;
        }

        if (!filePath) {
            throw new Error("Failed to resolve file path for custom upload");
        }

        let responseText: string;

        if (body === "Binary") {
            // Binary upload: raw file body with PUT/PATCH/POST
            nativeLog.info(`[BigFileUpload] Custom uploader using ${method} with binary body`);

            // Sanitize custom headers
            const headers = sanitizeHeaders(customHeaders);

            responseText = await streamFileBinaryCustom(
                url,
                filePath,
                fileName,
                fileType,
                method,
                headers,
                event.sender,
                uploadId,
                timeout
            );
        } else {
            // Multipart form data upload (default)
            nativeLog.info(`[BigFileUpload] Custom uploader using POST with multipart form data`);

            // Filter out empty keys
            const fields: Record<string, string> = {};
            for (const [key, value] of Object.entries(customArgs)) {
                if (key && key.trim() !== "") {
                    fields[key] = value;
                }
            }

            // Sanitize custom headers to remove dangerous headers and prevent injection
            const headers = sanitizeHeaders(customHeaders);
            // Content-Type will be set by streamFileUpload
            delete headers["Content-Type"];
            delete headers["content-type"];

            responseText = await streamFileUpload(
                url,
                filePath,
                fileName,
                fileType,
                fileFormName,
                fields,
                {
                    ...headers,
                    "User-Agent": "Vencord-BigFileUpload/1.0"
                },
                event.sender,
                uploadId,
                timeout
            );
        }

        // Use enhanced URL extraction with multi-strategy support:
        // - JSON path navigation (with array indices)
        // - Auto-detection of common URL fields
        // - Regex extraction from text responses
        // - Relative URL resolution
        const finalUrl = extractUrlFromResponse(responseText, responseType, urlPath, url);

        if (isTempFile) {
            await deleteTempFile(filePath);
        }

        return finalUrl;
    } catch (error) {
        if (isTempFile && filePath) {
            await deleteTempFile(filePath);
        }
        throw error;
    }
}

/**
 * SECURE: Upload file from ArrayBuffer (for drag-and-drop/paste of small files)
 * Renderer sends buffer, main process uploads, only URL is returned to renderer
 * Size-limited to prevent memory issues (recommended max: 1GB)
 */
export async function uploadFileBuffer(
    event: Electron.IpcMainInvokeEvent,
    buffer: ArrayBuffer,
    fileName: string,
    mimeType: string,
    uploaderSettings: {
        fileUploader: string;
        gofileToken?: string;
        catboxUserHash?: string;
        litterboxTime?: string;
        zeroX0Expires?: string;
        autoFormat?: string;
        customUploaderRequestURL?: string;
        customUploaderFileFormName?: string;
        customUploaderResponseType?: string;
        customUploaderURL?: string;
        customUploaderArgs?: string;
        customUploaderHeaders?: string;
        customUploaderRequestMethod?: string;
        customUploaderBodyType?: string;
        loggingLevel?: LoggingLevel;
        uploadTimeout?: number;
    }
): Promise<{ success: boolean; url?: string; fileName?: string; fileSize?: number; uploadId?: string; error?: string; actualUploader?: string; attemptedUploaders?: string[]; }> {
    updateLoggingLevel(uploaderSettings.loggingLevel);
    nativeLog.info(`[BigFileUpload NATIVE] uploadFileBuffer called for: ${fileName} (type: ${mimeType})`);
    nativeLog.info(`[BigFileUpload NATIVE] Received uploader setting: "${uploaderSettings.fileUploader}"`);

    try {
        const fileSize = buffer.byteLength;
        nativeLog.info(`[BigFileUpload] Uploading from buffer: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

        // Define fallback uploaders in order based on user's preference
        // Order: Catbox, Litterbox, 0x0.st, tmpfiles.org, GoFile, buzzheavier, temp.sh, filebin.net
        const FALLBACK_UPLOADERS = [
            "Catbox",
            "Litterbox",
            "0x0.st",
            "tmpfiles.org",
            "GoFile",
            "buzzheavier.com",
            "temp.sh",
            "filebin.net"
        ];

        // Start with the selected uploader, with EXE file handling
        const selectedUploader = uploaderSettings.fileUploader || "Catbox";
        const primaryUploader = getEffectiveUploader(fileName, selectedUploader);
        nativeLog.info(`[BigFileUpload NATIVE] Primary uploader will be: ${primaryUploader}`);

        // Build the list of uploaders to try (primary + fallbacks)
        const uploadersToTry = [primaryUploader];

        // IMPORTANT: Don't skip Custom in the primary position, only skip it as a fallback
        // Also skip EXE-blocked uploaders for EXE files
        const isExe = isExeFile(fileName);
        for (const fallback of FALLBACK_UPLOADERS) {
            // Skip duplicates, skip Custom as a fallback (not as primary), and skip EXE-blocked uploaders for EXE files
            if (fallback !== primaryUploader && fallback !== "Custom" && !(isExe && EXE_BLOCKED_UPLOADERS.includes(fallback))) {
                uploadersToTry.push(fallback);
            }
        }

        // If primary is Custom and it's the only one, add a fallback
        if (primaryUploader === "Custom" && uploadersToTry.length === 1) {
            uploadersToTry.push(isExe ? "GoFile" : "Catbox");
        }

        nativeLog.info(`[BigFileUpload] Will try uploaders in order: ${uploadersToTry.join(", ")}`);

        const uploadId = `upload-${crypto.randomUUID()}`;
        nativeLog.debug(`[BigFileUpload NATIVE] Upload ID: ${uploadId}`);

        // Clean up this ID from cancelled set if it exists (shouldn't happen but be safe)
        cancelledUploads.delete(uploadId);

        // Initialize progress tracking so the progress bar shows immediately
        latestProgress = {
            uploadId,
            fileName,
            fileSize,
            loaded: 0,
            total: fileSize,
            percent: 0,
            speed: 0,
            eta: 0
        };
        latestProgressTimestamp = Date.now();

        // Helper function to attempt upload with a specific uploader
        // Returns URL on success, throws on failure
        // isBackgroundRetry: if true, don't update progress (to avoid interference)
        const tryUploader = async (uploader: string, isBackgroundRetry = false): Promise<string> => {
            let uploadResult: string;

            switch (uploader) {
                case "GoFile": {
                    const gofileResult = await uploadFileToGofileNative(
                        event,
                        buffer,
                        fileName,
                        uploaderSettings.gofileToken,
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    if (gofileResult.status === "ok" && gofileResult.data) {
                        const downloadUrl = gofileResult.data.downloadPage || (gofileResult.data.code ? `https://gofile.io/d/${gofileResult.data.code}` : undefined);
                        if (!downloadUrl) {
                            throw new Error(`GoFile response missing download URL: ${JSON.stringify(gofileResult)}`);
                        }
                        uploadResult = downloadUrl;
                    } else {
                        throw new Error(`GoFile upload failed: ${gofileResult.error || JSON.stringify(gofileResult)}`);
                    }
                    break;
                }
                case "Catbox": {
                    uploadResult = await uploadFileToCatboxNative(
                        event,
                        "https://catbox.moe/user/api.php",
                        buffer,
                        fileName,
                        mimeType || "application/octet-stream",
                        uploaderSettings.catboxUserHash || "",
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "Litterbox": {
                    uploadResult = await uploadFileToLitterboxNative(
                        event,
                        buffer,
                        fileName,
                        mimeType || "application/octet-stream",
                        uploaderSettings.litterboxTime || "1h",
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "temp.sh": {
                    uploadResult = await uploadFileToTempShNative(
                        event,
                        buffer,
                        fileName,
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "0x0.st": {
                    uploadResult = await uploadFileTo0x0StNative(
                        event,
                        buffer,
                        fileName,
                        uploaderSettings.zeroX0Expires,
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "tmpfiles.org": {
                    uploadResult = await uploadFileToTmpFilesNative(
                        event,
                        buffer,
                        fileName,
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "filebin.net": {
                    uploadResult = await uploadFileToFilebinNative(
                        event,
                        buffer,
                        fileName,
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "buzzheavier.com": {
                    uploadResult = await uploadFileToBuzzheavierNative(
                        event,
                        buffer,
                        fileName,
                        isBackgroundRetry ? undefined : uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                case "Custom": {
                    // Skip if custom uploader is not configured (for fallback chain)
                    if (!uploaderSettings.customUploaderRequestURL || uploaderSettings.customUploaderRequestURL.trim() === "") {
                        throw new Error("Custom uploader not configured - skipping to next uploader");
                    }
                    if (isBackgroundRetry) {
                        throw new Error("Custom uploader cannot be retried in background");
                    }
                    const customArgs = parseJsonSafe(uploaderSettings.customUploaderArgs, {});
                    const customHeaders = parseJsonSafe(uploaderSettings.customUploaderHeaders, {});
                    const urlPath = (uploaderSettings.customUploaderURL || "").split(".").filter(s => s);
                    uploadResult = await uploadFileCustomNative(
                        event,
                        uploaderSettings.customUploaderRequestURL,
                        buffer,
                        fileName,
                        mimeType || "application/octet-stream",
                        uploaderSettings.customUploaderFileFormName || "file",
                        customArgs,
                        customHeaders,
                        uploaderSettings.customUploaderResponseType || "Text",
                        urlPath,
                        uploadId,
                        uploaderSettings.customUploaderRequestMethod,
                        uploaderSettings.customUploaderBodyType,
                        uploaderSettings.uploadTimeout
                    );
                    break;
                }
                default:
                    throw new Error(`Unknown uploader: ${uploader}`);
            }

            // Validate URL
            if (!validateUploadUrl(uploadResult)) {
                throw new Error(`Invalid URL received from ${uploader}: ${uploadResult.substring(0, 100)}`);
            }

            return uploadResult;
        };

        // Track background retry promises: { uploader, promise }
        const backgroundRetries: Array<{ uploader: string; promise: Promise<{ url: string; uploader: string } | null> }> = [];

        let lastError: Error | null = null;
        const attemptedUploaders: string[] = [];

        // Try each uploader until one succeeds (with background retry racing)
        for (const uploader of uploadersToTry) {
            const attemptNumber = attemptedUploaders.length + 1;
            const totalAttempts = uploadersToTry.length;
            nativeLog.info(`[BigFileUpload] Trying uploader: ${uploader} (attempt ${attemptNumber}/${totalAttempts})`);

            // Show attempt info at info level
            if (attemptNumber === 1) {
                nativeLog.info(`[BigFileUpload] Starting upload to ${uploader}`);
            } else {
                nativeLog.info(`[BigFileUpload] Retrying with ${uploader} (attempt ${attemptNumber}/${totalAttempts})`);
            }

            // Check if any background retry has already succeeded before starting this attempt
            if (backgroundRetries.length > 0) {
                const backgroundWinner = await raceToFirstSuccess(backgroundRetries.map(r => r.promise));
                if (backgroundWinner) {
                    nativeLog.info(`[BigFileUpload] ✅ Background retry succeeded with ${backgroundWinner.uploader}!`);
                    let finalUrl = backgroundWinner.url;
                    if (uploaderSettings.autoFormat === "Yes") {
                        finalUrl = `[${fileName}](${backgroundWinner.url})`;
                    }
                    return {
                        success: true,
                        url: finalUrl,
                        fileName,
                        fileSize,
                        uploadId,
                        actualUploader: backgroundWinner.uploader,
                        attemptedUploaders: [...attemptedUploaders, backgroundWinner.uploader]
                    };
                }
            }

            try {
                nativeLog.debug(`[BigFileUpload NATIVE] Trying ${uploader}`);
                const uploadResult = await tryUploader(uploader, false);

                // Format URL if requested
                let finalUrl = uploadResult;
                if (uploaderSettings.autoFormat === "Yes") {
                    finalUrl = `[${fileName}](${uploadResult})`;
                }

                // Keep progress for completion message - renderer will clear it via completeUpload()
                nativeLog.info(`[BigFileUpload] ✅ Upload successful with ${uploader}! File: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB) → ${uploadResult}`);

                return {
                    success: true,
                    url: finalUrl,
                    fileName,
                    fileSize,
                    uploadId,
                    actualUploader: uploader,
                    attemptedUploaders: [...attemptedUploaders, uploader]
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);

                // Stop retrying if user cancelled - check BEFORE logging/notifying
                if (errorMessage.toLowerCase().includes("upload cancelled by user")) {
                    nativeLog.info("[BigFileUpload] Upload cancelled by user, aborting retries");
                    clearProgress();
                    return {
                        success: false,
                        error: "Upload cancelled by user",
                        attemptedUploaders
                    };
                }

                nativeLog.error(`[BigFileUpload] Upload failed with ${uploader}:`, error);
                lastError = new Error(`[${uploader}] ${errorMessage}`);
                attemptedUploaders.push(uploader);

                nativeLog.debug(`[BigFileUpload] Error details for ${uploader}: ${errorMessage}`);

                let shortError = errorMessage;
                if (errorMessage.length > 100) {
                    shortError = errorMessage.substring(0, 100) + "...";
                }

                // Notify user of failure (include error details so user can see what went wrong)
                const isLastUploader = attemptedUploaders.length >= uploadersToTry.length;
                if (event.sender && !event.sender.isDestroyed()) {
                    if (isLastUploader) {
                        sendNotification(event, {
                            type: "failure",
                            message: `${uploader} failed: ${shortError}`
                        });
                    } else {
                        const nextUploader = uploadersToTry[attemptedUploaders.length];
                        sendNotification(event, {
                            type: "failure",
                            message: `${uploader} failed: ${shortError}. Trying ${nextUploader}...`
                        });
                    }
                }

                // Start background retry for this failed uploader (only once, not for Custom)
                if (uploader !== "Custom" && !backgroundRetries.some(r => r.uploader === uploader)) {
                    nativeLog.info(`[BigFileUpload] Starting background retry for ${uploader}`);
                    const retryPromise = (async (): Promise<{ url: string; uploader: string } | null> => {
                        // Small delay to let the next primary uploader get a head start
                        await new Promise(r => setTimeout(r, 1000));
                        try {
                            const url = await tryUploader(uploader, true);
                            nativeLog.info(`[BigFileUpload] Background retry succeeded for ${uploader}`);
                            return { url, uploader };
                        } catch (retryError) {
                            nativeLog.debug(`[BigFileUpload] Background retry failed for ${uploader}:`, retryError);
                            return null;
                        }
                    })();
                    backgroundRetries.push({ uploader, promise: retryPromise });
                }

                // Reset progress for next attempt
                if (!isLastUploader) {
                    const nextUploader = uploadersToTry[attemptedUploaders.length];
                    nativeLog.warn(`[BigFileUpload] ${uploader} failed. Trying ${nextUploader}...`);

                    if (latestProgress && latestProgress.uploadId === uploadId) {
                        latestProgress = {
                            ...latestProgress,
                            loaded: 0,
                            percent: 0,
                            speed: 0,
                            eta: 0
                        };
                        latestProgressTimestamp = Date.now();
                    }
                }

                // Log specific error types
                if (errorMessage.toLowerCase().includes("read") && errorMessage.toLowerCase().includes("image")) {
                    nativeLog.error(`[BigFileUpload] IMAGE READ ERROR from ${uploader}: ${errorMessage}`);
                } else if (errorMessage.includes("412") || errorMessage.includes("415") ||
                    errorMessage.includes("Bad file type") || errorMessage.includes("Unsupported Media Type")) {
                    nativeLog.warn(`[BigFileUpload] File type rejected by ${uploader}`);
                } else if (errorMessage.includes("File not found") || errorMessage.includes("empty") || errorMessage.includes("not readable")) {
                    nativeLog.error(`[BigFileUpload] FILE ACCESS ERROR: ${errorMessage}`);
                }

                // If this was the last uploader, check background retries one more time before giving up
                if (isLastUploader) {
                    nativeLog.info("[BigFileUpload] All primary uploaders exhausted, waiting for background retries...");
                    // Give background retries a chance to finish (up to 30 seconds)
                    const finalCheck = await Promise.race([
                        raceToFirstSuccess(backgroundRetries.map(r => r.promise)),
                        new Promise<null>(r => setTimeout(() => r(null), 30000))
                    ]);
                    if (finalCheck) {
                        nativeLog.info(`[BigFileUpload] ✅ Background retry saved the day with ${finalCheck.uploader}!`);
                        let finalUrl = finalCheck.url;
                        if (uploaderSettings.autoFormat === "Yes") {
                            finalUrl = `[${fileName}](${finalCheck.url})`;
                        }
                        return {
                            success: true,
                            url: finalUrl,
                            fileName,
                            fileSize,
                            uploadId,
                            actualUploader: finalCheck.uploader,
                            attemptedUploaders: [...attemptedUploaders, finalCheck.uploader]
                        };
                    }
                    nativeLog.warn("[BigFileUpload] No more uploaders to try and no background retries succeeded");
                    break;
                }
            }
        }

        // All uploaders failed
        nativeLog.error(`[BigFileUpload] All uploaders failed. Attempted: ${attemptedUploaders.join(", ")}`);
        clearProgress(); // Only clear on final failure

        return {
            success: false,
            error: `All upload services failed. Last error: ${lastError?.message || "Connection issue"}. Tried: ${attemptedUploaders.join(", ")}`
        };

    } catch (outerError) {
        // Catch any errors that happen outside the upload loop
        // This ensures we always return a proper result object
        nativeLog.error("[BigFileUpload] Unexpected error in uploadFileBuffer:", outerError);
        clearProgress();
        return {
            success: false,
            error: `Unexpected error: ${outerError instanceof Error ? outerError.message : String(outerError)}. Please try again.`
        };
    }
}

/**
 * SECURE: Pick file and upload entirely in main process
 * Follows security pattern: renderer has ZERO file access
 * User selects file via OS dialog, file is uploaded, only URL is returned to renderer
 */
export async function pickAndUploadFile(
    event: Electron.IpcMainInvokeEvent,
    uploaderSettings: {
        fileUploader: string;
        gofileToken?: string;
        catboxUserHash?: string;
        litterboxTime?: string;
        zeroX0Expires?: string;
        autoFormat?: string;
        customUploaderRequestURL?: string;
        customUploaderFileFormName?: string;
        customUploaderResponseType?: string;
        customUploaderURL?: string;
        customUploaderArgs?: string;
        customUploaderHeaders?: string;
        customUploaderRequestMethod?: string;
        customUploaderBodyType?: string;
        loggingLevel?: LoggingLevel;
        respectNitroLimit?: boolean;
        nitroTier?: string;
        uploadTimeout?: number;
    }
): Promise<{ success: boolean; url?: string; fileName?: string; fileSize?: number; uploadId?: string; error?: string; actualUploader?: string; attemptedUploaders?: string[]; useNativeUpload?: boolean; buffer?: ArrayBuffer; }> {
    updateLoggingLevel(uploaderSettings.loggingLevel);
    // Step 1: Show OS file picker dialog (user explicitly selects file)
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
        title: "Select file to upload",
        properties: ["openFile", "dontAddToRecent"]
    };

    const { canceled, filePaths } = browserWindow
        ? await dialog.showOpenDialog(browserWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (canceled || filePaths.length === 0) {
        return { success: false, error: "File selection cancelled" };
    }

    const filePath = filePaths[0];
    const fileName = path.basename(filePath);
    const stats = await fs.promises.stat(filePath);
    const fileSize = stats.size;

    // Check if file is under Nitro limit - if so, return early for Discord native upload
    if (uploaderSettings.respectNitroLimit) {
        const nitroLimit = NITRO_LIMITS[uploaderSettings.nitroTier || "none"] || NITRO_LIMITS.none;
        if (fileSize <= nitroLimit) {
            nativeLog.info(`[BigFileUpload] File under Nitro limit (${(fileSize / 1024 / 1024).toFixed(1)}MB <= ${(nitroLimit / 1024 / 1024).toFixed(0)}MB), using Discord native upload`);
            // Read file into buffer for renderer to pass to Discord's UploadManager
            const fileBuffer = await fs.promises.readFile(filePath);
            return {
                success: true,
                useNativeUpload: true,
                fileName,
                fileSize,
                buffer: fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength) as ArrayBuffer
            };
        }
    }

    nativeLog.info(`[BigFileUpload] Securely uploading: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);
    nativeLog.debug(`[BigFileUpload] File path (main process only): ${filePath}`);

    // Define fallback uploaders in order based on user's preference
    // Order: Catbox, Litterbox, 0x0.st, tmpfiles.org, GoFile, buzzheavier, temp.sh, filebin.net
    const FALLBACK_UPLOADERS = [
        "Catbox",
        "Litterbox",
        "0x0.st",
        "tmpfiles.org",
        "GoFile",
        "buzzheavier.com",
        "temp.sh",
        "filebin.net"
    ];

    // Start with the selected uploader, with EXE file handling
    const selectedUploader = uploaderSettings.fileUploader || "Catbox";
    const primaryUploader = getEffectiveUploader(fileName, selectedUploader);

    // Build the list of uploaders to try (primary + fallbacks)
    // Skip EXE-blocked uploaders for EXE files
    const isExe = isExeFile(fileName);
    const uploadersToTry = [primaryUploader];
    for (const fallback of FALLBACK_UPLOADERS) {
        if (fallback !== primaryUploader && fallback !== "Custom" && !(isExe && EXE_BLOCKED_UPLOADERS.includes(fallback))) {
            uploadersToTry.push(fallback);
        }
    }

    nativeLog.info(`[BigFileUpload] Will try uploaders in order: ${uploadersToTry.join(", ")}`);

    const uploadId = `upload-${crypto.randomUUID()}`;

    // Clean up this ID from cancelled set if it exists (shouldn't happen but be safe)
    cancelledUploads.delete(uploadId);

    // Initialize progress tracking so the progress bar shows immediately
    latestProgress = {
        uploadId,
        fileName,
        fileSize,
        loaded: 0,
        total: fileSize,
        percent: 0,
        speed: 0,
        eta: 0
    };
    latestProgressTimestamp = Date.now();

    let lastError: Error | null = null;
    const attemptedUploaders: string[] = [];

    // Try each uploader until one succeeds
    for (const uploader of uploadersToTry) {
        const attemptNumber = attemptedUploaders.length + 1;
        const totalAttempts = uploadersToTry.length;
        nativeLog.info(`[BigFileUpload] Trying uploader: ${uploader} (attempt ${attemptNumber}/${totalAttempts})`);

        // Show attempt info at info level
        if (attemptNumber === 1) {
            nativeLog.info(`[BigFileUpload] Starting upload to ${uploader}`);
        } else {
            nativeLog.info(`[BigFileUpload] Retrying with ${uploader} (attempt ${attemptNumber}/${totalAttempts})`);
        }

        try {
            let uploadResult: string;

            switch (uploader) {
                case "GoFile": {
                    nativeLog.debug("[BigFileUpload] Trying GoFile");
                    const gofileResult = await uploadFileToGofileNative(
                        event,
                        filePath,
                        fileName,
                        uploaderSettings.gofileToken,
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );

                    if (gofileResult.status === "ok" && gofileResult.data) {
                        // New API returns downloadPage, or we construct from code
                        const downloadUrl = gofileResult.data.downloadPage || (gofileResult.data.code ? `https://gofile.io/d/${gofileResult.data.code}` : undefined);
                        if (!downloadUrl) {
                            throw new Error(`GoFile response missing download URL: ${JSON.stringify(gofileResult)}`);
                        }
                        uploadResult = downloadUrl;
                    } else {
                        throw new Error(`GoFile upload failed: ${gofileResult.error || JSON.stringify(gofileResult)}`);
                    }
                    break;
                }

                case "Catbox": {
                    nativeLog.debug("[BigFileUpload] Trying Catbox");
                    const catboxResult = await uploadFileToCatboxNative(
                        event,
                        "https://catbox.moe/user/api.php",
                        filePath,
                        fileName,
                        "",
                        uploaderSettings.catboxUserHash || "",
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = catboxResult;
                    break;
                }

                case "Litterbox": {
                    nativeLog.debug("[BigFileUpload] Trying Litterbox");
                    const litterboxResult = await uploadFileToLitterboxNative(
                        event,
                        filePath,
                        fileName,
                        "",
                        uploaderSettings.litterboxTime || "1h",
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = litterboxResult;
                    break;
                }

                case "temp.sh": {
                    nativeLog.debug("[BigFileUpload] Trying temp.sh");
                    const tempShResult = await uploadFileToTempShNative(
                        event,
                        filePath,
                        fileName,
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = tempShResult;
                    break;
                }

                case "0x0.st": {
                    nativeLog.debug("[BigFileUpload] Trying 0x0.st");
                    const zeroX0StResult = await uploadFileTo0x0StNative(
                        event,
                        filePath,
                        fileName,
                        uploaderSettings.zeroX0Expires,
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = zeroX0StResult;
                    break;
                }

                case "tmpfiles.org": {
                    nativeLog.debug("[BigFileUpload] Trying tmpfiles.org");
                    const tmpFilesResult = await uploadFileToTmpFilesNative(
                        event,
                        filePath,
                        fileName,
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = tmpFilesResult;
                    break;
                }

                case "filebin.net": {
                    nativeLog.debug("[BigFileUpload] Trying filebin.net");
                    const filebinResult = await uploadFileToFilebinNative(
                        event,
                        filePath,
                        fileName,
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = filebinResult;
                    break;
                }

                case "buzzheavier.com": {
                    nativeLog.debug("[BigFileUpload] Trying buzzheavier.com");
                    const buzzheavierResult = await uploadFileToBuzzheavierNative(
                        event,
                        filePath,
                        fileName,
                        uploadId,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = buzzheavierResult;
                    break;
                }

                case "Custom": {
                    // Skip if custom uploader is not configured (for fallback chain)
                    if (!uploaderSettings.customUploaderRequestURL || uploaderSettings.customUploaderRequestURL.trim() === "") {
                        throw new Error("Custom uploader not configured - skipping to next uploader");
                    }
                    // Skip custom uploader in fallback attempts (it's user-specific)
                    if (uploader !== primaryUploader) {
                        throw new Error("Custom uploader only works as primary selection");
                    }

                    const customArgs = parseJsonSafe(uploaderSettings.customUploaderArgs, {});
                    const customHeaders = parseJsonSafe(uploaderSettings.customUploaderHeaders, {});
                    const urlPath = (uploaderSettings.customUploaderURL || "").split(".").filter(s => s);

                    const customResult = await uploadFileCustomNative(
                        event,
                        uploaderSettings.customUploaderRequestURL,
                        filePath,
                        fileName,
                        "",
                        uploaderSettings.customUploaderFileFormName || "file",
                        customArgs,
                        customHeaders,
                        uploaderSettings.customUploaderResponseType || "Text",
                        urlPath,
                        uploadId,
                        uploaderSettings.customUploaderRequestMethod,
                        uploaderSettings.customUploaderBodyType,
                        uploaderSettings.uploadTimeout
                    );
                    uploadResult = customResult;
                    break;
                }

                default:
                    throw new Error(`Unknown uploader: ${uploader}`);
            }

            // If we got here, the upload succeeded!
            // Validate the URL before returning to user
            if (!validateUploadUrl(uploadResult)) {
                throw new Error(`Invalid URL received from ${uploader}: ${uploadResult.substring(0, 100)}`);
            }

            // Format URL if requested
            let finalUrl = uploadResult;
            if (uploaderSettings.autoFormat === "Yes") {
                finalUrl = `[${fileName}](${uploadResult})`;
            }

            // Return success result
            nativeLog.info(`[BigFileUpload] ✅ Upload successful with ${uploader}! File: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB) → ${uploadResult}`);

            return {
                success: true,
                url: finalUrl,
                fileName,
                fileSize,
                uploadId, // Return uploadId so renderer can complete the progress tracking
                actualUploader: uploader, // Return which uploader actually succeeded
                attemptedUploaders: [...attemptedUploaders, uploader] // List of all uploaders tried
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // Stop immediately if user cancelled - no error notification needed
            if (errorMessage.toLowerCase().includes("upload cancelled by user")) {
                nativeLog.info("[BigFileUpload] Upload cancelled by user, aborting");
                if (latestProgress && latestProgress.uploadId === uploadId) {
                    latestProgress = undefined;
                    latestProgressTimestamp = 0;
                }
                return {
                    success: false,
                    error: "Upload cancelled by user",
                    attemptedUploaders
                };
            }

            nativeLog.error(`[BigFileUpload] Upload failed with ${uploader}:`, error);

            // Create detailed error with service name included
            lastError = new Error(`[${uploader}] ${errorMessage}`);
            attemptedUploaders.push(uploader);

            // Get a short, user-friendly error message
            let shortError = errorMessage;
            if (errorMessage.length > 100) {
                shortError = errorMessage.substring(0, 100) + "...";
            }

            // Notify user of failure and whether we'll retry (include error details)
            const isLastUploader = attemptedUploaders.length === uploadersToTry.length - 1;
            if (event.sender && !event.sender.isDestroyed()) {
                if (isLastUploader) {
                    sendNotification(event, {
                        type: "failure",
                        message: `${uploader} failed: ${shortError}`
                    });
                } else {
                    const nextUploader = uploadersToTry[attemptedUploaders.length];
                    sendNotification(event, {
                        type: "failure",
                        message: `${uploader} failed: ${shortError}. Trying ${nextUploader}...`
                    });
                }
            }

            // If this was the last uploader to try, break and report failure
            if (uploader === uploadersToTry[uploadersToTry.length - 1]) {
                break;
            }

            // Otherwise, continue to the next uploader (notification already sent above)
            const nextUploader = uploadersToTry[attemptedUploaders.length];
            nativeLog.warn(`[BigFileUpload] ${uploader} failed. Will retry with ${nextUploader}`);
            console.warn(`[BigFileUpload] Upload failed with ${uploader}, retrying with ${nextUploader}...`);

            // Reset progress to 0 since we're starting over with a new service
            if (latestProgress && latestProgress.uploadId === uploadId) {
                latestProgress = {
                    ...latestProgress,
                    loaded: 0,
                    percent: 0,
                    speed: 0,
                    eta: 0
                };
                latestProgressTimestamp = Date.now();
            }
        }
    }

    // All uploaders failed
    nativeLog.error(`[BigFileUpload] All uploaders failed. Attempted: ${attemptedUploaders.join(", ")}`);
    clearProgress(); // Only clear on final failure

    return {
        success: false,
        error: `All upload services failed. Last error: ${lastError?.message || "Connection issue"}. Tried: ${attemptedUploaders.join(", ")}`
    };
}

// Store the latest progress update (set directly in streamFileUpload)
let latestProgress: any = null;
let latestProgressTimestamp: number = 0;

// Auto-clear stale progress after this many ms of no updates (5 minutes)
const STALE_PROGRESS_TIMEOUT = 5 * 60 * 1000;

// Store active HTTP requests for cancellation
const activeRequests = new Map<string, { req: any; cleanup: () => void; }>();

// Track cancelled uploads to prevent progress updates after cancellation
const cancelledUploads = new Set<string>();

// Store pending notifications for renderer to poll
const pendingNotifications: Array<{ type: string; message: string; timestamp: number; }> = [];
const MAX_NOTIFICATIONS = 50; // Keep last 50 notifications

/**
 * Queue notification for renderer to poll
 */
function sendNotification(_event: Electron.IpcMainInvokeEvent | null, notification: { type: string; message: string; }): void {
    // Add timestamp and store notification for polling
    const timestampedNotification = {
        ...notification,
        timestamp: Date.now()
    };

    pendingNotifications.push(timestampedNotification);

    // Keep array size manageable
    if (pendingNotifications.length > MAX_NOTIFICATIONS) {
        pendingNotifications.shift();
    }

    nativeLog.debug("[BigFileUpload] Notification queued:", notification);
}

/**
 * Get pending notifications (polled by renderer)
 */
export function getPendingNotifications(): Array<{ type: string; message: string; timestamp: number; }> {
    // Return all pending notifications
    const notifications = [...pendingNotifications];
    // Clear the queue after reading
    pendingNotifications.length = 0;
    return notifications;
}

/**
 * Get the latest progress update (polled by renderer)
 */
export function getLatestProgress(): any {
    // Don't return progress for cancelled uploads
    if (latestProgress && latestProgress.uploadId && cancelledUploads.has(latestProgress.uploadId)) {
        latestProgress = null;
        latestProgressTimestamp = 0;
        return null;
    }

    // Auto-clear stale progress data (no updates for 5 minutes = probably stuck/orphaned)
    if (latestProgress && latestProgressTimestamp > 0) {
        const age = Date.now() - latestProgressTimestamp;
        if (age > STALE_PROGRESS_TIMEOUT) {
            nativeLog.warn(`[BigFileUpload] Clearing stale progress data (${Math.round(age / 1000)}s old)`);
            latestProgress = null;
            latestProgressTimestamp = 0;
            return null;
        }
    }

    if (latestProgress) {
        nativeLog.debug("[NATIVE] getLatestProgress returning:", latestProgress.percent + "%");
    }
    return latestProgress;
}

/**
 * Clear the current progress (called when upload completes)
 */
export function clearProgress(): void {
    latestProgress = null;
    latestProgressTimestamp = 0;
}

/**
 * Cancel an active upload by upload ID
 */
export function cancelUpload(_event: Electron.IpcMainInvokeEvent, uploadId: string): { success: boolean; error?: string; } {
    nativeLog.info(`[BigFileUpload] Cancelling upload: ${uploadId}`);

    // Mark upload as cancelled to prevent any further progress updates
    cancelledUploads.add(uploadId);

    // Clean up from cancelled set after a delay to prevent memory leak
    setTimeout(() => {
        cancelledUploads.delete(uploadId);
        nativeLog.debug(`[BigFileUpload] Cleaned up cancelled upload ID: ${uploadId}`);
    }, 30000); // Clean up after 30 seconds

    // Immediately clear progress if it matches this upload
    if (latestProgress && latestProgress.uploadId === uploadId) {
        latestProgress = null;
    }

    const activeUpload = activeRequests.get(uploadId);
    if (activeUpload) {
        try {
            // Run cleanup first (which marks as cancelled and destroys streams)
            activeUpload.cleanup();

            // Additionally try to forcefully destroy socket and request
            try {
                if (activeUpload.req.socket) {
                    activeUpload.req.socket.destroy();
                }
                activeUpload.req.destroy();
            } catch (e) {
                // Ignore errors
            }

            // Remove from active requests
            activeRequests.delete(uploadId);
            nativeLog.info(`[BigFileUpload] Upload ${uploadId} cancelled successfully`);
            return { success: true };
        } catch (error) {
            nativeLog.error(`[BigFileUpload] Error cancelling upload ${uploadId}:`, error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    } else {
        // Even if no active upload, ensure it's marked as cancelled to prevent zombie progress
        nativeLog.warn(`[BigFileUpload] No active upload found for ID: ${uploadId}, but marked as cancelled`);
        return { success: true }; // Still return success since we've marked it as cancelled
    }
}
