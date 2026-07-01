/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { useForceUpdater } from "@utils/react";
import { OptionType } from "@utils/types";
import { React, Select, showToast, TextArea, TextInput, Toasts } from "@webpack/common";

import { CORS_PROXY } from "./constants";
import { fallbackServiceOrder, serviceLabels, ServiceType } from "./types";
import { parseShareXConfig } from "./utils/sharex";

const defaultFallbackOrder = fallbackServiceOrder.join(",");
const cl = classNameFactory("vc-file-upload-settings-");

const serviceOptions = [
    // No account / API key required (work anonymously)
    { label: "Catbox.moe", value: ServiceType.CATBOX },
    { label: "Litterbox", value: ServiceType.LITTERBOX },
    ...(IS_DISCORD_DESKTOP ? [{ label: "0x0.st", value: ServiceType.ZEROX0 }] : []),
    { label: "tmpfiles.org", value: ServiceType.TMPFILES },
    { label: "GoFile", value: ServiceType.GOFILE },
    { label: "buzzheavier.com", value: ServiceType.BUZZHEAVIER },
    { label: "temp.sh", value: ServiceType.TEMPSH },
    { label: "filebin.net", value: ServiceType.FILEBIN },
    { label: "PixelDrain", value: ServiceType.PIXELDRAIN },
    // Require a token / API key / credentials
    { label: "Zipline", value: ServiceType.ZIPLINE, default: true },
    { label: "E-Z Host", value: ServiceType.EZHOST },
    { label: "Nest", value: ServiceType.NEST },
    { label: "Encrypting.host", value: ServiceType.ENCRYPTINGHOST },
    { label: "S3-Compatible", value: ServiceType.S3 },
    { label: "PixelVault", value: ServiceType.PIXELVAULT },
    { label: "WebDAV (Nextcloud/Owncloud)", value: ServiceType.WEBDAV },
    { label: "ShareX/Custom Uploader", value: ServiceType.SHAREX }
];

const litterboxOptions = [
    { label: "1 hour", value: "1h" },
    { label: "12 hours", value: "12h" },
    { label: "24 hours", value: "24h", default: true },
    { label: "72 hours", value: "72h" }
];

const embedProxyOptions = [
    { label: "CORS Proxy", value: "cors", default: true },
    { label: "discord.nfp.is", value: "nfp" }
];

const encryptingHostUrlStyleOptions = [
    { label: "Query", value: "query", default: true },
    { label: "Param", value: "param" },
    { label: "Fake Link", value: "fakelink" },
    { label: "Embed", value: "embed" }
];

export const settings = definePluginSettings({
    serviceType: {
        type: OptionType.SELECT,
        description: "Selected uploader service",
        options: serviceOptions,
        hidden: true
    },
    serviceUrl: {
        type: OptionType.STRING,
        description: "Zipline service URL",
        default: "",
        hidden: true
    },
    ziplineToken: {
        type: OptionType.STRING,
        description: "Zipline auth token",
        default: "",
        hidden: true
    },
    folderId: {
        type: OptionType.STRING,
        description: "Optional Zipline folder ID",
        default: "",
        hidden: true
    },
    ezHostKey: {
        type: OptionType.STRING,
        description: "E-Z Host API key",
        default: "",
        hidden: true
    },
    nestToken: {
        type: OptionType.STRING,
        description: "Nest API token",
        default: "",
        hidden: true
    },
    encryptingHostKey: {
        type: OptionType.STRING,
        description: "Encrypting.host API key",
        default: "",
        hidden: true
    },
    encryptingHostUrlStyle: {
        type: OptionType.SELECT,
        description: "Encrypting.host URL style",
        options: encryptingHostUrlStyleOptions,
        default: "query",
        hidden: true
    },
    encryptingHostDomains: {
        type: OptionType.STRING,
        description: "Encrypting.host domains JSON list",
        default: "[\"offensive\"]",
        hidden: true
    },
    encryptingHostTitle: {
        type: OptionType.STRING,
        description: "Optional Encrypting.host embed title",
        default: "",
        hidden: true
    },
    encryptingHostColor: {
        type: OptionType.STRING,
        description: "Optional Encrypting.host embed color",
        default: "",
        hidden: true
    },
    encryptingHostFakelink: {
        type: OptionType.STRING,
        description: "Optional Encrypting.host fake link",
        default: "",
        hidden: true
    },
    s3Endpoint: {
        type: OptionType.STRING,
        description: "S3-compatible endpoint URL",
        default: "",
        hidden: true
    },
    s3Bucket: {
        type: OptionType.STRING,
        description: "S3 bucket name",
        default: "",
        hidden: true
    },
    s3Region: {
        type: OptionType.STRING,
        description: "S3 region (use auto for R2)",
        default: "auto",
        hidden: true
    },
    s3AccessKeyId: {
        type: OptionType.STRING,
        description: "S3 access key ID",
        default: "",
        hidden: true
    },
    s3SecretAccessKey: {
        type: OptionType.STRING,
        description: "S3 secret access key",
        default: "",
        hidden: true
    },
    s3SessionToken: {
        type: OptionType.STRING,
        description: "Optional S3 session token",
        default: "",
        hidden: true
    },
    s3PublicUrl: {
        type: OptionType.STRING,
        description: "Optional public base URL",
        default: "",
        hidden: true
    },
    s3Prefix: {
        type: OptionType.STRING,
        description: "Optional S3 object key prefix",
        default: "",
        hidden: true
    },
    s3ForcePathStyle: {
        type: OptionType.BOOLEAN,
        description: "Use path-style S3 URLs",
        default: true,
        hidden: true
    },
    litterboxExpiry: {
        type: OptionType.SELECT,
        description: "Litterbox retention window",
        options: litterboxOptions,
        default: "24h",
        hidden: true
    },
    catboxUserhash: {
        type: OptionType.STRING,
        description: "Catbox userhash for account binding",
        default: "",
        hidden: true
    },
    sharexConfig: {
        type: OptionType.STRING,
        description: "ShareX/Custom uploader JSON",
        default: "",
        hidden: true
    },
    disableFallbacks: {
        type: OptionType.BOOLEAN,
        description: "Disable fallback upload services",
        default: false,
        hidden: true
    },
    autoSend: {
        type: OptionType.BOOLEAN,
        description: "Insert uploaded URL into chatbox",
        default: true,
        hidden: true
    },
    autoFormat: {
        type: OptionType.BOOLEAN,
        description: "Wrap inserted URL in angle brackets",
        default: false,
        hidden: true
    },
    displayOriginalFilename: {
        type: OptionType.BOOLEAN,
        description: "Insert the link as a clickable [filename](url) showing the original filename",
        default: false,
        hidden: true
    },
    bypassDiscordUpload: {
        type: OptionType.BOOLEAN,
        description: "Bypass Discord uploads and use BigFileUpload instead.",
        default: true,
        hidden: true
    },
    bypassDragDrop: {
        type: OptionType.BOOLEAN,
        description: "Use BigFileUpload when dragging & dropping files into chat.",
        default: true,
        hidden: true
    },
    bypassDiscordUploadOnlyOverLimit: {
        type: OptionType.BOOLEAN,
        description: "Only use BigFileUpload if the file(s) exceed the file size limit.",
        default: true,
        hidden: true
    },
    gofileToken: {
        type: OptionType.STRING,
        description: "Optional GoFile API token",
        default: "",
        hidden: true
    },
    fallbackOrder: {
        type: OptionType.STRING,
        description: "Fallback uploader order",
        default: defaultFallbackOrder,
        hidden: true
    },
    pixelVaultKey: {
        type: OptionType.STRING,
        description: "PixelVault upload key",
        default: "",
        hidden: true
    },
    pixelDrainKey: {
        type: OptionType.STRING,
        description: "Optional PixelDrain API key",
        default: "",
        hidden: true
    },
    uploadTimeoutMs: {
        type: OptionType.NUMBER,
        description: "Abort an upload if it makes no progress for this many milliseconds",
        default: 60000,
        hidden: true
    },
    stripQueryParams: {
        type: OptionType.BOOLEAN,
        description: "Strip query params from uploaded URLs",
        default: false,
        hidden: true
    },
    embedProxyEnabled: {
        type: OptionType.BOOLEAN,
        description: "Proxy uploaded video links through an embed helper service.",
        default: true,
        hidden: true
    },
    embedProxyService: {
        type: OptionType.SELECT,
        description: "Embed helper service to wrap uploaded video links.",
        options: embedProxyOptions,
        default: "cors",
        hidden: true
    },
    corsProxyUrl: {
        type: OptionType.STRING,
        description: "CORS proxy URL used for browser uploads",
        default: CORS_PROXY,
        hidden: true
    },
    disableCorsProxy: {
        type: OptionType.BOOLEAN,
        description: "Send web uploads directly instead of through a CORS proxy",
        default: false,
        hidden: true
    },
    sharexFormView: {
        type: OptionType.BOOLEAN,
        description: "Edit the custom uploader with individual fields instead of raw JSON",
        default: false,
        hidden: true
    },
    apngToGif: {
        type: OptionType.BOOLEAN,
        description: "Convert APNG uploads to GIF",
        default: false,
        hidden: true
    },
    preserveOriginalFilename: {
        type: OptionType.BOOLEAN,
        description: "Preserve the original filename when uploading.",
        default: true,
        hidden: true
    },
    autoCopy: {
        type: OptionType.BOOLEAN,
        description: "Auto copy upload URL",
        default: true,
        hidden: true
    },
    autoUploadPastedFiles: {
        type: OptionType.BOOLEAN,
        description: "Automatically upload files from clipboard to image host when pasting into chatbox.",
        default: true,
        hidden: true
    },
    webdavUrl: {
        type: OptionType.STRING,
        description: "WebDAV server URL",
        default: "",
        hidden: true
    },
    webdavUsername: {
        type: OptionType.STRING,
        description: "WebDAV username",
        default: "",
        hidden: true
    },
    webdavPassword: {
        type: OptionType.STRING,
        description: "WebDAV password or app token",
        default: "",
        hidden: true
    },
    webdavDirectory: {
        type: OptionType.STRING,
        description: "Optional subdirectory on the WebDAV server",
        default: "",
        hidden: true
    },
    webdavServerType: {
        type: OptionType.SELECT,
        description: "WebDAV server type",
        options: [
            { label: "Nextcloud", value: "nextcloud", default: true },
            { label: "ownCloud", value: "owncloud" },
            { label: "Generic WebDAV", value: "generic" }
        ],
        default: "nextcloud",
        hidden: true
    },
    webdavShareType: {
        type: OptionType.SELECT,
        description: "WebDAV share link format",
        options: [
            { label: "Share Page", value: "share-page", default: true },
            { label: "Direct Download", value: "direct-download" },
            { label: "Markdown Link", value: "markdown" }
        ],
        default: "share-page",
        hidden: true
    },
    uploadAllowedFileTypes: {
        type: OptionType.STRING,
        description: "Comma-separated list of allowed file extensions (e.g. png,jpg,gif,mp4). Leave empty to allow all files.",
        default: "",
        hidden: true
    },
    settingsComponent: {
        type: OptionType.COMPONENT,
        description: "Settings",
        component: SettingsComponent
    }
});

function SettingTextInput(props: {
    description: string;
    name: string;
    onChange: (value: string) => void;
    placeholder: string;
    value: string;
}) {
    const { description, name, onChange, placeholder, value } = props;

    return (
        <SettingsSection id={name} name={name} description={description ?? ""}>
            <TextInput
                value={value}
                onChange={onChange}
                placeholder={placeholder}
            />
        </SettingsSection>
    );
}

function SettingGroup(props: {
    children: React.ReactNode;
    description?: string;
    name: string;
}) {
    const { children, description, name } = props;

    return (
        <SettingsSection id={name} name={name} description={description ?? ""}>
            <div className={cl("group")}>
                {children}
            </div>
        </SettingsSection>
    );
}

function SettingSwitch(props: {
    checked: boolean;
    description: string;
    name: string;
    onChange: (value: boolean) => void;
}) {
    const { checked, description, name, onChange } = props;

    return (
        <SettingsSection id={name} tag="label" name={name} description={description} inlineSetting>
            <Switch checked={checked} onChange={onChange} />
        </SettingsSection>
    );
}

function ServicePicker(props: {
    onChange: (service: ServiceType) => void;
    value: ServiceType;
}) {
    const { onChange, value } = props;

    return (
        <div className={cl("service-grid")}>
            {serviceOptions.map(option => (
                <button
                    key={option.value}
                    type="button"
                    className={cl("service-option")}
                    data-selected={option.value === value}
                    onClick={() => onChange(option.value)}
                >
                    <span className={cl("service-option-label")}>{option.label}</span>
                </button>
            ))}
        </div>
    );
}

function FallbackOrderSettings() {
    const update = useForceUpdater();
    const { store } = settings;
    const [dragIndex, setDragIndex] = React.useState<number | null>(null);
    const [order, setOrder] = React.useState<ServiceType[]>(() => {
        const configured = (store.fallbackOrder || defaultFallbackOrder)
            .split(/[\n,]/)
            .map(entry => entry.trim())
            .filter((entry): entry is ServiceType => Object.values(ServiceType).includes(entry as ServiceType));

        return configured.length === fallbackServiceOrder.length && new Set(configured).size === fallbackServiceOrder.length
            ? configured
            : fallbackServiceOrder;
    });

    const commitOrder = (nextOrder: ServiceType[]) => {
        setOrder(nextOrder);
        store.fallbackOrder = nextOrder.join(",");
        update();
    };

    return (
        <SettingsSection id="fallback-order" name="Fallback Order" description="Drag hosts to reorder fallback attempts. The selected host is tried first, then this order is used.">
            <div className={cl("fallback-order-list")}>
                {order.map((service, index) => (
                    <div
                        key={service}
                        className={cl("fallback-order-item")}
                        draggable
                        onDragStart={event => {
                            setDragIndex(index);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", String(index));
                        }}
                        onDragOver={event => event.preventDefault()}
                        onDrop={event => {
                            event.preventDefault();
                            const sourceIndex = dragIndex ?? Number(event.dataTransfer.getData("text/plain"));
                            if (!Number.isInteger(sourceIndex) || sourceIndex === index || sourceIndex < 0 || sourceIndex >= order.length) {
                                setDragIndex(null);
                                return;
                            }

                            const nextOrder = [...order];
                            const [moved] = nextOrder.splice(sourceIndex, 1);
                            nextOrder.splice(index, 0, moved);
                            setDragIndex(null);
                            commitOrder(nextOrder);
                        }}
                        onDragEnd={() => setDragIndex(null)}
                        data-dragging={dragIndex === index}
                    >
                        <span className={cl("fallback-order-label")}>{serviceLabels[service]}</span>
                        <span className={cl("fallback-order-handle")}>Drag</span>
                    </div>
                ))}
            </div>
            <div className={cl("fallback-order-actions")}>
                <Button size="small" onClick={() => commitOrder(fallbackServiceOrder)}>
                    Reset to default
                </Button>
            </div>
        </SettingsSection>
    );
}

function readShareXConfigObject(raw?: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function ShareXFormFields(props: { store: { sharexConfig?: string; }; update: () => void; }) {
    const { store, update } = props;
    const config = readShareXConfigObject(store.sharexConfig);

    const setField = (key: string, value: string) => {
        const next = readShareXConfigObject(store.sharexConfig);
        if (value.trim() === "") delete next[key];
        else next[key] = value;
        store.sharexConfig = JSON.stringify(next, null, 2);
        update();
    };

    const method = String(config.RequestMethod || "POST");
    const body = String(config.Body || "MultipartFormData");
    const isMultipart = body === "MultipartFormData" || body === "FormData";

    const [headersText, setHeadersText] = React.useState(() => {
        const headers = config.Headers;
        return headers && typeof headers === "object" && Object.keys(headers).length
            ? JSON.stringify(headers, null, 2)
            : "";
    });
    const [headersInvalid, setHeadersInvalid] = React.useState(false);

    const [argsText, setArgsText] = React.useState(() => {
        const args = config.Arguments;
        return args && typeof args === "object" && Object.keys(args).length
            ? JSON.stringify(args, null, 2)
            : "";
    });
    const [argsInvalid, setArgsInvalid] = React.useState(false);

    const applyHeaders = (text: string) => {
        setHeadersText(text);
        const next = readShareXConfigObject(store.sharexConfig);

        if (text.trim() === "") {
            delete next.Headers;
            store.sharexConfig = JSON.stringify(next, null, 2);
            setHeadersInvalid(false);
            update();
            return;
        }

        try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            next.Headers = parsed;
            store.sharexConfig = JSON.stringify(next, null, 2);
            setHeadersInvalid(false);
            update();
        } catch {
            setHeadersInvalid(true);
        }
    };

    const applyArgs = (text: string) => {
        setArgsText(text);
        const next = readShareXConfigObject(store.sharexConfig);

        if (text.trim() === "") {
            delete next.Arguments;
            store.sharexConfig = JSON.stringify(next, null, 2);
            setArgsInvalid(false);
            update();
            return;
        }

        try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            next.Arguments = parsed;
            store.sharexConfig = JSON.stringify(next, null, 2);
            setArgsInvalid(false);
            update();
        } catch {
            setArgsInvalid(true);
        }
    };

    return (
        <>
            <SettingTextInput
                name="Request URL"
                description="The endpoint your file is sent to (required)."
                value={String(config.RequestURL || "")}
                onChange={v => setField("RequestURL", v)}
                placeholder="https://example.com/api/upload"
            />
            <SettingsSection id="sharex-form-method" name="HTTP Method" description="Most servers use POST. Use PUT/PATCH for raw upload APIs.">
                <Select
                    options={[
                        { label: "POST", value: "POST" },
                        { label: "PUT", value: "PUT" },
                        { label: "PATCH", value: "PATCH" }
                    ]}
                    isSelected={v => v === method}
                    select={v => setField("RequestMethod", v)}
                    serialize={v => v}
                    placeholder="Select method"
                />
            </SettingsSection>
            <SettingsSection id="sharex-form-body" name="Body Type" description="Binary sends the raw file in the request body. Multipart sends it as a form field. JSON sends the arguments as a JSON body.">
                <Select
                    options={[
                        { label: "Multipart Form Data", value: "MultipartFormData" },
                        { label: "Binary (raw file in body)", value: "Binary" },
                        { label: "JSON", value: "JSON" }
                    ]}
                    isSelected={v => v === body}
                    select={v => setField("Body", v)}
                    serialize={v => v}
                    placeholder="Select body type"
                />
            </SettingsSection>
            {isMultipart && (
                <SettingTextInput
                    name="File Form Field Name"
                    description="The form field name your server expects the file under (defaults to 'file')."
                    value={String(config.FileFormName || "")}
                    onChange={v => setField("FileFormName", v)}
                    placeholder="file"
                />
            )}
            <SettingsSection
                id="sharex-form-headers"
                name="Headers (JSON)"
                description={headersInvalid ? "⚠ Invalid JSON — header changes are not saved until valid." : "Optional request headers as a JSON object (e.g. an auth token)."}
            >
                <TextArea
                    value={headersText}
                    rows={3}
                    placeholder={"{ \"Authorization\": \"Bearer ...\" }"}
                    onChange={applyHeaders}
                />
            </SettingsSection>
            {body !== "Binary" && (
                <SettingsSection
                    id="sharex-form-arguments"
                    name="Arguments (JSON)"
                    description={argsInvalid ? "⚠ Invalid JSON — argument changes are not saved until valid." : "Optional extra fields sent with the upload — multipart form fields, or the JSON request body. As a JSON object."}
                >
                    <TextArea
                        value={argsText}
                        rows={3}
                        placeholder={"{ \"key\": \"value\" }"}
                        onChange={applyArgs}
                    />
                </SettingsSection>
            )}
            <SettingTextInput
                name="Response URL"
                description="How to read the link from the response. Leave empty for plain-text or {url} JSON responses; otherwise use a ShareX template like $json:url$."
                value={String(config.URL || "")}
                onChange={v => setField("URL", v)}
                placeholder="$json:url$"
            />
        </>
    );
}

export function SettingsComponent() {
    const update = useForceUpdater();
    const { store } = settings;
    const sharexFileInputRef = React.useRef<HTMLInputElement>(null);
    const isNest = store.serviceType === ServiceType.NEST;
    const isEzHost = store.serviceType === ServiceType.EZHOST;
    const isEncryptingHost = store.serviceType === ServiceType.ENCRYPTINGHOST;
    const isS3 = store.serviceType === ServiceType.S3;
    const isZipline = store.serviceType === ServiceType.ZIPLINE;
    const isCatbox = store.serviceType === ServiceType.CATBOX;
    const isLitterbox = store.serviceType === ServiceType.LITTERBOX;
    const isGofile = store.serviceType === ServiceType.GOFILE;
    const isPixelVault = store.serviceType === ServiceType.PIXELVAULT;
    const isPixelDrain = store.serviceType === ServiceType.PIXELDRAIN;
    const isShareX = store.serviceType === ServiceType.SHAREX;
    const isWebdav = store.serviceType === ServiceType.WEBDAV;

    const validateShareXConfig = () => {
        try {
            parseShareXConfig(store.sharexConfig || "");
            showToast("ShareX config is valid", Toasts.Type.SUCCESS);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid ShareX config";
            showToast(message, Toasts.Type.FAILURE);
        }
    };

    const triggerShareXFileUpload = () => {
        sharexFileInputRef.current?.click();
    };

    const handleShareXFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
            try {
                const content = String(e.target?.result || "");
                const parsed = parseShareXConfig(content);
                store.sharexConfig = JSON.stringify(parsed, null, 2);
                update();
                showToast("Imported ShareX config", Toasts.Type.SUCCESS);
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to import ShareX config";
                showToast(message, Toasts.Type.FAILURE);
            }
        };
        reader.readAsText(file);
        event.target.value = "";
    };

    return (
        <>
            <SettingsSection id="upload-service" name="Upload Service" description="Choose where BigFileUpload sends new files.">
                <ServicePicker
                    value={store.serviceType as ServiceType}
                    onChange={service => {
                        store.serviceType = service;
                        update();
                    }}
                />
                <SettingSwitch
                    name="Disable Fallback Uploaders"
                    description="Only use the selected uploader without trying fallback hosts."
                    checked={store.disableFallbacks}
                    onChange={v => store.disableFallbacks = v}
                />
            </SettingsSection>

            {isZipline && (
                <SettingGroup name="Zipline" description="Connection details for your Zipline instance.">
                    <SettingTextInput
                        name="Service URL"
                        description="The URL of your Zipline instance"
                        value={store.serviceUrl}
                        onChange={v => store.serviceUrl = v}
                        placeholder="https://your-zipline-instance.com"
                    />
                    <SettingTextInput
                        name="Zipline Token"
                        description="Your Zipline API authorization token"
                        value={store.ziplineToken}
                        onChange={v => store.ziplineToken = v}
                        placeholder="Your Zipline API token"
                    />
                    <SettingTextInput
                        name="Folder ID"
                        description="Folder ID for uploads (leave empty for no folder)"
                        value={store.folderId}
                        onChange={v => store.folderId = v}
                        placeholder="Leave empty for no folder"
                    />
                </SettingGroup>
            )}

            {isEzHost && (
                <SettingGroup name="E-Z Host" description="Connection details for E-Z Host uploads.">
                    <SettingTextInput
                        name="E-Z Host API Key"
                        description="Your E-Z Host API key"
                        value={store.ezHostKey}
                        onChange={v => store.ezHostKey = v}
                        placeholder="Your E-Z Host API key"
                    />
                </SettingGroup>
            )}

            {isNest && (
                <SettingGroup name="Nest" description="Connection details for Nest uploads.">
                    <SettingTextInput
                        name="Nest Token"
                        description="Your Nest API authorization token"
                        value={store.nestToken}
                        onChange={v => store.nestToken = v}
                        placeholder="Your Nest API token"
                    />
                </SettingGroup>
            )}

            {isEncryptingHost && (
                <SettingGroup name="Encrypting.host" description="Connection details for Encrypting.host uploads.">
                    <SettingTextInput
                        name="Encrypting.host API Key"
                        description="Your Encrypting.host API key"
                        value={(store as { encryptingHostKey?: string; }).encryptingHostKey || ""}
                        onChange={v => (store as { encryptingHostKey?: string; }).encryptingHostKey = v}
                        placeholder="Your Encrypting.host API key"
                    />
                    <SettingsSection id="url-style" name="URL Style" description="How Encrypting.host should format returned links.">
                        <Select
                            options={encryptingHostUrlStyleOptions}
                            isSelected={v => v === (store as { encryptingHostUrlStyle?: string; }).encryptingHostUrlStyle}
                            select={v => {
                                (store as { encryptingHostUrlStyle?: string; }).encryptingHostUrlStyle = v;
                                update();
                            }}
                            serialize={v => v}
                            placeholder="Select URL style"
                        />
                    </SettingsSection>
                    <SettingsSection id="domains-json" name="Domains JSON" description={"JSON array of domains to use, for example [\"offensive\"]."}>
                        <TextArea
                            value={(store as { encryptingHostDomains?: string; }).encryptingHostDomains || ""}
                            rows={3}
                            placeholder='["offensive"]'
                            onChange={v => (store as { encryptingHostDomains?: string; }).encryptingHostDomains = v}
                        />
                    </SettingsSection>
                    <SettingTextInput
                        name="Embed Title"
                        description="Optional title for embed style responses."
                        value={(store as { encryptingHostTitle?: string; }).encryptingHostTitle || ""}
                        onChange={v => (store as { encryptingHostTitle?: string; }).encryptingHostTitle = v}
                        placeholder="Optional title"
                    />
                    <SettingTextInput
                        name="Embed Color"
                        description="Optional color for embed style responses."
                        value={(store as { encryptingHostColor?: string; }).encryptingHostColor || ""}
                        onChange={v => (store as { encryptingHostColor?: string; }).encryptingHostColor = v}
                        placeholder="Optional color"
                    />
                    <SettingTextInput
                        name="Fake Link"
                        description="Optional fake link value for fakelink style responses."
                        value={(store as { encryptingHostFakelink?: string; }).encryptingHostFakelink || ""}
                        onChange={v => (store as { encryptingHostFakelink?: string; }).encryptingHostFakelink = v}
                        placeholder="Optional fake link"
                    />
                </SettingGroup>
            )}

            {isS3 && (
                <SettingGroup name="S3-Compatible Storage" description="Connection details and object naming for your bucket.">
                    <SettingTextInput
                        name="S3 Endpoint URL"
                        description="S3-compatible endpoint (e.g. https://<accountid>.r2.cloudflarestorage.com)"
                        value={store.s3Endpoint}
                        onChange={v => store.s3Endpoint = v}
                        placeholder="https://your-endpoint.example.com"
                    />
                    <SettingTextInput
                        name="Bucket Name"
                        description="Bucket to upload into"
                        value={store.s3Bucket}
                        onChange={v => store.s3Bucket = v}
                        placeholder="my-bucket"
                    />
                    <SettingTextInput
                        name="Region"
                        description="AWS region or auto for Cloudflare R2"
                        value={store.s3Region}
                        onChange={v => store.s3Region = v}
                        placeholder="auto"
                    />
                    <SettingTextInput
                        name="Access Key ID"
                        description="S3-compatible access key"
                        value={store.s3AccessKeyId}
                        onChange={v => store.s3AccessKeyId = v}
                        placeholder="Your access key ID"
                    />
                    <SettingTextInput
                        name="Secret Access Key"
                        description="S3-compatible secret key"
                        value={store.s3SecretAccessKey}
                        onChange={v => store.s3SecretAccessKey = v}
                        placeholder="Your secret access key"
                    />
                    <SettingTextInput
                        name="Session Token"
                        description="Optional temporary credential token"
                        value={store.s3SessionToken}
                        onChange={v => store.s3SessionToken = v}
                        placeholder="Optional session token"
                    />
                    <SettingTextInput
                        name="Public Base URL"
                        description="Optional public URL base to use for returned links"
                        value={store.s3PublicUrl}
                        onChange={v => store.s3PublicUrl = v}
                        placeholder="https://cdn.example.com"
                    />
                    <SettingTextInput
                        name="Object Key Prefix"
                        description="Optional folder/prefix inside the bucket"
                        value={store.s3Prefix}
                        onChange={v => store.s3Prefix = v}
                        placeholder="uploads/discord"
                    />
                    <SettingSwitch
                        name="Use Path-Style Endpoint"
                        description="Use endpoint/bucket/key format, recommended for R2."
                        checked={store.s3ForcePathStyle}
                        onChange={v => store.s3ForcePathStyle = v}
                    />
                </SettingGroup>
            )}

            {isCatbox && (
                <SettingGroup name="Catbox" description="Optional account binding for Catbox uploads.">
                    <SettingTextInput
                        name="Catbox Userhash"
                        description="Your Catbox userhash for account binding, leave empty for anonymous uploads."
                        value={store.catboxUserhash}
                        onChange={v => store.catboxUserhash = v}
                        placeholder="Your Catbox userhash"
                    />
                </SettingGroup>
            )}

            {isLitterbox && (
                <SettingGroup name="Litterbox" description="Litterbox stores uploads temporarily; choose how long they're kept.">
                    <SettingsSection id="litterbox-expiry" name="Retention Window" description="How long uploads are kept before they're deleted.">
                        <Select
                            options={litterboxOptions}
                            isSelected={v => v === store.litterboxExpiry}
                            select={v => {
                                store.litterboxExpiry = v;
                                update();
                            }}
                            serialize={v => v}
                            placeholder="Select expiry"
                        />
                    </SettingsSection>
                </SettingGroup>
            )}

            {isGofile && (
                <SettingGroup name="GoFile" description="Optional account binding for GoFile uploads.">
                    <SettingTextInput
                        name="GoFile Token"
                        description="Optional GoFile token to upload into your account."
                        value={store.gofileToken}
                        onChange={v => store.gofileToken = v}
                        placeholder="Optional GoFile token"
                    />
                </SettingGroup>
            )}

            {isPixelVault && (
                <SettingGroup name="PixelVault" description="Connection details for PixelVault uploads.">
                    <SettingTextInput
                        name="PixelVault Upload Key"
                        description="Your PixelVault authorization key."
                        value={store.pixelVaultKey}
                        onChange={v => store.pixelVaultKey = v}
                        placeholder="Your PixelVault upload key"
                    />
                </SettingGroup>
            )}

            {isPixelDrain && (
                <SettingGroup name="PixelDrain" description="Optional account binding for PixelDrain uploads.">
                    <SettingTextInput
                        name="PixelDrain API Key"
                        description="Optional PixelDrain API key for authenticated uploads. Leave empty for anonymous uploads."
                        value={store.pixelDrainKey}
                        onChange={v => store.pixelDrainKey = v}
                        placeholder="Your PixelDrain API key"
                    />
                </SettingGroup>
            )}

            {isShareX && (
                <SettingGroup name="ShareX/Custom Uploader" description="Configure your own upload service. Use the guided form, or paste/import a raw ShareX config.">
                    <SettingSwitch
                        name="Form View"
                        description="Edit with individual fields instead of the raw JSON config box."
                        checked={Boolean(store.sharexFormView)}
                        onChange={v => { store.sharexFormView = v; update(); }}
                    />
                    {store.sharexFormView ? (
                        <ShareXFormFields store={store} update={update} />
                    ) : (
                        <SettingsSection
                            id="sharex-custom-uploader-config"
                            name="ShareX/Custom Uploader Config"
                            description="Paste your ShareX/Custom uploader JSON (.sxcu/.json). DestinationType must include FileUploader or ImageUploader."
                        >
                            <TextArea
                                value={store.sharexConfig}
                                rows={10}
                                placeholder='{"RequestMethod":"POST","RequestURL":"https://example.com/api/upload","Body":"MultipartFormData"}'
                                onChange={v => store.sharexConfig = v}
                            />
                        </SettingsSection>
                    )}
                    <SettingsSection id="sharex-config-actions" name="ShareX Config Actions" description="Import from file or validate the config">
                        <div className={cl("actions")}>
                            <Button size="small" onClick={triggerShareXFileUpload}>Import .sxcu/.json</Button>
                            <Button size="small" onClick={validateShareXConfig}>Validate</Button>
                        </div>
                        <input
                            ref={sharexFileInputRef}
                            type="file"
                            accept=".sxcu,.json,application/json,text/plain"
                            style={{ display: "none" }}
                            onChange={handleShareXFileUpload}
                        />
                    </SettingsSection>
                </SettingGroup>
            )}

            {isWebdav && (
                <SettingGroup name="WebDAV" description="Connection details for WebDAV servers (Nextcloud, Owncloud, etc.).">
                    <SettingTextInput
                        name="Server URL"
                        description="Base WebDAV URL (e.g. https://nextcloud.example.com/remote.php/dav/files/username)"
                        value={store.webdavUrl}
                        onChange={v => store.webdavUrl = v}
                        placeholder="https://nextcloud.example.com/remote.php/dav/files/username"
                    />
                    <SettingTextInput
                        name="Username"
                        description="WebDAV username"
                        value={store.webdavUsername}
                        onChange={v => store.webdavUsername = v}
                        placeholder="username"
                    />
                    <SettingTextInput
                        name="Password or App Token"
                        description="WebDAV password or app token"
                        value={store.webdavPassword}
                        onChange={v => store.webdavPassword = v}
                        placeholder="password or app token"
                    />
                    <SettingTextInput
                        name="Upload Directory"
                        description="Optional subdirectory on the server to upload into (e.g. uploads)"
                        value={store.webdavDirectory}
                        onChange={v => store.webdavDirectory = v}
                        placeholder="Leave empty for root directory"
                    />
                    <SettingsSection id="server-type" name="Server Type" description="Select your WebDAV server type. Nextcloud and ownCloud will create a public share link. Generic returns the raw file URL.">
                        <Select
                            options={[
                                { label: "Nextcloud", value: "nextcloud", default: true },
                                { label: "ownCloud", value: "owncloud" },
                                { label: "Generic WebDAV", value: "generic" }
                            ]}
                            isSelected={v => v === store.webdavServerType}
                            select={v => {
                                store.webdavServerType = v;
                                update();
                            }}
                            serialize={v => v}
                            placeholder="Select server type"
                        />
                    </SettingsSection>
                    {store.webdavServerType !== "generic" && (
                        <SettingsSection id="share-link-format" name="Share Link Format" description="How to return the public share link. Share Page links to a web page; Direct Download links straight to the file; Markdown Link wraps the share page in a clickable filename.">
                            <Select
                                options={[
                                    { label: "Share Page", value: "share-page", default: true },
                                    { label: "Direct Download", value: "direct-download" },
                                    { label: "Markdown Link", value: "markdown" }
                                ]}
                                isSelected={v => v === store.webdavShareType}
                                select={v => {
                                    store.webdavShareType = v;
                                    update();
                                }}
                                serialize={v => v}
                                placeholder="Select share link format"
                            />
                        </SettingsSection>
                    )}
                </SettingGroup>
            )}

            <SettingGroup name="Upload Behavior" description="Control how BigFileUpload handles uploads and the resulting link.">
                <SettingSwitch
                    name="Insert URL into Chatbox"
                    description="Insert the uploaded file URL into the current chatbox."
                    checked={store.autoSend}
                    onChange={v => store.autoSend = v}
                />

                <SettingSwitch
                    name="Copy URL to Clipboard"
                    description="Automatically copy the uploaded file URL to clipboard."
                    checked={store.autoCopy}
                    onChange={v => store.autoCopy = v}
                />

                <SettingSwitch
                    name="Link as Filename"
                    description="Format the uploaded file URL as clickable text showing the original filename."
                    checked={Boolean((store as { displayOriginalFilename?: boolean; }).displayOriginalFilename)}
                    onChange={v => (store as { displayOriginalFilename?: boolean; }).displayOriginalFilename = v}
                />

                <SettingSwitch
                    name="Prevent Discord Embeds"
                    description="When inserting uploaded file URLs into chatbox, wrap them in angle brackets to avoid Discord embedding."
                    checked={store.autoFormat}
                    onChange={v => store.autoFormat = v}
                />

                <SettingSwitch
                    name="Convert APNG to GIF"
                    description="Automatically convert uploaded APNG files to GIF format."
                    checked={store.apngToGif}
                    onChange={v => store.apngToGif = v}
                />

                <SettingSwitch
                    name="Preserve Original Filename"
                    description="Use the original filename instead of generic names for uploaders that allow it."
                    checked={Boolean((store as { preserveOriginalFilename?: boolean; }).preserveOriginalFilename)}
                    onChange={v => (store as { preserveOriginalFilename?: boolean; }).preserveOriginalFilename = v}
                />

                <SettingSwitch
                    name="Strip Query Parameters"
                    description="Strip query parameters from the uploaded file URL."
                    checked={store.stripQueryParams}
                    onChange={v => store.stripQueryParams = v}
                />

                <SettingSwitch
                    name="Video Embed Proxy"
                    description="Wrap uploaded video links with an embed proxy service for better Discord previews."
                    checked={store.embedProxyEnabled}
                    onChange={v => {
                        store.embedProxyEnabled = v;
                        update();
                    }}
                />

                {store.embedProxyEnabled && (
                    <SettingsSection id="embed-proxy-service" name="Embed Proxy Service" description="Choose which embed proxy service to use for uploaded video links">
                        <Select
                            options={embedProxyOptions}
                            isSelected={v => v === store.embedProxyService}
                            select={v => {
                                store.embedProxyService = v;
                                update();
                            }}
                            serialize={v => v}
                            placeholder="Select an embed proxy service"
                        />
                    </SettingsSection>
                )}

            </SettingGroup>

            <SettingGroup name="Discord Integration" description="Choose when BigFileUpload takes over Discord file handling.">
                <SettingSwitch
                    name="Respect Discord File Size Limit"
                    description="Only intercept uploads for files larger than your current Discord upload limit."
                    checked={store.bypassDiscordUploadOnlyOverLimit}
                    onChange={v => store.bypassDiscordUploadOnlyOverLimit = v}
                />

                <SettingSwitch
                    name="Bypass Discord Upload Button"
                    description="Intercept uploads when uploading files via the native upload button."
                    checked={Boolean((store as { bypassDiscordUpload?: boolean; }).bypassDiscordUpload)}
                    onChange={v => (store as { bypassDiscordUpload?: boolean; }).bypassDiscordUpload = v}
                />

                <SettingSwitch
                    name="Bypass Drag & Drop"
                    description="Intercept uploads when dragging & dropping files into the chatbox."
                    checked={Boolean((store as { bypassDragDrop?: boolean; }).bypassDragDrop)}
                    onChange={v => (store as { bypassDragDrop?: boolean; }).bypassDragDrop = v}
                />

                <SettingSwitch
                    name="Bypass Pasted Files"
                    description="Intercept uploads when pasting files into the chatbox."
                    checked={store.autoUploadPastedFiles}
                    onChange={v => store.autoUploadPastedFiles = v}
                />

                <SettingTextInput
                    name="Allowed File Types"
                    description="Comma-separated list of extensions (e.g. png,jpg,gif). Leave empty to allow all."
                    value={store.uploadAllowedFileTypes}
                    onChange={v => store.uploadAllowedFileTypes = v}
                    placeholder="png,jpg,gif,mp4,webp"
                />
            </SettingGroup>

            <SettingGroup name="Network" description="Configure browser upload proxying and timeouts.">
                <SettingSwitch
                    name="Disable CORS Proxy"
                    description="Send web uploads directly instead of through a CORS proxy. Enable if your host already allows Discord's origin (or you've whitelisted it in Vencord's CSP settings)."
                    checked={Boolean(store.disableCorsProxy)}
                    onChange={v => { store.disableCorsProxy = v; update(); }}
                />

                {!store.disableCorsProxy && (
                    <>
                        <SettingTextInput
                            name="CORS Proxy URL"
                            description="CORS proxy used for web uploads. Leave empty to use the default proxy."
                            value={store.corsProxyUrl || ""}
                            onChange={v => store.corsProxyUrl = v}
                            placeholder="https://your-cors-proxy.example.com"
                        />

                        <SettingsSection id="default-cors-proxy-source" name="Default CORS Proxy Source" description="Source code for the default CORS proxy">
                            <a href="https://codeberg.org/key/corsproxy" target="_blank" rel="noreferrer">codeberg.org/key/corsproxy</a>
                        </SettingsSection>
                    </>
                )}

                <SettingsSection id="upload-timeout" name="Upload Timeout" description="Abort an upload only if it stops making progress for this long, then switch to the next host.">
                    <Select
                        options={[
                            { label: "30 seconds", value: 30000 },
                            { label: "1 minute", value: 60000, default: true },
                            { label: "2 minutes", value: 120000 },
                            { label: "5 minutes", value: 300000 },
                            { label: "10 minutes", value: 600000 }
                        ]}
                        isSelected={v => v === (store.uploadTimeoutMs || 60000)}
                        select={v => {
                            store.uploadTimeoutMs = v;
                            update();
                        }}
                        serialize={v => v}
                        placeholder="Select timeout"
                    />
                </SettingsSection>
            </SettingGroup>

            <FallbackOrderSettings />
        </>
    );
}
