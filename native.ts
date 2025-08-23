/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * GoFile upload
 */
export async function uploadFileToGofileNative(_, url: string, fileBuffer: ArrayBuffer, fileName: string, fileType: string, token?: string): Promise<string> {
    try {
        console.log(`[GoFile] Starting upload of ${fileName} (${fileBuffer.byteLength} bytes)`);

        const formData = new FormData();
        const file = new Blob([fileBuffer], { type: fileType });
        formData.append("file", new File([file], fileName));

        if (token) {
            formData.append("token", token);
        }

        const response = await fetch(url, {
            method: "POST",
            body: formData,
        });

        const result = await response.json();
        console.log("[GoFile] Upload completed successfully");
        return result;
    } catch (error) {
        console.error("Error during GoFile upload:", error);
        throw error;
    }
}

/**
 * Catbox upload
 */
export async function uploadFileToCatboxNative(_, url: string, fileBuffer: ArrayBuffer, fileName: string, fileType: string, userHash: string): Promise<string> {
    try {
        console.log(`[Catbox] Starting upload of ${fileName} (${fileBuffer.byteLength} bytes)`);

        const formData = new FormData();
        formData.append("reqtype", "fileupload");

        const file = new Blob([fileBuffer], { type: fileType });
        formData.append("fileToUpload", new File([file], fileName));
        formData.append("userhash", userHash);

        const response = await fetch(url, {
            method: "POST",
            body: formData,
        });

        const result = await response.text();
        console.log("[Catbox] Upload completed successfully");
        return result;
    } catch (error) {
        console.error("Error during Catbox upload:", error);
        throw error;
    }
}

/**
 * Litterbox upload
 */
export async function uploadFileToLitterboxNative(_, fileBuffer: ArrayBuffer, fileName: string, fileType: string, time: string): Promise<string> {
    try {
        console.log(`[Litterbox] Starting upload of ${fileName} (${fileBuffer.byteLength} bytes)`);

        const formData = new FormData();
        formData.append("reqtype", "fileupload");

        const file = new Blob([fileBuffer], { type: fileType });
        formData.append("fileToUpload", new File([file], fileName));
        formData.append("time", time);

        const response = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
            method: "POST",
            body: formData,
        });

        const result = await response.text();
        console.log("[Litterbox] Upload completed successfully");
        return result;
    } catch (error) {
        console.error("Error during Litterbox upload:", error);
        throw error;
    }
}

/**
 * Custom upload
 */
export async function uploadFileCustomNative(_, url: string, fileBuffer: ArrayBuffer, fileName: string, fileType: string, fileFormName: string, customArgs: Record<string, string>, customHeaders: Record<string, string>, responseType: string, urlPath: string[]): Promise<string> {
    try {
        console.log(`[Custom] Starting upload of ${fileName} (${fileBuffer.byteLength} bytes) to ${url}`);

        const formData = new FormData();
        const file = new Blob([fileBuffer], { type: fileType });
        formData.append(fileFormName, new File([file], fileName));

        // Filter out empty keys to prevent "Field name missing" error
        for (const [key, value] of Object.entries(customArgs)) {
            if (key && key.trim() !== "") {
                formData.append(key, value);
            }
        }

        // Prepare headers (remove Content-Type as FormData sets it automatically)
        const headers = { ...customHeaders };
        delete headers["Content-Type"];
        delete headers["content-type"];

        const uploadResponse = await fetch(url, {
            method: "POST",
            body: formData,
            headers: new Headers(headers)
        });

        if (!uploadResponse.ok) {
            throw new Error(`HTTP error! status: ${uploadResponse.status}, statusText: ${uploadResponse.statusText}`);
        }

        let uploadResult;
        if (responseType === "JSON") {
            uploadResult = await uploadResponse.json();
        } else {
            uploadResult = await uploadResponse.text();
        }

        let finalUrl = "";
        if (responseType === "JSON") {
            let current = uploadResult;
            for (const key of urlPath) {
                if (current[key] === undefined) {
                    throw new Error(`Invalid URL path: ${urlPath.join(".")}`);
                }
                current = current[key];
            }
            finalUrl = current;
        } else {
            finalUrl = uploadResult.trim();
        }

        console.log("[Custom] Upload completed successfully");
        return finalUrl;
    } catch (error) {
        console.error("Error during Custom upload:", error);
        throw error;
    }
}
