/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings, PlainSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { Switch } from "@components/Switch";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { localStorage } from "@utils/localStorage";
import { useForceUpdater } from "@utils/react";
import { OptionType } from "@utils/types";
import { React, Select, showToast, TextArea, TextInput } from "@webpack/common";

import { CORS_PROXY, CORS_PROXY_PRESETS, CredentialValues, DEFAULT_ACTIVE_FALLBACKS, describeKeptHost, describeProxy, directWebHostNames, fallbackServiceOrder, FileTypeFilter, findProxyPreset, inactiveFallbacks, isFilled, isGenericWebdav, isPresetProxy, isProxyTemplate, isPublicProxyUrl, isR2Endpoint, LEGACY_FALLBACK_ORDER, legacyConfigured, logger, normalizeLegacyFallbackOrder, parseEncryptingHostDomains, parseFileTypeFilter, parseProxyTemplate, parseShareXConfig, previewShareXRequestValue, PROXY_GUIDE_URL, proxyAddressProblem, proxyAddressText, proxyBodyLimit, proxyKey, RequestValueOptions, requiresCredentials, serviceLabel, SERVICES, ServiceType, ShareXUploaderConfig, TMPFILES_KEPT, validateShareXConfig, ZEROX0_KEPT } from "./types";
import { askToUseHost } from "./utils/dialogs";
import { clearUploadHistory, forgetHistoryEntry, HistoryEntry, historyEntry, isDeleting, MAX_HISTORY, uploadHistory, useUploadHistory } from "./utils/privacy";
import { AlwaysOrigin, answerProxyHere, checkEmbedNow, confirmRestoredProxy, consentPending, corsProxyAllowed, corsProxyWrapsVideo, EmbedTarget, embedTarget, embedTargetLabel, embedTargetName, forgetLanOrigin, forgetProxyOrigins, insecureHttpEntries, isInsecureHttpAllowed, NATIVE_EMBED_MAX, noticeProxyChange, peekDeviceProxyAnswer, peekDeviceState, peekEmbedHealth, peekFreshPending, peekProxyOrigins, proxyInvalid, proxyInvalidReason, redirectTickFor, removeAlwaysOrigin, restoreProxyUrlHere, setInsecureHttp, setProxyUrlHere, setRedirectTick, strictPending, useAlwaysOrigins, useDevicePrefs, useDeviceState, useEmbedHealth } from "./utils/proxy";
import { httpHostKind, httpLanOnlyText } from "./utils/shared";
import { canCheckS3PublicRead, carriesCredential, deleteFromHistory, deletionProblem, formatSize, getActiveCorsProxyUrl, getEmbedProxyService, getFallbackServices, getServiceConfigProblems, gofileGuestSynced, hasNativeHelper, hasStoredGofileGuestToken, hostRetention, INSECURE_HTTP_HOSTS, insecureHttpOffered, isHostConfigured, isUsableHere, listApprovedServers, listNames, needsProxyNote, proxiedCredentialHosts, proxyAllowedHere, proxyCredentialWarning, resetApprovedServers, resetGofileGuestToken, routesThroughProxy, setGofileGuestSync, webDeclineOutlook, ziplineMaxBytes } from "./utils/upload";

const cl = classNameFactory("vc-file-upload-settings-");

const serviceOptions = fallbackServiceOrder
    .filter(service => IS_WEB ? SERVICES[service].web !== "unsupported" : true)
    .map(service => ({
        label: SERVICES[service].pickerLabel ?? SERVICES[service].label,
        value: service,
        ...(service === ServiceType.CATBOX && { default: true })
    }));

const litterboxOptions = [
    { label: "1 hour", value: "1h" },
    { label: "12 hours", value: "12h" },
    { label: "24 hours", value: "24h", default: true },
    { label: "72 hours", value: "72h" }
];

const litterboxNameOptions = [
    { label: "Litterbox's default (6 characters)", value: "default", default: true },
    { label: "16 characters (harder to guess, as Litterbox's website uses)", value: "16" }
];

const zeroX0ExpiryOptions = [
    { label: "0x0's own retention (30 days to 1 year)", value: "default", default: true },
    { label: "1 hour", value: "1" },
    { label: "24 hours", value: "24" },
    { label: "3 days", value: "72" },
    { label: "7 days", value: "168" },
    { label: "30 days", value: "720" }
];

const tmpfilesExpiryOptions = [
    { label: "1 hour (tmpfiles' default)", value: "default", default: true },
    { label: "6 hours", value: "21600" },
    { label: "24 hours", value: "86400" },
    { label: "48 hours", value: "172800" }
];

const stripQueryModeOptions = [
    { label: "Tracking parameters only (utm_*, fbclid, si, …)", value: "tracking" },
    { label: "All query parameters", value: "all" }
];

const primaryFailureOptions = [
    { label: "Use the next active host", value: "auto", default: true },
    { label: "Always ask before using another host", value: "ask" }
];

const embedProxyOptions = [
    { label: "CORS Proxy", value: "cors", default: true },
    { label: "autocompressor.net (AUTO-REZ Media Technologies)", value: "autocompressor" },
    { label: "x266.mov", value: "x266" }
];

const uploadTimeoutOptions = [
    { label: "30 seconds", value: 30000 },
    { label: "1 minute", value: 60000, default: true },
    { label: "2 minutes", value: 120000 },
    { label: "5 minutes", value: 300000 },
    { label: "10 minutes", value: 600000 }
];

function snapToTimeoutOption(value: number | undefined): number {
    const effective = Number(value) || 60000;
    return uploadTimeoutOptions.reduce(
        (best, option) => Math.abs(option.value - effective) < Math.abs(best - effective) ? option.value : best,
        uploadTimeoutOptions[0].value
    );
}

const encryptingHostUrlStyleOptions = [
    { label: "Query", value: "query", default: true },
    { label: "Param", value: "param" },
    { label: "Fake Link", value: "fakelink" },
    { label: "Embed", value: "embed" },
    { label: "Zero-width (zws)", value: "zws" }
];

const webdavServerTypeOptions = [
    { label: "Nextcloud", value: "nextcloud", default: true },
    { label: "ownCloud", value: "owncloud" },
    { label: "Generic WebDAV", value: "generic" }
];

const webdavShareTypeOptions = [
    { label: "Share Page", value: "share-page", default: true },
    { label: "Direct Download", value: "direct-download" },
    { label: "Markdown Link", value: "markdown" }
];

const hiddenText = (description: string, defaultValue = "") => ({ type: OptionType.STRING as const, description, default: defaultValue, hidden: true });

export const settings = definePluginSettings({
    serviceType: {
        type: OptionType.SELECT,
        description: "Selected uploader service",
        options: serviceOptions,
        hidden: true
    },
    serviceUrl: hiddenText("Zipline service URL"),
    ziplineToken: hiddenText("Zipline auth token"),
    folderId: hiddenText("Optional Zipline folder ID"),
    ezHostKey: hiddenText("E-Z Host API key"),
    nestToken: hiddenText("Nest API token"),
    encryptingHostKey: hiddenText("Encrypting.host API key"),
    encryptingHostUrlStyle: {
        type: OptionType.SELECT,
        description: "Encrypting.host URL style",
        options: encryptingHostUrlStyleOptions,
        default: "query",
        hidden: true
    },
    encryptingHostDomains: hiddenText("Encrypting.host domains JSON list (blank means [\"normal\"])", "[\"normal\"]"),
    encryptingHostTitle: hiddenText("Optional Encrypting.host embed title"),
    encryptingHostColor: hiddenText("Optional Encrypting.host embed color"),
    encryptingHostFakelink: hiddenText("Optional Encrypting.host fake link"),
    s3Endpoint: hiddenText("S3-compatible endpoint URL"),
    s3Bucket: hiddenText("S3 bucket name"),
    s3Region: hiddenText("S3 region (use auto for R2)", "auto"),
    s3AccessKeyId: hiddenText("S3 access key ID"),
    s3SecretAccessKey: hiddenText("S3 secret access key"),
    s3SessionToken: hiddenText("Optional S3 session token"),
    s3PublicUrl: hiddenText("Optional public base URL"),
    s3Prefix: hiddenText("Optional S3 object key prefix"),
    s3ForcePathStyle: {
        type: OptionType.BOOLEAN,
        description: "Use path-style S3 URLs",
        default: true,
        hidden: true
    },
    s3SignPayload: {
        type: OptionType.BOOLEAN,
        description: "Sign the file's SHA-256 in S3 requests to an https endpoint",
        default: false,
        hidden: true
    },
    litterboxExpiry: {
        type: OptionType.SELECT,
        description: "Litterbox retention window",
        options: litterboxOptions,
        default: "24h",
        hidden: true
    },
    litterboxFileNameLength: {
        type: OptionType.SELECT,
        description: "Litterbox file name length",
        options: litterboxNameOptions,
        hidden: true
    },
    zeroX0Secret: {
        type: OptionType.BOOLEAN,
        description: "Ask 0x0.st for longer, hard-to-guess links",
        default: true,
        hidden: true
    },
    zeroX0Expiry: {
        type: OptionType.SELECT,
        description: "How long 0x0.st keeps uploads",
        options: zeroX0ExpiryOptions,
        hidden: true
    },
    tmpfilesExpiry: {
        type: OptionType.SELECT,
        description: "How long tmpfiles.org keeps uploads",
        options: tmpfilesExpiryOptions,
        hidden: true
    },
    catboxUserhash: hiddenText("Catbox userhash for account binding"),
    sharexConfig: hiddenText("ShareX/Custom uploader JSON"),
    disableFallbacks: {
        type: OptionType.BOOLEAN,
        description: "Disable fallback upload services",
        default: false,
        hidden: true
    },
    primaryFailureMode: {
        type: OptionType.SELECT,
        description: "When the Selected Host Fails",
        options: primaryFailureOptions,
        hidden: true
    },
    autoSend: {
        type: OptionType.BOOLEAN,
        description: "Insert uploaded URL into chatbox",
        default: true,
        hidden: true
    },
    sendImmediately: {
        type: OptionType.BOOLEAN,
        description: "Send the inserted link as a message right away",
        default: false,
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
    customDiscordFileSizeLimitMB: {
        type: OptionType.NUMBER,
        description: "Also take over files above this many MB (0 = Discord's limit only)",
        default: 0,
        hidden: true
    },
    uploadWholeBatch: {
        type: OptionType.BOOLEAN,
        description: "When some files are over the limit, upload the whole batch externally",
        default: false,
        hidden: true
    },
    skipDiscordGeneratedFiles: {
        type: OptionType.BOOLEAN,
        description: "When always intercepting, leave files Discord generates itself to Discord",
        default: true,
        hidden: true
    },
    gofileToken: hiddenText("Optional GoFile API token"),
    gofileReuseGuestToken: {
        type: OptionType.BOOLEAN,
        description: "Reuse one GoFile guest account for anonymous uploads",
        default: true,
        hidden: true
    },
    gofileGuestToken: {
        type: OptionType.STRING,
        description: "The GoFile guest token anonymous uploads reuse",
        hidden: true
    },
    gofileSyncGuestToken: {
        type: OptionType.BOOLEAN,
        description: "Sync the GoFile guest token across devices",
        default: false,
        hidden: true
    },
    fallbackOrder: hiddenText("Fallback uploader order (read by older versions)", LEGACY_FALLBACK_ORDER.join(",")),
    fallbackActive: {
        type: OptionType.STRING,
        description: "Active fallback hosts, in order, separated by commas. A host that isn't listed is never used.",
        hidden: true
    },
    pixelVaultKey: hiddenText("PixelVault upload key"),
    pixelDrainKey: hiddenText("PixelDrain API key"),
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
    stripQueryMode: {
        type: OptionType.STRING,
        description: "Which query parameters Strip Query Parameters removes: \"tracking\" or \"all\" (unset means all)",
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
    embedUseCustomProxy: {
        type: OptionType.BOOLEAN,
        description: "Use my custom CORS proxy for video links",
        default: false,
        hidden: true
    },
    embedCustomProxyFor: hiddenText("The custom proxy that \"Use My Proxy for Video Links\" was turned on for"),
    embedProxyPrivateHosts: {
        type: OptionType.BOOLEAN,
        description: "Also wrap video links from private hosts",
        default: false,
        hidden: true
    },
    embedSkipNative: {
        type: OptionType.BOOLEAN,
        description: "Skip When Discord Can Embed",
        default: true,
        hidden: true
    },
    corsProxyUrl: hiddenText("CORS proxy URL used for browser uploads", CORS_PROXY),
    disableCorsProxy: {
        type: OptionType.BOOLEAN,
        description: "Turn off the CORS proxy (Web uploads, the desktop blocked-host retry, and 'CORS Proxy' video wrapping, which then uses autocompressor.net)",
        default: false,
        hidden: true
    },
    corsProxyNoRedirects: {
        type: OptionType.BOOLEAN,
        description: "My Proxy Passes Redirects Back Unchanged. Tick only for a proxy that returns 3xx answers to the app as they are. cors-anywhere never qualifies: it follows some redirects itself and rewrites the others onto its own address.",
        default: false,
        hidden: true
    },
    corsProxyCustomUrl: hiddenText("Your own proxy's address, kept while a preset is picked"),
    corsProxyNoRedirectsFor: hiddenText("The proxy that \"My Proxy Passes Redirects Back Unchanged\" was ticked for"),
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
    webdavUrl: hiddenText("WebDAV server URL"),
    webdavUsername: hiddenText("WebDAV username"),
    webdavPassword: hiddenText("WebDAV password or app token"),
    webdavDirectory: hiddenText("Optional subdirectory on the WebDAV server"),
    webdavServerType: {
        type: OptionType.SELECT,
        description: "WebDAV server type",
        options: webdavServerTypeOptions,
        default: "nextcloud",
        hidden: true
    },
    webdavShareType: {
        type: OptionType.SELECT,
        description: "WebDAV share link format",
        options: webdavShareTypeOptions,
        default: "share-page",
        hidden: true
    },
    uploadAllowedFileTypes: hiddenText("File extensions BigFileUpload handles (e.g. png,jpg,mp4); !ext excludes one (e.g. !exe,!zip), also on top of a list. Leave empty to handle every file."),
    settingsComponent: {
        type: OptionType.COMPONENT,
        description: "Settings",
        component: SettingsComponent
    }
}).withPrivateSettings<{
    settingsVersion?: number;
    takeoverNoticeShown?: boolean;
}>();

const COMMIT_DELAY_MS = 400;

function useDebouncedCommit() {
    const pending = React.useRef<(() => void) | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const flush = React.useCallback(() => {
        clearTimeout(timer.current);
        const save = pending.current;
        pending.current = null;
        save?.();
    }, []);
    React.useEffect(() => flush, [flush]);

    const schedule = React.useCallback((save: () => void) => {
        pending.current = save;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, COMMIT_DELAY_MS);
    }, [flush]);

    return { schedule, flush };
}

function useTextDraft(value: string, onChange: (value: string) => void, validate?: (value: string) => string | null, immediate = false) {
    const [draft, setDraft] = React.useState<string | null>(null);
    const [checked, setChecked] = React.useState<string | null>(null);
    const { schedule, flush } = useDebouncedCommit();

    const text = draft ?? (typeof value === "string" ? value : "");
    return {
        text,
        error: validate?.(checked ?? text) ?? null,
        flush,
        change(next: string) {
            if (immediate) return onChange(next);
            setDraft(next);
            if (checked === null) setChecked(text);
            schedule(() => {
                setDraft(null);
                setChecked(null);
                if (next !== value) onChange(next);
            });
        }
    };
}

interface TextInputProps {
    description: string;
    name: string;
    onChange: (value: string) => void;
    placeholder: string;
    value: string;
    secret?: boolean;
    onCommit?: () => void;
    validate?: (value: string) => string | null;
}

const SettingTextInput = (props: TextInputProps) => <DraftTextInput key={props.name} {...props} />;

function DraftTextInput(props: TextInputProps) {
    const { description, name, onChange, placeholder, value, secret, onCommit, validate } = props;
    const [revealed, setRevealed] = React.useState(false);
    const { text, error, change, flush } = useTextDraft(value, onChange, validate, Boolean(onCommit));
    const save = onCommit ?? flush;

    return (
        <SettingsSection id={name} name={name} description={description} error={error}>
            <div className={cl("secret-row")}>
                <div className={cl("secret-input")}>
                    <TextInput
                        type={secret && !revealed ? "password" : "text"}
                        value={text}
                        onChange={change}
                        placeholder={placeholder}
                        // Discord's TextInput cuts input at 999 characters by default, and an STS session token is longer
                        maxLength={null}
                        // Chromium ignores autocomplete=off on password fields and would offer the discord.com login on Vencord Web
                        {...secret && { spellCheck: false, autoComplete: "new-password", "data-1p-ignore": "true", "data-lpignore": "true" }}
                        onBlur={save}
                        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") save(); }}
                    />
                </div>
                {secret && (
                    <Button size="small" onClick={() => setRevealed(r => !r)}>
                        {revealed ? "Hide" : "Show"}
                    </Button>
                )}
            </div>
        </SettingsSection>
    );
}

interface TextAreaProps {
    id: string;
    name: string;
    description: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    rows: number;
    validate?: (value: string) => string | null;
}

const SettingTextArea = (props: TextAreaProps) => <DraftTextArea key={props.id} {...props} />;

function DraftTextArea({ id, name, description, value, onChange, placeholder, rows, validate }: TextAreaProps) {
    const { text, error, change, flush } = useTextDraft(value, onChange, validate);
    return (
        <SettingsSection id={id} name={name} description={description} error={error}>
            <TextArea value={text} rows={rows} placeholder={placeholder} onChange={change} onBlur={flush} />
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
            <div className={`${cl("group")} ${cl("sub")}`}>
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

type SettingKey<T extends OptionType> = {
    [K in keyof typeof settings.def]: (typeof settings.def)[K]["type"] extends T ? K : never
}[keyof typeof settings.def];

function BoundTextInput({ setting, update, ...props }: Omit<TextInputProps, "value" | "onChange"> & { setting: SettingKey<OptionType.STRING>; update?: () => void; }) {
    return <SettingTextInput {...props} value={settings.store[setting] ?? ""} onChange={value => { settings.store[setting] = value; update?.(); }} />;
}

function BoundSwitch({ setting, update, ...props }: Omit<Parameters<typeof SettingSwitch>[0], "checked" | "onChange"> & { setting: SettingKey<OptionType.BOOLEAN>; update?: () => void; }) {
    return <SettingSwitch {...props} checked={Boolean(settings.store[setting])} onChange={value => { settings.store[setting] = value; update?.(); }} />;
}

const Sub = ({ children }: { children: React.ReactNode; }) => <div className={cl("sub")}>{children}</div>;

const Guarded = ({ children }: { children: React.ReactNode; }) => <ErrorBoundary message="BigFileUpload couldn't show these settings">{children}</ErrorBoundary>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readShareXConfigObject(raw?: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || "{}");
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function isShareXConfigParseable(raw: string): boolean {
    try {
        return isPlainObject(JSON.parse(raw));
    } catch {
        return false;
    }
}

function shareXRequestUrl(raw: string | undefined): string | undefined {
    try {
        return parseShareXConfig(raw || "").RequestURL;
    } catch {
        return undefined;
    }
}

const shownFallbacks = () => pendingFallbackPreview() ?? getFallbackServices();

function visibilityContext(picker?: VisibilityContext["picker"]): VisibilityContext {
    const { store } = settings;
    const origins = peekProxyOrigins();
    const sharexConfig = store.sharexConfig || "";
    return {
        store,
        isWeb: IS_WEB,
        hasNativeHelper,
        proxyAllowedHere: proxyAllowedHere(),
        proxySyncedOn: corsProxyAllowed(),
        proxyPending: consentPending(),
        proxyAnswer: peekDeviceState().answer?.answer ?? null,
        proxyInvalid: proxyInvalid(),
        activeProxy: getActiveCorsProxyUrl(),
        embedService: getEmbedProxyService(),
        embedStrictPending: strictPending(),
        embedHasTarget: embedTarget() != null,
        corsProxyWrapsVideo: corsProxyWrapsVideo(),
        s3Proxied: routesThroughProxy(ServiceType.S3),
        isHostConfigured,
        isUsableHere,
        carriesCredential,
        insecureHttpOffered,
        fallbacks: shownFallbacks(),
        sharex: {
            requestUrl: shareXRequestUrl(sharexConfig),
            parseable: sharexConfig.trim() === "" || isShareXConfigParseable(sharexConfig),
            body: String(readShareXConfigObject(sharexConfig).Body || "MultipartFormData")
        },
        alwaysCount: origins.always.length,
        lanCount: origins.lan.length,
        insecureHttpCount: insecureHttpEntries().length,
        gofileGuestStored: hasStoredGofileGuestToken(),
        picker,
        history: uploadHistory().map(historyFacts)
    };
}

const historyFacts = (e: HistoryEntry): HistoryFacts => ({ id: e.id, deletable: Boolean(e.deletion), anonymous: Boolean(e.anonymous), problem: deletionProblem(e) });

function useVisibility(picker?: VisibilityContext["picker"]): Visibility {
    useDeviceState();
    useAlwaysOrigins();
    useDevicePrefs();
    useUploadHistory();
    return getVisibility(visibilityContext(picker));
}

const NO_ROWS: HostRows = { credentialWarning: false, privateWrapNote: false, insecureHttpNote: false, insecureHttpOptIn: false, missingNote: false };

function ManualLimitInput() {
    const { store } = settings;
    const [text, setText] = React.useState(() => store.customDiscordFileSizeLimitMB > 0 ? String(store.customDiscordFileSizeLimitMB) : "");

    return (
        <SettingTextInput
            name="Take Over Files Above (MB)"
            description="Also take files above this size. It can only lower Discord's limit. Leave empty to use Discord's limit."
            value={text}
            onChange={v => {
                setText(v);
                if (megabytesProblem(v)) return;
                store.customDiscordFileSizeLimitMB = v.trim() === "" ? 0 : Number(v);
            }}
            placeholder="Discord's limit"
            validate={megabytesProblem}
        />
    );
}

const httpRule = (service: ServiceType, rows: HostRows): HttpRule => ({
    native: !IS_WEB && hasNativeHelper,
    offered: rows.insecureHttpOptIn,
    allowed: origin => INSECURE_HTTP_HOSTS.has(service) && isInsecureHttpAllowed(service, origin)
});

export function hostBadge(service: ServiceType): string {
    const info = SERVICES[service];
    if (!info) return "";
    if (info.privacy === "private") {
        const max = service === ServiceType.ZIPLINE ? ziplineMaxBytes() : null;
        return max != null ? `max ${formatSize(max, true)} · your server's setting` : "server-defined";
    }
    const limit = info.maxBytes != null ? `max ${formatSize(info.maxBytes, true)}` : "no known limit";
    const retention = hostRetention(service)?.replace(/^public(, )?/, "");
    return retention ? `${limit} · ${retention}` : limit;
}

function ServicePicker(props: {
    onChange: (service: ServiceType) => void;
    value: ServiceType;
}) {
    const { onChange, value } = props;

    return (
        <div className={cl("service-grid")} role="group" aria-label="Upload service">
            {serviceOptions.map(option => (
                <button
                    key={option.value}
                    type="button"
                    className={cl("service-option")}
                    aria-pressed={option.value === value}
                    data-selected={option.value === value}
                    onClick={() => onChange(option.value)}
                >
                    <span className={cl("service-option-label")}>{option.label}</span>
                    <span className={cl("service-option-badge")} title={hostBadge(option.value)}>{hostBadge(option.value)}</span>
                </button>
            ))}
        </div>
    );
}

function ShareXFormFields(props: { store: { sharexConfig?: string; }; update: () => void; vis: Visibility; rows: HostRows; }) {
    const { store, update, vis, rows } = props;
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

    const parseJsonField = (text: string): Record<string, unknown> | null | undefined => {
        if (text.trim() === "") return null;
        try {
            const parsed = JSON.parse(text);
            return isPlainObject(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    };

    const writeJsonField = (key: "Headers" | "Arguments", text: string) => {
        const parsed = parseJsonField(text);
        if (parsed === undefined) return;
        const next = readShareXConfigObject(store.sharexConfig);
        const stored = next[key];
        const same = parsed === null
            ? stored === undefined || (isPlainObject(stored) && !Object.keys(stored).length)
            : JSON.stringify(parsed) === JSON.stringify(stored);
        if (same) return;
        if (parsed === null) delete next[key];
        else next[key] = parsed;
        store.sharexConfig = JSON.stringify(next, null, 2);
        update();
    };
    const headersCommit = useDebouncedCommit();
    const argsCommit = useDebouncedCommit();

    const applyJsonField = (key: "Headers" | "Arguments", text: string, setText: (t: string) => void, setInvalid: (b: boolean) => void) => {
        setText(text);
        setInvalid(parseJsonField(text) === undefined);
        (key === "Headers" ? headersCommit : argsCommit).schedule(() => writeJsonField(key, text));
    };

    if (vis.sharexInvalidConfig) {
        // Editing any field rewrites the config, which would destroy a broken but recoverable config on one keystroke
        return (
            <SettingsSection
                id="sharex-form-parse-error"
                name="Invalid Config"
                description="The saved ShareX config isn't valid JSON. Fix it in Raw JSON view (turn off Form View), or clear it to start over. Editing a field here would otherwise overwrite the broken config."
            >
                <Button size="small" onClick={() => { store.sharexConfig = ""; update(); }}>
                    Clear config and start over
                </Button>
            </SettingsSection>
        );
    }

    return (
        <>
            <SettingTextInput
                name="Request URL"
                description="The endpoint your file is sent to (required)."
                value={String(config.RequestURL || "")}
                onChange={v => setField("RequestURL", v)}
                placeholder="https://example.com/api/upload"
                validate={v => shareXRequestUrlProblem(v, httpRule(ServiceType.SHAREX, rows), config as ShareXUploaderConfig)}
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
            <SettingsSection id="sharex-form-body" name="Body Type" description="Binary sends the raw file. Multipart sends it as a form field. JSON and URL-encoded bodies aren't supported.">
                <Select
                    options={[
                        { label: "Multipart Form Data", value: "MultipartFormData" },
                        { label: "Binary (raw file in body)", value: "Binary" }
                    ]}
                    isSelected={v => v.toLowerCase() === body.toLowerCase()}
                    select={v => setField("Body", v)}
                    serialize={v => v}
                    placeholder="Select body type"
                />
            </SettingsSection>
            {(vis.sharexFileFormName || vis.sharexArguments) && (
                <Sub>
                    {vis.sharexFileFormName && (
                        <SettingTextInput
                            name="File Form Field Name"
                            description="The form field name your server expects the file under (defaults to 'file')."
                            value={String(config.FileFormName || "")}
                            onChange={v => setField("FileFormName", v)}
                            placeholder="file"
                        />
                    )}
                    {vis.sharexArguments && (
                        <SettingsSection
                            id="sharex-form-arguments"
                            name="Arguments (JSON)"
                            description={argsInvalid ? "⚠ Invalid JSON. Argument changes are not saved until it's valid." : "Optional extra multipart form fields sent with the file, as a JSON object."}
                        >
                            <TextArea
                                value={argsText}
                                rows={3}
                                placeholder={"{ \"key\": \"value\" }"}
                                onChange={text => applyJsonField("Arguments", text, setArgsText, setArgsInvalid)}
                                onBlur={argsCommit.flush}
                            />
                        </SettingsSection>
                    )}
                </Sub>
            )}
            <SettingsSection
                id="sharex-form-headers"
                name="Headers (JSON)"
                description={headersInvalid ? "⚠ Invalid JSON. Header changes are not saved until it's valid." : "Optional request headers as a JSON object (e.g. an auth token)."}
            >
                <TextArea
                    value={headersText}
                    rows={3}
                    placeholder={"{ \"Authorization\": \"Bearer ...\" }"}
                    onChange={text => applyJsonField("Headers", text, setHeadersText, setHeadersInvalid)}
                    onBlur={headersCommit.flush}
                />
            </SettingsSection>
            <SettingTextInput
                name="Response URL"
                description="How to read the link from the answer. Leave empty for plain text or a {url} JSON field, or use a ShareX template like $json:url$."
                value={String(config.URL || "")}
                onChange={v => setField("URL", v)}
                placeholder="$json:url$"
            />
        </>
    );
}

type Area = "active" | "inactive";

const FALLBACK_ORDER_DESCRIPTION = "The selected host is tried first, then the active hosts in this order. Drag to reorder, or use Alt+arrow keys. Update BigFileUpload on every device that syncs settings, since older versions ignore the Inactive area.";

const DIRECT_WEB_HOSTS = directWebHostNames("and");

function proxyLimitNote(): string {
    const limit = proxyBodyLimit(getActiveCorsProxyUrl());
    return limit == null ? "" : ` Files over ${formatSize(limit, true)} aren't sent through it.`;
}

const credentialMessages = (service: ServiceType) => getServiceConfigProblems(service).filter(p => p.kind === "credentials").map(p => p.message);

function fallbackRowNote(service: ServiceType, kind: "credentials" | "platform" | undefined): string | undefined {
    if (kind === "platform") {
        const { web } = SERVICES[service];
        if (web === "unsupported") return "Not used on Vencord Web";
        if (web === "proxy") return needsProxyNote();
        return getServiceConfigProblems(service).find(p => p.kind === "platform")?.message;
    }
    if (kind === "credentials") return `${credentialMessages(service).join("; ")}. Enter them under Fallback Hosts below. Until then it is skipped.`;
}

function FallbackOrderSettings({ update, vis }: { update: () => void; vis: Visibility; }) {
    const { store } = settings;
    const preview = pendingFallbackPreview();
    const readOnly = preview !== null;
    const stored = preview ?? getFallbackServices();
    const selected = store.serviceType as ServiceType;
    const active = stored.filter(s => s !== selected);
    const inactive = inactiveFallbacks(stored).filter(s => s !== selected);

    const [drag, setDrag] = React.useState<{ service: ServiceType; from: Area; } | null>(null);
    const [announcement, setAnnouncement] = React.useState("");
    const [focusTarget, setFocusTarget] = React.useState<{ service: ServiceType; on: "row" | "switch"; } | null>(null);
    const rowRefs = React.useRef(new Map<ServiceType, HTMLDivElement>());

    React.useEffect(() => {
        if (!focusTarget) return;
        const row = rowRefs.current.get(focusTarget.service);
        (focusTarget.on === "switch" ? row?.querySelector<HTMLInputElement>("input[type=checkbox]") : row)?.focus();
        setFocusTarget(null);
    }, [focusTarget]);

    const position = (service: ServiceType, list: readonly ServiceType[]) => `position ${list.indexOf(service) + 1} of ${list.length}`;

    const commit = (next: ServiceType[], moved: ServiceType, on: "row" | "switch", message: string) => {
        const at = stored.indexOf(selected);
        const list = next.filter(s => s !== selected);
        if (at >= 0) list.splice(Math.min(at, list.length), 0, selected);
        markFallbackListEdited();
        store.fallbackActive = list.join(",");
        setFocusTarget({ service: moved, on });
        setAnnouncement(message);
        update();
    };

    const moveWithin = (from: number, to: number) => {
        if (from === to || from < 0 || to < 0 || from >= active.length || to >= active.length) return;
        const next = [...active];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        commit(next, moved, "row", `${serviceLabel(moved)} is active, ${position(moved, next)}.`);
    };
    const deactivate = (service: ServiceType, on: "row" | "switch" = "row") =>
        commit(active.filter(s => s !== service), service, on, `${serviceLabel(service)} moved to Inactive. It will never be used.`);
    const activate = (service: ServiceType, at = active.length, on: "row" | "switch" = "row") => {
        const next = active.filter(s => s !== service);
        next.splice(at, 0, service);
        const missing = credentialMessages(service);
        commit(next, service, on, `${serviceLabel(service)} is active, ${position(service, next)}.${missing.length ? ` ${missing.join("; ")}.` : ""}`);
    };

    const acceptDrag = (event: React.DragEvent) => {
        if (drag) event.preventDefault();
    };
    const onRowDrop = (event: React.DragEvent, area: Area, target: ServiceType) => {
        event.preventDefault();
        event.stopPropagation();
        const source = drag;
        setDrag(null);
        if (!source) return;
        if (area === "inactive") {
            if (source.from === "active") deactivate(source.service);
        } else if (source.from === "active") moveWithin(active.indexOf(source.service), active.indexOf(target));
        else activate(source.service, active.indexOf(target));
    };
    const onAreaDrop = (event: React.DragEvent, area: Area) => {
        event.preventDefault();
        const source = drag;
        setDrag(null);
        if (!source) return;
        if (area === "inactive" && source.from === "active") deactivate(source.service);
        else if (area === "active" && source.from === "inactive") activate(source.service);
    };

    const renderRow = (service: ServiceType, area: Area) => {
        const label = serviceLabel(service);
        const index = active.indexOf(service);
        const note = area === "active" ? fallbackRowNote(service, vis.rowNote[service]) : undefined;
        return (
            <div
                key={service}
                ref={el => { if (el) rowRefs.current.set(service, el); else rowRefs.current.delete(service); }}
                className={cl("fallback-order-item")}
                role="listitem"
                tabIndex={0}
                aria-label={area === "active" ? `${label}, active, ${position(service, active)}` : `${label}, inactive`}
                aria-describedby={`vc-file-upload-fallback-badge-${service}`}
                aria-disabled={readOnly || undefined}
                draggable={!readOnly}
                data-dragging={drag?.service === service}
                onKeyDown={event => {
                    if (readOnly || !event.altKey) return;
                    const move = area === "active"
                        ? { ArrowUp: () => moveWithin(index, index - 1), ArrowDown: () => moveWithin(index, index + 1), ArrowRight: () => deactivate(service) }[event.key]
                        : event.key === "ArrowLeft" ? () => activate(service) : undefined;
                    if (!move) return;
                    event.preventDefault();
                    move();
                }}
                onDragStart={event => {
                    if (readOnly) return event.preventDefault();
                    setDrag({ service, from: area });
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-bfu-fallback", service);
                }}
                onDragOver={acceptDrag}
                onDrop={event => onRowDrop(event, area, service)}
                onDragEnd={() => setDrag(null)}
            >
                <div className={cl("fallback-order-text")}>
                    <span className={cl("fallback-order-label")}>{label}</span>
                    <span id={`vc-file-upload-fallback-badge-${service}`} className={cl("fallback-order-badge")}>{area === "active" ? hostBadge(service) : "never used"}</span>
                    {note && <span className={cl("fallback-order-note")}>{note}</span>}
                </div>
                <label className={cl("fallback-order-switch")}>
                    <span className="vc-file-upload-sr-only">{`Use ${label} as a fallback`}</span>
                    <Switch
                        checked={area === "active"}
                        disabled={readOnly}
                        onChange={on => on ? activate(service, active.length, "switch") : deactivate(service, "switch")}
                    />
                </label>
                {area === "active" && !readOnly && <span className={cl("fallback-order-handle")} aria-hidden="true">Drag</span>}
            </div>
        );
    };

    return (
        <SettingsSection id="fallback-order" name="Fallback Order" description={FALLBACK_ORDER_DESCRIPTION}>
            {readOnly && <div className={cl("fallback-order-banner")}>These hosts will be set when BigFileUpload next starts.</div>}
            <div className="vc-file-upload-sr-only" aria-live="polite">{announcement}</div>
            <div id="vc-file-upload-fallback-active" className={cl("fallback-order-heading")}>Active (tried in this order)</div>
            <div
                className={cl("fallback-order-list")}
                role="list"
                aria-labelledby="vc-file-upload-fallback-active"
                onDragOver={acceptDrag}
                onDrop={event => onAreaDrop(event, "active")}
            >
                <div
                    className={cl("fallback-order-item")}
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${serviceLabel(selected)}, selected host, always tried first`}
                    aria-describedby="vc-file-upload-fallback-badge-selected"
                    data-selected-host="true"
                    onDragOver={event => event.stopPropagation()}
                    onDrop={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDrag(null);
                    }}
                >
                    <div className={cl("fallback-order-text")}>
                        <span className={cl("fallback-order-label")}>{serviceLabel(selected)}</span>
                        <span id="vc-file-upload-fallback-badge-selected" className={cl("fallback-order-badge")}>{hostBadge(selected)}</span>
                        <span className={cl("fallback-order-note")}>Selected host: always tried first</span>
                    </div>
                </div>
                {active.map(s => renderRow(s, "active"))}
                {vis.fallbackEmptyHint && (
                    <div className={cl("fallback-order-empty")}>
                        No active fallback hosts besides the selected host: only the selected host is used. Turn a host on, or drag one here.
                    </div>
                )}
            </div>
            <div id="vc-file-upload-fallback-inactive" className={cl("fallback-order-heading")}>Inactive (never used)</div>
            <div
                className={cl("fallback-order-list")}
                role="list"
                aria-labelledby="vc-file-upload-fallback-inactive"
                data-area="inactive"
                onDragOver={acceptDrag}
                onDrop={event => onAreaDrop(event, "inactive")}
            >
                {inactive.map(s => renderRow(s, "inactive"))}
            </div>
            <div className={cl("fallback-order-actions")}>
                <Button
                    size="small"
                    disabled={readOnly}
                    onClick={() => {
                        markFallbackListEdited();
                        store.fallbackActive = DEFAULT_ACTIVE_FALLBACKS;
                        setAnnouncement("Fallback hosts reset to default.");
                        update();
                    }}
                >
                    Reset to default
                </Button>
            </div>
        </SettingsSection>
    );
}

function FallbackOrderGroup({ update }: { update: () => void; }) {
    const vis = useVisibility();
    return vis.fallbackOrder ? <FallbackOrderSettings update={update} vis={vis} /> : null;
}

function FallbackHostSections({ update }: { update: () => void; }) {
    const vis = useVisibility();
    if (!vis.fallbackHosts) return null;

    return (
        <SettingsSection id="fallback-hosts" name="Fallback Hosts" description="Options for the active fallback hosts.">
            <Sub>
                {vis.fallbackSections.map(s => (
                    <Guarded key={s}>
                        <HostSection service={s} update={update} />
                    </Guarded>
                ))}
            </Sub>
        </SettingsSection>
    );
}

function ShareXSection({ update, note, rows, vis }: { update: () => void; note?: React.ReactNode; rows: HostRows; vis: Visibility; }) {
    const { store } = settings;
    const sharexFileInputRef = React.useRef<HTMLInputElement>(null);
    const [sharexImportNonce, setSharexImportNonce] = React.useState(0);

    const validateShareX = () => {
        try {
            validateShareXConfig(parseShareXConfig(store.sharexConfig || ""));
            showToast({ text: "ShareX config is valid", variant: "success" });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid ShareX config";
            showToast({ text: message, variant: "critical" });
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
                setSharexImportNonce(n => n + 1);
                update();
                try {
                    validateShareXConfig(parsed);
                    showToast({ text: "Imported ShareX config", variant: "success" });
                } catch (error) {
                    showToast({ text: `Imported, but it can't be used yet: ${error instanceof Error ? error.message : "invalid ShareX config"}`, variant: "critical", duration: 10000 });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : "Couldn't import the ShareX config";
                showToast({ text: message, variant: "critical" });
            }
        };
        reader.readAsText(file);
        event.target.value = "";
    };

    return (
        <SettingGroup name="ShareX/Custom Uploader" description="Your own upload service. Use the form, or paste or import a ShareX config.">
            {note}
            {rows.privateWrapNote && <PrivateHostWrapNote service={ServiceType.SHAREX} />}
            {rows.credentialWarning && <ProxyCredentialWarning service={ServiceType.SHAREX} />}
            <BoundSwitch
                name="Form View"
                description="Edit with individual fields instead of the raw JSON config box."
                setting="sharexFormView"
                update={update}
            />
            <Sub>
                {vis.sharexRawConfig ? (
                    <SettingTextArea
                        id="sharex-custom-uploader-config"
                        name="ShareX/Custom Uploader Config"
                        description="Paste a ShareX config (.sxcu or .json). It must be a file uploader with a MultipartFormData or Binary body."
                        value={store.sharexConfig || ""}
                        rows={10}
                        placeholder='{"RequestMethod":"POST","RequestURL":"https://example.com/api/upload","Body":"MultipartFormData"}'
                        onChange={v => { store.sharexConfig = v; update(); }}
                        validate={v => shareXConfigProblem(v, httpRule(ServiceType.SHAREX, rows))}
                    />
                ) : (
                    <ShareXFormFields key={sharexImportNonce} store={store} update={update} vis={vis} rows={rows} />
                )}
            </Sub>
            <InsecureHttpSettings service={ServiceType.SHAREX} url={shareXRequestUrl(store.sharexConfig)} rows={rows} />
            <SettingsSection id="sharex-config-actions" name="ShareX Config Actions" description="Import from file or validate the config">
                <div className={cl("actions")}>
                    <Button size="small" onClick={triggerShareXFileUpload}>Import .sxcu/.json</Button>
                    <Button size="small" onClick={validateShareX}>Validate</Button>
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
    );
}

function httpOrigin(url: string | undefined): string | null {
    const trimmed = url?.trim() ?? "";
    if (!URL.canParse(trimmed)) return null;
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" ? parsed.origin : null;
}

function InsecureHttpSettings({ service, url, rows }: { service: ServiceType; url: string | undefined; rows: HostRows; }) {
    const origin = httpOrigin(url);
    if (!rows.insecureHttpNote || !origin) return null;
    return (
        <Sub>
            <div className={cl("host-note")}>Sent unencrypted: anyone on the same network can read your token and files.</div>
            {rows.insecureHttpOptIn && (
                <SettingSwitch
                    name="Allow Insecure HTTP"
                    description={`Tokens, passwords and files sent to ${origin} travel unencrypted. This device only.`}
                    checked={isInsecureHttpAllowed(service, origin)}
                    onChange={v => setInsecureHttp(service, origin, v)}
                />
            )}
        </Sub>
    );
}

let proxyCommitOpen = false;

function needsProxyQuestion(next: string): boolean {
    const answer = peekDeviceProxyAnswer();
    const k = proxyKey(next === "" ? CORS_PROXY : next);
    return answer?.answer === "accepted" && k !== null && k !== answer.proxy && proxiedCredentialHosts(false).length > 0;
}

function confirmProxyChange(next: string): Promise<boolean> {
    if (!needsProxyQuestion(next)) return Promise.resolve(true);
    const url = next === "" ? CORS_PROXY : next;
    try {
        return askToUseHost({
            title: "Change the CORS proxy?",
            question: `Send your credentials through ${describeProxy(url).host}? Whoever runs it sees them.`,
            confirmText: "Use this proxy",
            cancelText: "Cancel"
        }).answer;
    } catch (error) {
        logger.error("Couldn't ask before changing the CORS proxy", error);
        return Promise.resolve(false);
    }
}

function confirmRestoredProxyChange(url: string): Promise<boolean> {
    const { host } = describeProxy(url);
    const credentials = proxiedCredentialHosts(false).length > 0;
    try {
        return askToUseHost({
            title: "Use your saved proxy?",
            question: `${host} was saved as your own proxy, on this device or another one. ${credentials ? "Send your files and credentials through it? Whoever runs it sees them." : "Send your files through it? Whoever runs it sees them."} Until you answer, BigFileUpload treats it as unconfirmed on this device.`,
            confirmText: "Use this proxy",
            cancelText: "Not now"
        }).answer;
    } catch (error) {
        logger.error("Couldn't ask before using the restored CORS proxy", error);
        return Promise.resolve(false);
    }
}

export function rememberCustomProxy(previous: string | undefined, next: string): void {
    const value = isPresetProxy(next) ? previous?.trim() ?? "" : next.trim();
    if (proxyKey(value) == null || isPresetProxy(value) || value === settings.store.corsProxyCustomUrl) return;
    settings.store.corsProxyCustomUrl = value;
}

export interface ProxyChoice {
    url: string;
    noRedirects: boolean;
}

const isCustomValue = (raw: string) => raw !== "" && raw !== "none" && !isPresetProxy(raw);

function ProxyOperatorLine({ url }: { url: string; }) {
    const proxy = describeProxy(url);
    if (!proxy.preset) return <div className={cl("host-note")}>Your proxy: <code>{proxy.host}</code>. Whoever runs it sees what passes through it.</div>;
    return (
        <div className={cl("host-note")}>
            Code at{" "}
            <a href={proxy.source} target="_blank" rel="noreferrer">{proxy.source.replace(/^https:\/\//, "")}</a>{" "}
            (the running copy can't be verified). No privacy policy.
        </div>
    );
}

const ProxyGuideLink = ({ label = "Self-host guide" }: { label?: string; }) =>
    <a href={PROXY_GUIDE_URL} target="_blank" rel="noreferrer">{label}</a>;

function customVideoNote(committed: string): string {
    if (!proxyAllowedHere()) {
        return peekFreshPending()
            ? "Video links are posted plain until you answer the CORS-proxy question on this device."
            : "Video links use autocompressor.net while the CORS proxy is off on this device.";
    }
    if (!isCustomValue(committed) || proxyKey(committed) == null) return "Video links don't use your proxy. After you turn on the CORS proxy with your own URL, 'Use My Proxy for Video Links' appears under Upload Behavior.";
    if (!isPublicProxyUrl(committed)) return "Your proxy isn't reachable from the internet, so it is never used for video links. They use autocompressor.net while it is up.";
    return "Video links don't use your proxy, so its address is never posted. They use autocompressor.net while it is up. To use your proxy, turn on 'Use My Proxy for Video Links' under Upload Behavior.";
}

function embedHealthText(target: EmbedTarget): string {
    const { health, at } = peekEmbedHealth(target);
    const when = at ? `, checked ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    switch (health) {
        case "up": return `${embedTargetName(target)}: up${when}`;
        case "down": return `${embedTargetName(target)}: not responding${when}`;
        case "pending": return `${embedTargetName(target)}: checking…`;
        case "unknown": return `${embedTargetName(target)}: can't be checked in this app${IS_WEB ? "" : " (fully restart it after updating BigFileUpload)"}`;
        default: return `${embedTargetName(target)}: not checked yet`;
    }
}

function EmbedProxySettings({ update, vis }: { update: () => void; vis: Visibility; }) {
    const store = settings.use(["embedProxyEnabled", "embedProxyService", "embedUseCustomProxy", "embedCustomProxyFor", "embedProxyPrivateHosts", "embedSkipNative", "autoFormat", "displayOriginalFilename", "corsProxyUrl", "disableCorsProxy", "serviceType", "disableFallbacks", "fallbackActive"]);
    useEmbedHealth();
    const service = getEmbedProxyService();
    const target = embedTarget();
    const active = getActiveCorsProxyUrl();
    const key = proxyKey(active);
    const optInChecked = Boolean(store.embedUseCustomProxy) && store.embedCustomProxyFor === key;
    const notReachable = proxyAllowedHere() && key != null && !isPresetProxy(active) && !isPublicProxyUrl(active);
    const skip = store.embedSkipNative !== false;

    return (
        <>
            <BoundSwitch
                name="Video Embed Proxy"
                description="Wrap video links in an embed service for better previews. Wrapped links stop working if the service goes down."
                setting="embedProxyEnabled"
                update={update}
            />

            {vis.embedProxyService && (
                <Sub>
                    <SettingsSection id="embed-proxy-service" name="Embed Proxy Service" description="The service that wraps video links.">
                        <Select
                            options={embedProxyOptions}
                            isSelected={v => v === service}
                            select={v => {
                                store.embedProxyService = v;
                                checkEmbedNow();
                                update();
                            }}
                            serialize={v => v}
                            placeholder="Select an embed proxy service"
                        />
                    </SettingsSection>
                    {vis.embedPendingNote && <div className={cl("host-note")}>Video links are posted plain until you answer the CORS-proxy question on this device.</div>}
                    {vis.embedSubstitutionNote && (
                        <div className={cl("host-note")}>
                            {notReachable ? "Your proxy isn't reachable from the internet" : "The CORS proxy isn't used for video links here"}, so autocompressor.net wraps them while it's up. Its page loads Google ads, so Google sees the link and viewers' IP addresses.
                        </div>
                    )}
                    {vis.embedX266Note && <div className={cl("host-note")}>x266.mov logs each link with the viewer's IP address for 30 days, and some networks block it.</div>}
                    {vis.embedScopeNote && (
                        <div className={cl("host-note")}>
                            Links from Encrypting.host or private hosts{vis.embedPrivateHosts ? " (unless turned on below)" : ""}, links with a query string and bracketed links are never wrapped. The service is checked from your IP address when you upload a video.
                        </div>
                    )}
                    {vis.embedPreventNote && <div className={cl("host-note")}>With Prevent Discord Embeds on, inserted links aren't wrapped. Copied links are.</div>}

                    {vis.embedUseCustomProxy && (
                        <>
                            <SettingSwitch
                                name="Use My Proxy for Video Links"
                                description="Wrap video links with your own proxy instead of autocompressor.net. Anyone who sees a link can use your proxy."
                                checked={optInChecked}
                                onChange={v => {
                                    if (v) store.embedCustomProxyFor = key ?? "";
                                    store.embedUseCustomProxy = v;
                                    update();
                                }}
                            />
                            {store.embedUseCustomProxy && !optInChecked && <div className={cl("host-note")}>Turned on for a different proxy URL.</div>}
                            <div className={cl("host-note")}>{optInChecked && `Your proxy's address (${proxyAddressText(active)}) appears in every video link you post. Anyone who sees it can use your proxy and spend its quota. `}<ProxyGuideLink /></div>
                        </>
                    )}

                    {vis.embedPrivateHosts && (
                        <BoundSwitch
                            name="Also Wrap Private Host Links"
                            description="Also wrap video links from Zipline, S3, WebDAV and custom uploaders. Links with a query string, http links and links on your network stay plain."
                            setting="embedProxyPrivateHosts"
                            update={update}
                        />
                    )}

                    {vis.embedSkipNative && (
                        <SettingSwitch
                            name="Skip When Discord Can Embed"
                            description={`Post small direct videos (up to ${formatSize(NATIVE_EMBED_MAX)}) from Catbox, Litterbox, 0x0.st and similar as they are, so Discord plays them itself.`}
                            checked={skip}
                            onChange={v => {
                                store.embedSkipNative = v;
                                update();
                            }}
                        />
                    )}

                    {vis.embedHealth && target && (
                        <SettingsSection id="embed-proxy-health" name="Embed Service Status" description={embedHealthText(target)}>
                            <div className={cl("actions")}>
                                <Button size="small" onClick={() => checkEmbedNow()}>Check now</Button>
                            </div>
                        </SettingsSection>
                    )}
                </Sub>
            )}
        </>
    );
}

function s3AnonymousReadText(endpoint: string | undefined): string {
    const value = endpoint?.trim() ?? "";
    const https = value === "" || (URL.canParse(value) && new URL(value).protocol === "https:");
    const checked = https && canCheckS3PublicRead();
    return `Without a Public Base URL, links work only if your bucket allows anonymous reads.${checked ? " BigFileUpload checks that once per bucket per session, after an upload, and warns if it doesn't." : ""}`;
}

function endpointHostText(endpoint: string | undefined): string {
    const value = endpoint?.trim() ?? "";
    return URL.canParse(value) && new URL(value).host ? new URL(value).host : "your endpoint";
}

function PrivateHostWrapNote({ service }: { service: ServiceType; }) {
    const { s3PublicUrl, webdavServerType, webdavUrl } = settings.store;
    const target = embedTarget();
    if (!target) return null;
    if (service === ServiceType.S3 && !s3PublicUrl?.trim()) return <div className={cl("host-note")}>Video links from this host are posted plain until you set a Public Base URL.</div>;
    if (service === ServiceType.WEBDAV && !isGenericWebdav(webdavServerType, webdavUrl)) return <div className={cl("host-note")}>Video links from this server are posted plain: its share links don't end in the file's name.</div>;
    return <div className={cl("host-note")}>Video links from this host are wrapped through {embedTargetLabel(target)} (Also Wrap Private Host Links is on).</div>;
}

function onRadioKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const { key } = event;
    const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
    const next = key === "Home" ? 0 : key === "End" ? buttons.length - 1 : direction ? (current + direction + buttons.length) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
}

export function CorsProxyPicker({ update }: { update(): void; }) {
    const store = settings.use(["corsProxyUrl", "corsProxyCustomUrl", "corsProxyNoRedirects", "corsProxyNoRedirectsFor", "embedProxyEnabled", "embedProxyService", "embedUseCustomProxy", "embedCustomProxyFor", "disableCorsProxy"]);
    const stored = (store.corsProxyUrl ?? "").trim();
    const [ownChosen, setOwnChosen] = React.useState(false);
    const [draft, setDraft] = React.useState<string | null>(null);
    const draftRef = React.useRef<string | null>(null);
    draftRef.current = draft;
    const own = ownChosen || isCustomValue(stored);
    const text = draft ?? (isCustomValue(stored) ? stored : "");
    const vis = useVisibility({ own, draft: text, committed: stored });
    const problem = vis.pickerProblemNote ? proxyAddressProblem(text) : null;
    const noRedirects = redirectTickFor(text.trim());
    const template = vis.pickerPrefixNote ? parseProxyTemplate(text) : null;
    const prefix = template && "prefix" in template ? template.prefix : null;

    React.useEffect(() => () => {
        const next = draftRef.current?.trim();
        const current = (settings.store.corsProxyUrl ?? "").trim();
        if (next == null || proxyCommitOpen || next === current || proxyKey(next) == null || isPresetProxy(next) || needsProxyQuestion(next)) return;
        setProxyUrlHere(next);
        rememberCustomProxy(current, next);
    }, []);

    const writePreset = (url: string) => {
        if (proxyCommitOpen) return;
        const previous = stored;
        if (!isCustomValue(previous)) {
            setOwnChosen(false);
            setDraft(null);
            return;
        }
        proxyCommitOpen = true;
        void confirmProxyChange(url)
            .then(confirmed => {
                if (!confirmed) return;
                rememberCustomProxy(previous, url);
                setProxyUrlHere(url);
                setOwnChosen(false);
                setDraft(null);
                update();
            })
            .finally(() => { proxyCommitOpen = false; });
    };

    const chooseOwn = () => {
        if (own) return;
        setOwnChosen(true);
        const saved = (store.corsProxyCustomUrl ?? "").trim();
        if (proxyKey(saved) == null || isPresetProxy(saved)) {
            setDraft(saved);
            return;
        }
        setDraft(null);
        const { ask, dueBefore } = restoreProxyUrlHere(saved);
        update();
        if (!ask || proxyCommitOpen) return;
        proxyCommitOpen = true;
        void confirmRestoredProxyChange(saved)
            .then(confirmed => { if (confirmed) confirmRestoredProxy(dueBefore); })
            .finally(() => { proxyCommitOpen = false; });
    };

    const commit = () => {
        if (draft === null || proxyCommitOpen) return;
        const next = draft.trim();
        if (next === stored) return setDraft(null);
        if (proxyKey(next) == null) return;
        if (isPresetProxy(next)) return writePreset(findProxyPreset(next)!.url);
        proxyCommitOpen = true;
        void confirmProxyChange(next)
            .then(confirmed => {
                if (confirmed) {
                    setProxyUrlHere(next);
                    rememberCustomProxy(stored, next);
                }
                setDraft(null);
                update();
            })
            .finally(() => { proxyCommitOpen = false; });
    };

    const selectedPreset = own ? null : findProxyPreset(stored);
    const inUse = proxyInvalid() ? null : getActiveCorsProxyUrl();

    return (
        <div className={cl("group")}>
            <div className={cl("service-grid")} role="radiogroup" aria-label="CORS proxy" onKeyDown={onRadioKeyDown}>
                {CORS_PROXY_PRESETS.map(p => (
                    <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={selectedPreset?.id === p.id}
                        tabIndex={selectedPreset?.id === p.id || (!own && !selectedPreset && p === CORS_PROXY_PRESETS[0]) ? 0 : -1}
                        className={cl("service-option")}
                        data-selected={selectedPreset?.id === p.id}
                        onClick={() => writePreset(p.url)}
                    >
                        <span className={cl("service-option-label")}>{p.id === "default" ? `Default: ${p.host}, run by ${p.operator}` : `${p.host}, run by ${p.operator}`}</span>
                    </button>
                ))}
                <button
                    type="button"
                    role="radio"
                    aria-checked={own}
                    tabIndex={own ? 0 : -1}
                    className={cl("service-option")}
                    data-selected={own}
                    onClick={chooseOwn}
                >
                    <span className={cl("service-option-label")}>Your own proxy (self-hosted)…</span>
                </button>
            </div>
            {inUse != null && inUse !== "none" && !(own && findProxyPreset(inUse)) && <ProxyOperatorLine url={inUse} />}
            {vis.pickerField && (
                <Sub>
                    <SettingTextInput
                        name="Your proxy's address"
                        description="For example https://proxy.example/cors, or https://proxy.example/{url} for a prefix-style proxy such as cors-anywhere."
                        value={text}
                        onChange={setDraft}
                        onCommit={commit}
                        placeholder="https://proxy.example/cors"
                    />
                    {vis.pickerBlankNote && <div className={cl("host-note")}>Enter your proxy's address. The previous proxy stays in use until then.</div>}
                    {problem != null && <div className={cl("host-note")}>{problem}; the previous proxy stays in use.</div>}
                    {prefix != null && <div className={cl("host-note")}>Prefix-style proxy: BigFileUpload puts the target address right after <code>{prefix}</code>. It must answer HEAD with CORS headers (the video check uses it) and accept requests that carry no Origin header (the desktop retry sends none). See the guide. A proxy on your own server can reach that server's private network and cloud metadata. Block them as the guide shows. Update BigFileUpload on every device that shares these settings first: older versions can't upload through this form, and they post broken video links.</div>}
                    {vis.pickerRedirectTick && (
                        <SettingSwitch
                            name="My Proxy Passes Redirects Back Unchanged"
                            description="Tick only if your proxy hands redirects back untouched. cors-anywhere doesn't."
                            checked={noRedirects}
                            onChange={v => setRedirectTick(text.trim(), v)}
                        />
                    )}
                    {vis.pickerVideoNote && <div className={cl("host-note")}>{customVideoNote(stored)}</div>}
                    {vis.pickerAddressLine && <div className={cl("host-note")}>{`Your proxy's address (${proxyAddressText(stored)}) appears in every video link you post. Anyone who sees it can use your proxy and spend its quota.`}</div>}
                    <div className={cl("host-note")}>
                        <ProxyGuideLink label="How to run your own proxy (self-host guide)" />
                    </div>
                </Sub>
            )}
        </div>
    );
}

function ProxyCredentialWarning({ service }: { service: ServiceType; }) {
    const text = proxyCredentialWarning(service);
    return text ? <div className={cl("host-note")}>{text} <ProxyGuideLink /></div> : null;
}

function CorsProxySettings({ update, vis }: { update: () => void; vis: Visibility; }) {
    const allowed = proxyAllowedHere();
    const description = IS_WEB
        ? `Relays uploads to hosts that block discord.com. Without it, only ${DIRECT_WEB_HOSTS} and your own servers that allow discord.com work.`
        : "Retries a host your network blocks once through the proxy, within its size limit. Hosts that need a login ask first.";
    React.useEffect(() => { noticeProxyChange(); }, []);

    return (
        <>
            <SettingSwitch
                name="Use CORS Proxy"
                description={description}
                checked={allowed}
                onChange={v => {
                    answerProxyHere(v);
                    update();
                }}
            />
            {(vis.proxyInvalidNote || vis.proxyDeclinedHere) && (
                <Sub>
                    {vis.proxyInvalidNote && <div className={cl("host-note")}>The CORS proxy address in settings is invalid{proxyInvalidReason() ? ` (${proxyInvalidReason()})` : ""}, so the CORS proxy is off. Fix it, or choose the default.</div>}
                    {vis.proxyDeclinedHere && <div className={cl("host-note")}>Declined on this device</div>}
                </Sub>
            )}
            {vis.nativeHelperWarning && <div className={cl("host-note")}>BigFileUpload's native helper is not loaded. Fully restart the app.</div>}

            <SettingsSection id="cors-proxy-picker" name="CORS Proxy" description={`Which proxy relays uploads that need one.${proxyLimitNote()}${vis.proxyOffCaption ? " Used when the CORS proxy is on." : ""}`}>
                <CorsProxyPicker update={update} />
            </SettingsSection>
            {vis.proxyCredentialWarning && <div className={cl("host-note")}>{proxyCredentialWarning()} <ProxyGuideLink /></div>}
        </>
    );
}

const proxyKeyHost = (key: string) => key.split("/", 1)[0];

function ProxyRetryChoices() {
    const { always, lan } = useAlwaysOrigins();
    const byProxy = new Map<string, AlwaysOrigin[]>();
    for (const entry of always) byProxy.set(proxyKeyHost(entry.proxy), [...byProxy.get(proxyKeyHost(entry.proxy)) ?? [], entry]);
    return (
        <SettingsSection id="proxy-retry-choices" name={"Always-Retry Choices"} description="Hosts this device retries through the proxy without asking, and your own servers seen on your network. This device only.">
            {[...byProxy].map(([proxyHost, entries]) => (
                <React.Fragment key={proxyHost}>
                    <div className={cl("host-note")}>{`Through ${proxyHost}`}</div>
                    {entries.map(e => (
                        <div key={`${e.service} ${e.origin} ${e.proxy} ${e.acceptId}`} className={cl("secret-row")}>
                            <div className={cl("secret-input")}>{`${serviceLabel(e.service)}: ${e.origin}`}</div>
                            <Button size="small" onClick={() => removeAlwaysOrigin(e)}>Remove</Button>
                        </div>
                    ))}
                </React.Fragment>
            ))}
            {lan.length > 0 && <div className={cl("host-note")}>Seen on your own network (never sent through the proxy)</div>}
            {lan.map(origin => (
                <div key={origin} className={cl("secret-row")}>
                    <div className={cl("secret-input")}>{origin}</div>
                    <Button size="small" onClick={() => forgetLanOrigin(origin)}>Remove</Button>
                </div>
            ))}
            <div className={cl("actions")}>
                <Button size="small" onClick={forgetProxyOrigins}>Forget all</Button>
            </div>
        </SettingsSection>
    );
}

function InsecureHttpChoices() {
    const entries = insecureHttpEntries();
    return (
        <SettingsSection id="insecure-http-choices" name="Allow Insecure HTTP" description="Servers this device may reach over plain http outside your network.">
            {entries.map(e => (
                <div key={`${e.service} ${e.origin}`} className={cl("secret-row")}>
                    <div className={cl("secret-input")}>{`${serviceLabel(e.service)}: ${e.origin}`}</div>
                    <Button size="small" onClick={() => setInsecureHttp(e.service, e.origin, false)}>Remove</Button>
                </div>
            ))}
        </SettingsSection>
    );
}

const credentialList = (entries: readonly SavedCredential[]) => entries.map(e => `${serviceLabel(e.service)} (${e.names.join(", ")})`).join(", ");

function SavedCredentials({ vis, update }: { vis: Visibility; update: () => void; }) {
    const store = settings.store as unknown as Record<string, unknown>;
    const clear = (entry: SavedCredential) => {
        const run = () => {
            for (const key of entry.keys) store[key] = "";
            update();
        };
        if (entry.service !== ServiceType.SHAREX) return run();
        try {
            void askToUseHost({
                title: "Clear the custom uploader?",
                question: "This removes the whole ShareX config (address, headers and fields) from every device that syncs these settings.",
                confirmText: "Clear",
                cancelText: "Cancel"
            }).answer.then(ok => { if (ok) run(); });
        } catch (error) {
            logger.error("Couldn't ask before clearing the ShareX config", error);
        }
    };
    const howToUse = settings.store.disableFallbacks ? "Select one above to use it" : "Turn a host on under Fallback Order to use it";
    return (
        <>
            {vis.unusedCredentials.length > 0 && (
                <SettingsSection
                    id="saved-credentials"
                    name="Saved Credentials"
                    description={`Credentials for hosts BigFileUpload isn't using: ${credentialList(vis.unusedCredentials)}. They still sync and export. ${howToUse}, or clear them on every device.`}
                >
                    {vis.unusedCredentials.map(e => (
                        <div key={e.service} className={cl("secret-row")}>
                            <div className={cl("secret-input")}>{`${serviceLabel(e.service)} (${e.names.join(", ")})${e.service === ServiceType.SHAREX ? ": Clear removes the whole config" : ""}`}</div>
                            <Button size="small" onClick={() => clear(e)}>Clear</Button>
                        </div>
                    ))}
                </SettingsSection>
            )}
            {vis.elsewhereCredentials.length > 0 && <div className={cl("host-note")}>{`Used on your other devices, not usable here: ${credentialList(vis.elsewhereCredentials)}`}</div>}
        </>
    );
}

function ApprovedServers() {
    const [origins, setOrigins] = React.useState<string[] | null>(null);
    const load = () => void listApprovedServers().then(setOrigins);
    React.useEffect(load, []);
    if (!origins?.length) return null;
    const reset = async () => {
        showToast(await resetApprovedServers() ? { text: "Approved servers reset", variant: "success" } : { text: "Couldn't reset the approved servers", variant: "critical" });
        load();
    };
    return (
        <SettingsSection id="approved-servers" name="Approved Servers" description="Your own servers this device trusts for uploads. Built-in hosts never ask.">
            {origins.map(origin => (
                <div key={origin} className={cl("secret-row")}>
                    <div className={cl("secret-input")}>{origin}</div>
                </div>
            ))}
            <div className={cl("actions")}>
                <Button size="small" onClick={() => void reset()}>Reset Approved Servers</Button>
            </div>
        </SettingsSection>
    );
}

function needsProxyText(): string {
    const o = webDeclineOutlook();
    const needs = `${serviceLabel(o.primary)} needs the CORS proxy on Vencord Web`;
    switch (o.variant) {
        case "disabled":
            return `${needs}, and fallback hosts are disabled, so files over Discord's limit are left to Discord. Accept the CORS proxy, or turn off Disable Fallback Hosts.`;
        case "confidential":
            return `${needs}. Its links carry the decryption key, so BigFileUpload never moves its files to an unencrypted public host by itself. Files over Discord's limit are left to Discord unless an active private host can take them. Accept the CORS proxy, or choose another upload host.`;
        case "none": {
            const tried = o.userHost ? ` (${serviceLabel(o.userHost)} is tried directly and works only if its server allows discord.com)` : "";
            return `${needs}. None of your active fallback hosts is known to work without it${tried}, so files over Discord's limit are left to Discord${o.suggestPublic ? `. Turn on ${directWebHostNames("or")} under Fallback Order` : ""}.`;
        }
        default: {
            const host = o.host!;
            const retention = hostRetention(host);
            const first = o.userHost ? ` ${serviceLabel(o.userHost)} is tried first, directly, and works only if its server allows discord.com.` : "";
            return `${needs}. Uploads go to ${serviceLabel(host)}${retention ? ` (${retention})` : ""} instead.${first}`;
        }
    }
}

function UploadServiceGroup({ update }: { update: () => void; }) {
    const { store } = settings;
    const vis = useVisibility();

    return (
        <SettingsSection id="upload-service" name="Upload Service" description="Choose where BigFileUpload sends new files.">
            <ServicePicker
                value={store.serviceType as ServiceType}
                onChange={service => {
                    store.serviceType = service;
                    update();
                }}
            />
            {vis.needsProxyNote && <div className={cl("host-note")}>{needsProxyText()}</div>}
            {vis.savedCredentials && <SavedCredentials vis={vis} update={update} />}
            {!IS_WEB && <ApprovedServers />}
        </SettingsSection>
    );
}

function FallbackControls({ update }: { update: () => void; }) {
    const { store } = settings;
    const vis = useVisibility();

    return (
        <>
            <BoundSwitch
                name="Disable Fallback Hosts"
                description="Only use the selected host."
                setting="disableFallbacks"
                update={update}
            />
            {vis.primaryFailureMode && (
                <Sub>
                    <SettingsSection id="primary-failure-mode" name="When the Selected Host Fails" description="Files for a private host (Zipline, S3, WebDAV, a custom uploader) or Encrypting.host only fall back to your other private hosts. Always ask confirms every other host first.">
                        <Select
                            options={primaryFailureOptions}
                            isSelected={v => v === (store.primaryFailureMode === "ask" ? "ask" : "auto")}
                            select={v => {
                                store.primaryFailureMode = v;
                                update();
                            }}
                            serialize={v => v}
                        />
                    </SettingsSection>
                </Sub>
            )}
        </>
    );
}

function HostSection({ service, update }: { service: ServiceType; update: () => void; }) {
    const { store } = settings;
    const vis = useVisibility();
    const rows = vis.hostRows[service] ?? NO_ROWS;
    const missing = rows.missingNote ? credentialMessages(service) : [];
    const note = missing.length ? <div className={cl("host-note")}>{`${missing.join("; ")}. Until then it is skipped.`}</div> : null;
    const wrapNote = rows.privateWrapNote && <PrivateHostWrapNote service={service} />;
    const credentialWarning = rows.credentialWarning && <ProxyCredentialWarning service={service} />;

    switch (service) {
        case ServiceType.ZIPLINE: return (
            <SettingGroup name="Zipline" description={"Connection details for your Zipline instance."}>
                {note}
                {wrapNote}
                {credentialWarning}
                <BoundTextInput
                    name="Service URL"
                    description="The URL of your Zipline instance"
                    setting="serviceUrl"
                    update={update}
                    placeholder="https://your-zipline-instance.com"
                    validate={v => endpointUrlProblem(v, httpRule(ServiceType.ZIPLINE, rows))}
                />
                <InsecureHttpSettings service={ServiceType.ZIPLINE} url={store.serviceUrl} rows={rows} />
                <BoundTextInput
                    name="Zipline Token"
                    description="Your Zipline API authorization token"
                    setting="ziplineToken"
                    placeholder="Your Zipline API token"
                    secret
                />
                <BoundTextInput
                    name="Folder ID"
                    description="Folder ID for uploads (leave empty for no folder)"
                    setting="folderId"
                    placeholder="Leave empty for no folder"
                />
            </SettingGroup>
        );
        case ServiceType.EZHOST: return (
            <SettingGroup name="E-Z Host" description={"Connection details for E-Z Host uploads."}>
                {note}
                {credentialWarning}
                <BoundTextInput
                    name="E-Z Host API Key"
                    description="Your E-Z Host API key"
                    setting="ezHostKey"
                    placeholder="Your E-Z Host API key"
                    secret
                />
            </SettingGroup>
        );
        case ServiceType.NEST: return (
            <SettingGroup name="Nest" description={"Connection details for Nest uploads."}>
                {note}
                {credentialWarning}
                <BoundTextInput
                    name="Nest Token"
                    description="Your Nest API authorization token"
                    setting="nestToken"
                    placeholder="Your Nest API token"
                    secret
                />
            </SettingGroup>
        );
        case ServiceType.ENCRYPTINGHOST: return (
            <SettingGroup name="Encrypting.host" description={"Connection details for Encrypting.host uploads."}>
                {note}
                {credentialWarning}
                <BoundTextInput
                    name="Encrypting.host API Key"
                    description="Your Encrypting.host API key"
                    setting="encryptingHostKey"
                    placeholder="Your Encrypting.host API key"
                    secret
                />
                <SettingTextArea
                    id="domains-json"
                    name="Domains JSON"
                    description={"JSON array of domains or categories (normal, offensive, sad, weeb). Blank means [\"normal\"], and [\"\"] uses every domain."}
                    value={store.encryptingHostDomains || ""}
                    rows={3}
                    placeholder='["normal"]'
                    onChange={v => store.encryptingHostDomains = v}
                    validate={domainsProblem}
                />
                <SettingsSection id="url-style" name="URL Style" description="How links are formatted. Zero-width hides the decryption key in invisible characters.">
                    <Select
                        options={encryptingHostUrlStyleOptions}
                        isSelected={v => v === store.encryptingHostUrlStyle}
                        select={v => {
                            store.encryptingHostUrlStyle = v;
                            update();
                        }}
                        serialize={v => v}
                        placeholder="Select URL style"
                    />
                </SettingsSection>
                {(vis.encryptingHostTitle || vis.encryptingHostColor || vis.encryptingHostFakelink) && (
                    <Sub>
                        {vis.encryptingHostTitle && (
                            <BoundTextInput
                                name="Embed Title"
                                description="Optional title for the Embed and Zero-width (zws) styles."
                                setting="encryptingHostTitle"
                                placeholder="Optional title"
                            />
                        )}
                        {vis.encryptingHostColor && (
                            <BoundTextInput
                                name="Embed Color"
                                description="Optional color for the Embed style."
                                setting="encryptingHostColor"
                                placeholder="#5865F2"
                                validate={hexColorProblem}
                            />
                        )}
                        {vis.encryptingHostFakelink && (
                            <BoundTextInput
                                name="Fake Link"
                                description="Optional fake link value for fakelink style responses."
                                setting="encryptingHostFakelink"
                                placeholder="Optional fake link"
                            />
                        )}
                    </Sub>
                )}
            </SettingGroup>
        );
        case ServiceType.S3: return (
            <SettingGroup name="S3-Compatible Storage" description={"Connection details and object naming for your bucket."}>
                {note}
                {wrapNote}
                {credentialWarning}
                <BoundTextInput
                    name="S3 Endpoint URL"
                    description="For example https://<accountid>.r2.cloudflarestorage.com."
                    setting="s3Endpoint"
                    update={update}
                    placeholder="https://your-endpoint.example.com"
                    validate={v => endpointUrlProblem(v, httpRule(ServiceType.S3, rows), { userInfo: false })}
                />
                <InsecureHttpSettings service={ServiceType.S3} url={store.s3Endpoint} rows={rows} />
                {vis.s3SignPayload && (
                    <Sub>
                        <BoundSwitch
                            name="Sign Payload"
                            description="Hash and sign each file. Slower for big files. Only for servers that refuse unsigned uploads."
                            setting="s3SignPayload"
                        />
                    </Sub>
                )}
                <BoundTextInput
                    name="Bucket Name"
                    description="Bucket to upload into"
                    setting="s3Bucket"
                    placeholder="my-bucket"
                />
                <BoundTextInput
                    name="Region"
                    description="AWS region or auto for Cloudflare R2"
                    setting="s3Region"
                    placeholder="auto"
                />
                <BoundTextInput
                    name="Access Key ID"
                    description="S3-compatible access key"
                    setting="s3AccessKeyId"
                    placeholder="Your access key ID"
                    secret
                />
                <BoundTextInput
                    name="Secret Access Key"
                    description="S3-compatible secret key"
                    setting="s3SecretAccessKey"
                    placeholder="Your secret access key"
                    secret
                />
                <BoundTextInput
                    name="Session Token"
                    description="Optional temporary credential token"
                    setting="s3SessionToken"
                    placeholder="Optional session token"
                    secret
                />
                <BoundTextInput
                    name="Public Base URL"
                    description="Optional public URL base to use for returned links"
                    setting="s3PublicUrl"
                    update={update}
                    placeholder="https://cdn.example.com"
                    validate={linkBaseProblem}
                />
                {vis.s3R2Note && (
                    <Sub>
                        <div className={cl("host-note")}>Cloudflare R2 needs a Public Base URL: links to R2's own object URLs don't open without a signature. Use the bucket's r2.dev address or a custom domain. Until then S3 is skipped.</div>
                    </Sub>
                )}
                {vis.s3AnonymousReadNote && (
                    <Sub>
                        <div className={cl("host-note")}>{s3AnonymousReadText(store.s3Endpoint)}</div>
                    </Sub>
                )}
                <BoundTextInput
                    name="Object Key Prefix"
                    description="Optional folder/prefix inside the bucket"
                    setting="s3Prefix"
                    placeholder="uploads/discord"
                />
                <BoundSwitch
                    name="Use Path-Style Endpoint"
                    description="Use endpoint/bucket/key format, recommended for R2."
                    setting="s3ForcePathStyle"
                />
                {vis.s3DottedBucketNote && (
                    <Sub>
                        <div className={cl("host-note")}>A bucket name with dots doesn't work without path-style over https: its address ({store.s3Bucket}.{endpointHostText(store.s3Endpoint)}) doesn't match the server's certificate, so uploads fail. Turn on Use Path-Style Endpoint, or use a bucket without dots.</div>
                    </Sub>
                )}
                {vis.s3MultipartNote && (
                    <div className={cl("host-note")}>
                        Uploads over 5 GB, and uploads through the CORS proxy above its size limit, use multipart. They need <code>ExposeHeaders: ETag</code> and the <code>DELETE</code> method in your bucket's CORS rules. Add a lifecycle rule that aborts incomplete multipart uploads after a day.
                    </div>
                )}
            </SettingGroup>
        );
        case ServiceType.CATBOX: return (
            <SettingGroup name="Catbox" description="Optional. Uploads with your userhash go to your Catbox account.">
                {note}
                {credentialWarning}
                <BoundTextInput
                    name="Catbox Userhash"
                    description="Leave empty for anonymous uploads."
                    setting="catboxUserhash"
                    placeholder="Your Catbox userhash"
                    secret
                />
            </SettingGroup>
        );
        case ServiceType.LITTERBOX: return (
            <SettingGroup name="Litterbox" description="Temporary uploads.">
                {note}
                <SettingsSection id="litterbox-expiry" name="Retention Window" description="How long Litterbox keeps uploads.">
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
                <SettingsSection id="litterbox-name-length" name="File Name Length" description="Longer links are harder to guess.">
                    <Select
                        options={litterboxNameOptions}
                        isSelected={v => v === (store.litterboxFileNameLength === "16" ? "16" : "default")}
                        select={v => {
                            store.litterboxFileNameLength = v;
                            update();
                        }}
                        serialize={v => v}
                    />
                </SettingsSection>
            </SettingGroup>
        );
        case ServiceType.ZEROX0: return vis.zeroX0Options ? (
            <SettingGroup name="0x0.st" description="Anyone with a link can open the file.">
                <BoundSwitch
                    name="Hard-to-Guess Links"
                    description="Ask 0x0.st for longer links that can't be guessed."
                    setting="zeroX0Secret"
                    update={update}
                />
                <SettingsSection id="zerox0-expiry" name="Delete After" description="0x0.st deletes the file by this time at the latest.">
                    <Select
                        options={zeroX0ExpiryOptions}
                        isSelected={v => v === (Object.hasOwn(ZEROX0_KEPT, store.zeroX0Expiry ?? "") ? store.zeroX0Expiry : "default")}
                        select={v => {
                            store.zeroX0Expiry = v;
                            update();
                        }}
                        serialize={v => v}
                    />
                </SettingsSection>
            </SettingGroup>
        ) : null;
        case ServiceType.TMPFILES: return (
            <SettingGroup name="tmpfiles.org" description="Temporary uploads.">
                {note}
                <SettingsSection id="tmpfiles-expiry" name="Retention Window" description="How long tmpfiles.org keeps uploads.">
                    <Select
                        options={tmpfilesExpiryOptions}
                        isSelected={v => v === (Object.hasOwn(TMPFILES_KEPT, store.tmpfilesExpiry ?? "") ? store.tmpfilesExpiry : "default")}
                        select={v => {
                            store.tmpfilesExpiry = v;
                            update();
                        }}
                        serialize={v => v}
                    />
                </SettingsSection>
            </SettingGroup>
        );
        case ServiceType.GOFILE: return (
            <SettingGroup name="GoFile" description="Optional. Uploads with your token go to your GoFile account.">
                {note}
                <BoundTextInput
                    name="GoFile Token"
                    description="Leave empty for anonymous uploads."
                    setting="gofileToken"
                    update={update}
                    placeholder="Optional GoFile token"
                    secret
                />
                {vis.gofileGuestReuse && (
                    <Sub>
                        <BoundSwitch
                            name="Reuse One Guest Account"
                            description="Reuse one guest account for anonymous uploads instead of a new one each time. Those uploads are then linked to each other."
                            setting="gofileReuseGuestToken"
                            update={update}
                        />
                        {vis.gofileGuestSync && (
                            <SettingSwitch
                                name="Sync GoFile Guest Token Across Devices"
                                description="Save the guest token with your settings so your other devices use the same guest account. Off: it stays on this device."
                                checked={gofileGuestSynced()}
                                onChange={v => void setGofileGuestSync(v).then(update)}
                            />
                        )}
                    </Sub>
                )}
                {vis.gofileGuestReset && (
                    <SettingsSection id="gofile-guest-reset" name="Guest Account" description="Forget the guest token. The next anonymous upload starts a new guest account.">
                        <Button
                            size="small"
                            onClick={() => void resetGofileGuestToken().then(() => {
                                update();
                                showToast({ text: "GoFile guest token reset", variant: "success" });
                            })}
                        >
                            Reset guest token
                        </Button>
                    </SettingsSection>
                )}
            </SettingGroup>
        );
        case ServiceType.PIXELVAULT: return (
            <SettingGroup name="PixelVault" description={"Connection details for PixelVault uploads."}>
                {note}
                {credentialWarning}
                <BoundTextInput
                    name="PixelVault Upload Key"
                    description="Your PixelVault authorization key."
                    setting="pixelVaultKey"
                    placeholder="Your PixelVault upload key"
                    secret
                />
            </SettingGroup>
        );
        case ServiceType.PIXELDRAIN: return (
            <SettingGroup name="PixelDrain" description="PixelDrain needs an API key.">
                {note}
                {credentialWarning}
                <BoundTextInput
                    name="PixelDrain API Key"
                    description="From pixeldrain.com/user/api_keys."
                    setting="pixelDrainKey"
                    placeholder="Your PixelDrain API key"
                    secret
                />
            </SettingGroup>
        );
        case ServiceType.SHAREX: return <ShareXSection update={update} note={note} rows={rows} vis={vis} />;
        case ServiceType.WEBDAV: return (
            <SettingGroup name="WebDAV" description={"Connection details for WebDAV servers (Nextcloud, ownCloud and others)."}>
                {note}
                {wrapNote}
                {credentialWarning}
                <BoundTextInput
                    name="Server URL"
                    description="Base WebDAV URL (e.g. https://nextcloud.example.com/remote.php/dav/files/username)"
                    setting="webdavUrl"
                    update={update}
                    placeholder="https://nextcloud.example.com/remote.php/dav/files/username"
                    validate={v => endpointUrlProblem(v, httpRule(ServiceType.WEBDAV, rows))}
                />
                <InsecureHttpSettings service={ServiceType.WEBDAV} url={store.webdavUrl} rows={rows} />
                <BoundTextInput
                    name="Username"
                    description="WebDAV username"
                    setting="webdavUsername"
                    placeholder="username"
                />
                <BoundTextInput
                    name="Password or App Token"
                    description="WebDAV password or app token"
                    setting="webdavPassword"
                    placeholder="password or app token"
                    secret
                />
                <BoundTextInput
                    name="Upload Directory"
                    description="Optional subdirectory on the server to upload into (e.g. uploads)"
                    setting="webdavDirectory"
                    placeholder="Leave empty for root directory"
                />
                <SettingsSection id="server-type" name="Server Type" description="Nextcloud and ownCloud create a public share link. Generic posts the file's own URL, as does any URL without /remote.php/.">
                    <Select
                        options={webdavServerTypeOptions}
                        isSelected={v => v === store.webdavServerType}
                        select={v => {
                            store.webdavServerType = v;
                            update();
                        }}
                        serialize={v => v}
                        placeholder="Select server type"
                    />
                </SettingsSection>
                {vis.webdavShareLinkFormat && (
                    <Sub>
                        <SettingsSection id="share-link-format" name="Share Link Format" description="Share Page links to a web page, Direct Download to the file, Markdown Link to a clickable file name.">
                            <Select
                                options={webdavShareTypeOptions}
                                isSelected={v => v === store.webdavShareType}
                                select={v => {
                                    store.webdavShareType = v;
                                    update();
                                }}
                                serialize={v => v}
                                placeholder="Select share link format"
                            />
                        </SettingsSection>
                    </Sub>
                )}
                {vis.webdavGenericNote && (
                    <Sub>
                        <div className={cl("host-note")}>Detected a generic WebDAV server: the plain file URL is used.</div>
                    </Sub>
                )}
            </SettingGroup>
        );
        default: return null;
    }
}

function UploadBehaviorGroup({ update }: { update: () => void; }) {
    const { store } = settings;
    const vis = useVisibility();

    return (
        <SettingGroup name="Upload Behavior" description="What happens to uploads and their links.">
            <BoundSwitch
                name="Insert URL into Chatbox"
                description="Insert the link into the chatbox."
                setting="autoSend"
                update={update}
            />
            {vis.sendImmediately && (
                <Sub>
                    <BoundSwitch
                        name="Send Immediately"
                        description="Send the link as its own message. Forum posts, new threads and right-click uploads still insert it."
                        setting="sendImmediately"
                    />
                </Sub>
            )}

            <BoundSwitch
                name="Copy URL to Clipboard"
                description="Copy the link to the clipboard."
                setting="autoCopy"
            />

            <BoundSwitch
                name="Link as Filename"
                description="Insert the link as clickable text showing the file name. Copied links stay plain."
                setting="displayOriginalFilename"
                update={update}
            />

            {vis.preventEmbeds && (
                <Sub>
                    <BoundSwitch
                        name="Prevent Discord Embeds"
                        description="Wrap inserted links in angle brackets so Discord doesn't embed them."
                        setting="autoFormat"
                        update={update}
                    />
                </Sub>
            )}

            <BoundSwitch
                name="Convert APNG to GIF"
                description="Convert animated PNGs to GIF before uploading."
                setting="apngToGif"
            />

            <BoundSwitch
                name="Preserve Original Filename"
                description="Keep the original file name where the host allows it."
                setting="preserveOriginalFilename"
            />

            <SettingSwitch
                name="Strip Query Parameters"
                description="Remove query parameters from links. Encrypting.host links are never changed, since their query holds the decryption key."
                checked={store.stripQueryParams}
                onChange={v => {
                    if (v && typeof store.stripQueryMode !== "string") store.stripQueryMode = "tracking";
                    store.stripQueryParams = v;
                    update();
                }}
            />

            {vis.stripQueryMode && (
                <Sub>
                    <SettingsSection id="strip-query-mode" name="Which Parameters" description="Tracking parameters only removes utm_*, fbclid, si and similar, and leaves custom uploader links alone.">
                        <Select
                            options={stripQueryModeOptions}
                            isSelected={v => v === getStripQueryMode()}
                            select={v => {
                                store.stripQueryMode = v;
                                update();
                            }}
                            serialize={v => v}
                        />
                    </SettingsSection>
                </Sub>
            )}

            <EmbedProxySettings update={update} vis={vis} />
        </SettingGroup>
    );
}

function fileTypeFilterSummary(filter: FileTypeFilter | null): string {
    if (!filter) return "";
    const exts = (list: Iterable<string>) => listNames([...list].map(ext => "." + ext));
    if (!filter.allow.size) return `Handles every file except ${exts(filter.deny)} files.`;
    const allowed = [...filter.allow].filter(ext => !filter.deny.has(ext));
    return allowed.length ? `Handles only ${exts(allowed)} files.` : "Handles no files: every listed type is also excluded.";
}

function DiscordIntegrationGroup({ update }: { update: () => void; }) {
    const { store } = settings;
    const vis = useVisibility();

    return (
        <SettingGroup name="Discord Integration" description="When BigFileUpload takes over Discord's file handling.">
            <BoundSwitch
                name="Bypass Discord Upload Button"
                description="Take files added with the upload button."
                setting="bypassDiscordUpload"
                update={update}
            />

            <BoundSwitch
                name="Bypass Drag & Drop"
                description="Take files dropped into the chatbox."
                setting="bypassDragDrop"
                update={update}
            />

            <BoundSwitch
                name="Bypass Pasted Files"
                description="Take files pasted into the chatbox."
                setting="autoUploadPastedFiles"
                update={update}
            />

            {vis.respectLimit && (
                <>
                    <BoundSwitch
                        name="Respect Discord File Size Limit"
                        description="Only take files Discord would reject (20 MB free, 50 MB Nitro Basic, 500 MB to 1 GB Nitro, boosts included). Off: take every file."
                        setting="bypassDiscordUploadOnlyOverLimit"
                        update={update}
                    />

                    {(vis.manualLimit || vis.uploadWholeBatch || vis.skipDiscordGenerated) && (
                        <Sub>
                            {vis.manualLimit && <ManualLimitInput />}

                            {vis.uploadWholeBatch && (
                                <BoundSwitch
                                    name="Upload Whole Batch Externally"
                                    description="If some files are over the limit, upload the whole batch. Off: only those files are uploaded."
                                    setting="uploadWholeBatch"
                                />
                            )}

                            {vis.skipDiscordGenerated && (
                                <BoundSwitch
                                    name="Skip Discord-Generated Files"
                                    description="Leave message.txt, text sent as a file and clip shares to Discord unless they're over the limit."
                                    setting="skipDiscordGeneratedFiles"
                                />
                            )}
                        </Sub>
                    )}
                </>
            )}

            <BoundTextInput
                name="Allowed File Types"
                description="Extensions to handle, like png,jpg,mp4. Put ! before one to exclude it (!exe,!zip). Leave empty to handle every file."
                setting="uploadAllowedFileTypes"
                update={update}
                placeholder="png,jpg,mp4 or !exe,!zip"
            />
            {vis.allowedTypesSummary && <div className={cl("host-note")}>{fileTypeFilterSummary(parseFileTypeFilter(store.uploadAllowedFileTypes))}</div>}
        </SettingGroup>
    );
}

function NetworkGroup({ update }: { update: () => void; }) {
    const { store } = settings;
    const vis = useVisibility();

    return (
        <SettingGroup name="Network" description="Proxy and timeout settings.">
            <CorsProxySettings update={update} vis={vis} />

            {vis.proxyRetryChoices && <ProxyRetryChoices />}

            {vis.insecureHttpChoices && <InsecureHttpChoices />}

            <SettingsSection id="upload-timeout" name="Upload Timeout" description="Stop an upload that makes no progress for this long and try the next host.">
                <Select
                    options={uploadTimeoutOptions}
                    isSelected={v => v === snapToTimeoutOption(store.uploadTimeoutMs)}
                    select={v => {
                        store.uploadTimeoutMs = v;
                        update();
                    }}
                    serialize={v => v}
                    placeholder="Select timeout"
                />
            </SettingsSection>
        </SettingGroup>
    );
}

async function copyHistoryLink(url: string) {
    try {
        await copyToClipboard(url);
        showToast({ text: "Link copied", variant: "success" });
    } catch {
        showToast({ text: "Couldn't copy the link. Select it and copy it", variant: "critical" });
    }
}

async function removeFromHistory(id: string) {
    if (!await forgetHistoryEntry(id)) showToast({ text: "Couldn't save the upload history. The entry may come back after a restart", variant: "critical" });
}

function confirmDelete(e: HistoryEntry) {
    const label = serviceLabel(e.service);
    try {
        void askToUseHost({
            title: `Delete from ${label}?`,
            question: `Delete this file from ${label}? Links to it stop working.`,
            confirmText: "Delete",
            cancelText: "Cancel"
        }).answer.then(ok => {
            const current = ok ? historyEntry(e.id) : undefined;
            if (current) void deleteFromHistory(current);
        });
    } catch (error) {
        logger.error("Couldn't ask before deleting a file", error);
    }
}

function confirmClearHistory(count: number) {
    try {
        void askToUseHost({
            title: "Clear upload history?",
            question: `This forgets ${count === 1 ? "the upload" : `all ${count} uploads`} listed on this device. The files stay on their hosts, and BigFileUpload can no longer delete them: delete any you want gone first.`,
            confirmText: "Clear history",
            cancelText: "Cancel"
        }).answer.then(async ok => {
            if (ok && !await clearUploadHistory()) showToast({ text: "Couldn't save the upload history. It may come back after a restart", variant: "critical" });
        });
    } catch (error) {
        logger.error("Couldn't ask before clearing the upload history", error);
    }
}

function UploadHistoryGroup() {
    const vis = useVisibility();
    if (!vis.uploadHistory) return null;
    const entries = uploadHistory();
    return (
        <SettingGroup name="Upload History" description={`Your last ${MAX_HISTORY} uploads, on this device only. Delete removes the file from its host. Remove only forgets the entry.`}>
            {vis.clearHistory && (
                <div className={cl("actions")}>
                    <Button size="small" variant="dangerSecondary" onClick={() => confirmClearHistory(entries.length)}>Clear history</Button>
                </div>
            )}
            {entries.map(e => {
                const row = vis.historyRows[e.id] ?? "none";
                const label = serviceLabel(e.service);
                const facts = [label, formatSize(e.size), new Date(e.time).toLocaleString(), e.cancelled && "cancelled after upload", row === "anonymous" && "anonymous, no deletion"];
                const busy = isDeleting(e.id);
                return (
                    <div key={e.id} className={cl("secret-row", "history-row")}>
                        <div className={cl("secret-input")}>
                            <div className={cl("history-link")}>{e.url}</div>
                            <div className={cl("host-note")}>{facts.filter(Boolean).join(" · ")}</div>
                            {row === "problem" && <div className={cl("host-note")}>{deletionProblem(e)}</div>}
                        </div>
                        <Button size="small" onClick={() => void copyHistoryLink(e.url)}>Copy link</Button>
                        {vis.historyRemove && (
                            <Button size="small" variant="secondary" title="Forgets this entry on this device. The file stays on its host" onClick={() => void removeFromHistory(e.id)}>
                                Remove from history
                            </Button>
                        )}
                        {row === "delete" && (
                            <Button size="small" variant="dangerPrimary" disabled={busy} onClick={() => confirmDelete(e)}>
                                {busy ? "Deleting..." : `Delete from ${label}`}
                            </Button>
                        )}
                    </div>
                );
            })}
        </SettingGroup>
    );
}

export function SettingsComponent() {
    ensureMigrated();
    const update = useForceUpdater();
    const { store } = settings;

    return (
        <>
            <Guarded><UploadServiceGroup update={update} /></Guarded>
            <Guarded key={String(store.serviceType)}><HostSection service={store.serviceType as ServiceType} update={update} /></Guarded>
            <Guarded><FallbackControls update={update} /></Guarded>
            <Guarded><FallbackOrderGroup update={update} /></Guarded>
            <Guarded><FallbackHostSections update={update} /></Guarded>
            <Guarded><UploadBehaviorGroup update={update} /></Guarded>
            <Guarded><DiscordIntegrationGroup update={update} /></Guarded>
            <Guarded><NetworkGroup update={update} /></Guarded>
            <Guarded><UploadHistoryGroup /></Guarded>
        </>
    );
}

export const SETTINGS_VERSION = 1;

const BOOKKEEPING_KEYS = ["enabled", "settingsVersion", "corsPromptAnswer"];

const isExistingInstall = (raw: Record<string, unknown>) => Object.keys(raw).some(k => !BOOKKEEPING_KEYS.includes(k));

const V1_MARKER_KEY = "BigFileUpload_v1Done";

function readV1Marker(): string | null {
    try {
        return localStorage.getItem(V1_MARKER_KEY);
    } catch {
        return null;
    }
}

function writeV1Marker(value: "1" | "edited") {
    try {
        localStorage.setItem(V1_MARKER_KEY, value);
    } catch { }
}

export const markFallbackListEdited = () => writeV1Marker("edited");

export function withDeclaredDefaults(raw: Record<string, unknown>): CredentialValues {
    const values: Record<string, unknown> = { ...raw };
    for (const [key, def] of Object.entries(settings.def)) {
        if (values[key] === undefined && "default" in def) values[key] = def.default;
    }
    return values;
}

export interface FallbackStep {
    active: ServiceType[];
    write: boolean;
    notice?: string;
}

export function legacyFallbackStep(raw: Record<string, unknown>, marker: string | null): FallbackStep {
    const saved = typeof raw.fallbackOrder === "string" ? raw.fallbackOrder : undefined;
    const order = normalizeLegacyFallbackOrder(saved);
    const replacedEdits = marker === "edited";
    const values = withDeclaredDefaults(raw);
    const active = order.filter(s => !requiresCredentials(s) || (!replacedEdits && legacyConfigured(s, values)));
    const write = saved !== undefined || active.some(requiresCredentials);

    if (replacedEdits) {
        if (!order.some(s => requiresCredentials(s) && legacyConfigured(s, values))) return { active, write };
        return { active, write, notice: "BigFileUpload's settings were replaced by an older copy (another device on an older version, or an imported backup). Hosts that need credentials were turned off under Fallback Order. Turn on the ones you use." };
    }
    const kept = active.filter(s => requiresCredentials(s) && s !== raw.serviceType);
    if (!kept.length) return { active, write };
    return { active, write, notice: `Still used as fallback hosts after this update: ${kept.map(s => describeKeptHost(s, values)).join(", ")}. Turn off any you no longer use under Fallback Order.` };
}

export function videoLinkNotice(raw: Record<string, unknown>): string | null {
    if (raw.embedProxyEnabled === false) return null;
    const svc = raw.embedProxyService;
    if (svc === "autocompressor" || svc === "x266") return null;
    const url = typeof raw.corsProxyUrl === "string" ? raw.corsProxyUrl.trim() : "";
    const invalid = url !== "" && url !== "none" && proxyKey(url) === null;
    const custom = url !== "" && url !== "none" && !invalid && !isPresetProxy(url);
    if (custom) return "Video links now use autocompressor.net instead of your proxy. See Upload Behavior → Video Embed Proxy.";
    if (raw.disableCorsProxy === true || url === "none" || invalid) return "Video links now use autocompressor.net instead of the CORS proxy. See Upload Behavior → Video Embed Proxy.";
    return null;
}

let lastMigrated: object | undefined;

let versionNotices: string[] = [];

export function takeVersionNotices(): string[] {
    const notices = versionNotices;
    versionNotices = [];
    return notices;
}

export function migrateSettings(): boolean {
    const raw = settings.plain as Record<string, unknown>;
    const saved = raw.settingsVersion;
    const existing = isExistingInstall(raw);
    const from = typeof saved === "number" ? saved : existing ? 0 : SETTINGS_VERSION;
    const notices: string[] = [];
    let dirty = false;

    if (raw.embedProxyService === "nfp") {
        raw.embedProxyService = "cors";
        dirty = true;
        notices.push("discord.nfp.is no longer works, so Embed Proxy Service is now CORS Proxy.");
    }

    if (from < 1) {
        const old = raw.serviceType;
        if ((old === ServiceType.ZIPLINE && (!isFilled(raw.serviceUrl) || !isFilled(raw.ziplineToken)))
            || (old === ServiceType.PIXELDRAIN && !isFilled(raw.pixelDrainKey))) {
            raw.serviceType = ServiceType.CATBOX;
            notices.push(`${serviceLabel(old)} isn't configured, so uploads already went to fallback hosts (usually Catbox). Catbox is now the selected host.`);
        }

        if (typeof raw.fallbackActive !== "string") {
            const step = legacyFallbackStep(raw, readV1Marker());
            if (step.write) raw.fallbackActive = step.active.join(",");
            if (step.notice) notices.push(step.notice);
        }
        if (readV1Marker() == null) writeV1Marker("1");

        if (raw.stripQueryParams === true && typeof raw.stripQueryMode !== "string") raw.stripQueryMode = "all";

        const embedNotice = videoLinkNotice(raw);
        if (embedNotice) notices.push(embedNotice);
    }

    if (typeof saved !== "number" || saved < SETTINGS_VERSION) {
        raw.settingsVersion = SETTINGS_VERSION;
        dirty = true;
    }
    if (dirty) void VencordNative.settings.set(PlainSettings);

    if (notices.length) {
        showNotification({ title: "BigFileUpload updated", body: notices.join(" "), permanent: true });
        versionNotices = [...versionNotices, ...notices];
    }

    lastMigrated = raw;
    return typeof saved !== "number" && !existing;
}

export function ensureMigrated(): void {
    if (lastMigrated === undefined) return;
    const raw = settings.plain as Record<string, unknown> | undefined;
    if (raw == null || raw === lastMigrated || (typeof raw.settingsVersion === "number" && raw.settingsVersion >= SETTINGS_VERSION)) return;
    migrateSettings();
}

export function getStripQueryMode(): "all" | "tracking" {
    ensureMigrated();
    return settings.store.stripQueryMode === "tracking" ? "tracking" : "all";
}

export function pendingFallbackPreview(): ServiceType[] | null {
    const raw = settings.plain as Record<string, unknown> | undefined;
    if (raw == null || typeof raw.settingsVersion === "number" || typeof raw.fallbackActive === "string" || !isExistingInstall(raw)) return null;
    const step = legacyFallbackStep(raw, readV1Marker());
    return step.write || step.notice ? step.active : null;
}

export interface VisibilityStore {
    serviceType?: string;
    disableFallbacks?: boolean;
    autoSend?: boolean;
    autoFormat?: boolean;
    displayOriginalFilename?: boolean;
    stripQueryParams?: boolean;
    bypassDiscordUpload?: boolean;
    bypassDragDrop?: boolean;
    autoUploadPastedFiles?: boolean;
    bypassDiscordUploadOnlyOverLimit?: boolean;
    embedProxyEnabled?: boolean;
    embedProxyPrivateHosts?: boolean;
    embedUseCustomProxy?: boolean;
    embedCustomProxyFor?: string;
    encryptingHostUrlStyle?: string;
    s3Endpoint?: string;
    s3PublicUrl?: string;
    sharexFormView?: boolean;
    webdavServerType?: string;
    serviceUrl?: string;
    webdavUrl?: string;
    corsProxyUrl?: string;
    uploadAllowedFileTypes?: string;
    [key: string]: unknown;
}

export type EmbedServiceChoice = "cors" | "autocompressor" | "x266";

export interface HistoryFacts {
    id: string;
    deletable: boolean;
    anonymous: boolean;
    problem: string | null;
}

export type HistoryRow = "delete" | "problem" | "anonymous" | "none";

export interface VisibilityContext {
    store: VisibilityStore;
    isWeb: boolean;
    hasNativeHelper: boolean;
    proxyAllowedHere: boolean;
    proxySyncedOn: boolean;
    proxyPending: boolean;
    proxyAnswer: "accepted" | "declined" | "dismissed" | null;
    proxyInvalid: boolean;
    activeProxy: string;
    embedService: EmbedServiceChoice;
    embedStrictPending: boolean;
    embedHasTarget: boolean;
    corsProxyWrapsVideo: boolean;
    s3Proxied: boolean;
    isHostConfigured(service: ServiceType): boolean;
    isUsableHere(service: ServiceType): boolean;
    carriesCredential(service: ServiceType): boolean;
    insecureHttpOffered(service: ServiceType, url: string): boolean;
    fallbacks: readonly ServiceType[];
    sharex: { requestUrl?: string; parseable: boolean; body: string; };
    alwaysCount: number;
    lanCount: number;
    insecureHttpCount: number;
    gofileGuestStored: boolean;
    picker?: {
        own: boolean;
        draft: string;
        committed: string;
    };
    history: readonly HistoryFacts[];
}

export interface HostRows {
    credentialWarning: boolean;
    privateWrapNote: boolean;
    insecureHttpNote: boolean;
    insecureHttpOptIn: boolean;
    missingNote: boolean;
}

export interface SavedCredential {
    service: ServiceType;
    keys: string[];
    names: string[];
}

export type Visibility = ReturnType<typeof getVisibility>;

export const HOSTS_WITH_OPTIONS: ReadonlySet<ServiceType> = new Set([
    ServiceType.ZIPLINE, ServiceType.EZHOST, ServiceType.NEST, ServiceType.ENCRYPTINGHOST, ServiceType.S3, ServiceType.CATBOX,
    ServiceType.LITTERBOX, ServiceType.ZEROX0, ServiceType.TMPFILES, ServiceType.GOFILE, ServiceType.PIXELVAULT,
    ServiceType.PIXELDRAIN, ServiceType.SHAREX, ServiceType.WEBDAV
]);

export const PRIVATE_HOSTS: readonly ServiceType[] = [ServiceType.ZIPLINE, ServiceType.S3, ServiceType.WEBDAV, ServiceType.SHAREX];

const HOST_SECRETS: Partial<Record<ServiceType, readonly (readonly [key: string, name: string])[]>> = {
    [ServiceType.ZIPLINE]: [["ziplineToken", "token"]],
    [ServiceType.EZHOST]: [["ezHostKey", "key"]],
    [ServiceType.NEST]: [["nestToken", "token"]],
    [ServiceType.ENCRYPTINGHOST]: [["encryptingHostKey", "key"]],
    [ServiceType.S3]: [["s3SecretAccessKey", "secret key"], ["s3SessionToken", "session token"]],
    [ServiceType.CATBOX]: [["catboxUserhash", "userhash"]],
    [ServiceType.GOFILE]: [["gofileToken", "token"], ["gofileGuestToken", "guest token"]],
    [ServiceType.PIXELVAULT]: [["pixelVaultKey", "key"]],
    [ServiceType.PIXELDRAIN]: [["pixelDrainKey", "key"]],
    [ServiceType.WEBDAV]: [["webdavPassword", "password"]],
    [ServiceType.SHAREX]: [["sharexConfig", "config with credentials"]]
};

const INSECURE_HTTP_SECTIONS: ReadonlySet<ServiceType> = new Set([ServiceType.ZIPLINE, ServiceType.WEBDAV, ServiceType.SHAREX, ServiceType.S3]);

const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";

function isHttpUrl(raw: unknown): raw is string {
    if (typeof raw !== "string") return false;
    const value = raw.trim();
    return URL.canParse(value) && new URL(value).protocol === "http:";
}

function isHttpsUrl(raw: unknown): boolean {
    if (typeof raw !== "string") return false;
    const value = raw.trim();
    return URL.canParse(value) && new URL(value).protocol === "https:";
}

function hostUrl(ctx: VisibilityContext, service: ServiceType): string | undefined {
    const { store } = ctx;
    switch (service) {
        case ServiceType.ZIPLINE: return store.serviceUrl;
        case ServiceType.WEBDAV: return store.webdavUrl;
        case ServiceType.S3: return store.s3Endpoint;
        case ServiceType.SHAREX: return ctx.sharex.requestUrl;
        default: return undefined;
    }
}

export function getVisibility(ctx: VisibilityContext) {
    const { store, picker } = ctx;
    const selected = store.serviceType as ServiceType;
    const fallbacksOn = !store.disableFallbacks;
    const renderer = !ctx.hasNativeHelper;
    const known = (s: ServiceType) => SERVICES[s] !== undefined;
    const others = ctx.fallbacks.filter(s => s !== selected && known(s));

    const fallbackSections = fallbacksOn ? others.filter(s => HOSTS_WITH_OPTIONS.has(s) && ctx.isUsableHere(s)) : [];
    const shown = new Set<ServiceType>([selected, ...fallbackSections]);

    const credentialViaProxy = (s: ServiceType) => {
        const { web } = SERVICES[s] ?? {};
        return renderer && ctx.proxyAllowedHere && (web === "proxy" || web === "user") && ctx.carriesCredential(s);
    };

    const embed = Boolean(store.embedProxyEnabled);
    const cors = ctx.embedService === "cors";
    const active = ctx.activeProxy;
    const customActive = proxyKey(active) != null && !isPresetProxy(active);
    const privateInUse = PRIVATE_HOSTS.some(s => ctx.isHostConfigured(s) && (s === selected || (fallbacksOn && ctx.fallbacks.includes(s))));

    const hostRows: Partial<Record<ServiceType, HostRows>> = {};
    for (const s of shown) {
        if (!known(s)) continue;
        const url = hostUrl(ctx, s);
        const http = INSECURE_HTTP_SECTIONS.has(s) && isHttpUrl(url);
        hostRows[s] = {
            credentialWarning: credentialViaProxy(s),
            privateWrapNote: PRIVATE_HOSTS.includes(s) && embed && Boolean(store.embedProxyPrivateHosts) && ctx.embedHasTarget,
            insecureHttpNote: http,
            insecureHttpOptIn: http && !ctx.isWeb && ctx.hasNativeHelper && ctx.insecureHttpOffered(s, url!),
            missingNote: s !== selected && !ctx.isHostConfigured(s)
        };
    }

    const rowNote: Partial<Record<ServiceType, "credentials" | "platform">> = {};
    if (fallbacksOn) {
        for (const s of others) {
            if (!ctx.isUsableHere(s)) {
                if (ctx.isWeb) rowNote[s] = "platform";
            } else if (!ctx.isHostConfigured(s)) rowNote[s] = "credentials";
        }
    }

    const unusedCredentials: SavedCredential[] = [];
    const elsewhereCredentials: SavedCredential[] = [];
    for (const [service, secrets] of Object.entries(HOST_SECRETS) as [ServiceType, readonly (readonly [string, string])[]][]) {
        if (shown.has(service)) continue;
        const present = secrets.filter(([key]) => filled(store[key]));
        if (!present.length || (service === ServiceType.SHAREX && !ctx.carriesCredential(service))) continue;
        const entry = { service, keys: present.map(([key]) => key), names: present.map(([, name]) => name) };
        if (fallbacksOn && ctx.fallbacks.includes(service) && !ctx.isUsableHere(service)) elsewhereCredentials.push(entry);
        else unusedCredentials.push(entry);
    }

    const { sharex } = ctx;
    const formView = Boolean(store.sharexFormView);
    const sharexFormOk = formView && sharex.parseable;
    const sharexBody = String(sharex.body).toLowerCase();
    const respectShown = Boolean(store.bypassDiscordUpload || store.bypassDragDrop || store.autoUploadPastedFiles);
    const respect = Boolean(store.bypassDiscordUploadOnlyOverLimit);
    const declinedHere = ctx.proxyAnswer === "declined";
    const style = store.encryptingHostUrlStyle;

    const own = Boolean(picker?.own);
    const draft = picker?.draft.trim() ?? "";
    const draftUsable = own && draft !== "" && proxyKey(draft) != null;
    const committed = picker?.committed.trim() ?? "";
    const committedCustom = committed !== "" && committed !== "none" && !isPresetProxy(committed);
    const optedIn = ctx.proxyAllowedHere && Boolean(store.embedUseCustomProxy) && proxyKey(committed) != null
        && store.embedCustomProxyFor === proxyKey(committed) && committedCustom && isPublicProxyUrl(committed);
    const pickerVideo = own && embed && cors;

    const entries = ctx.history?.length ?? 0;
    const historyRows: Record<string, HistoryRow> = {};
    for (const h of ctx.history ?? []) {
        historyRows[h.id] = h.anonymous ? "anonymous" : !h.deletable ? "none" : h.problem ? "problem" : "delete";
    }

    return {
        needsProxyNote: ctx.isWeb && known(selected) && SERVICES[selected].web === "proxy" && !ctx.proxyAllowedHere,
        savedCredentials: unusedCredentials.length > 0 || elsewhereCredentials.length > 0,
        primaryFailureMode: fallbacksOn && others.length > 0,

        encryptingHostTitle: style === "embed" || style === "zws",
        encryptingHostColor: style === "embed",
        encryptingHostFakelink: style === "fakelink",
        s3SignPayload: isHttpsUrl(store.s3Endpoint) && !ctx.s3Proxied,
        s3MultipartNote: renderer,
        s3R2Note: !filled(store.s3PublicUrl) && isR2Endpoint(store.s3Endpoint),
        s3AnonymousReadNote: !filled(store.s3PublicUrl) && !isR2Endpoint(store.s3Endpoint),
        s3DottedBucketNote: store.s3ForcePathStyle === false && typeof store.s3Bucket === "string" && store.s3Bucket.includes(".") && !isHttpUrl(store.s3Endpoint),
        zeroX0Options: ctx.isUsableHere(ServiceType.ZEROX0),
        gofileGuestReuse: !filled(store.gofileToken),
        gofileGuestSync: !filled(store.gofileToken),
        gofileGuestReset: Boolean(ctx.gofileGuestStored),
        sharexRawConfig: !formView,
        sharexForm: sharexFormOk,
        sharexInvalidConfig: formView && !sharex.parseable,
        sharexFileFormName: sharexFormOk && (sharexBody === "multipartformdata" || sharexBody === "formdata"),
        sharexArguments: sharexFormOk && sharexBody !== "binary",
        webdavShareLinkFormat: !isGenericWebdav(store.webdavServerType, store.webdavUrl),
        webdavGenericNote: store.webdavServerType !== "generic" && isGenericWebdav(store.webdavServerType, store.webdavUrl),

        preventEmbeds: !store.displayOriginalFilename,
        stripQueryMode: Boolean(store.stripQueryParams),
        sendImmediately: Boolean(store.autoSend),

        embedProxyService: embed,
        embedPendingNote: embed && ctx.embedStrictPending,
        embedSubstitutionNote: embed && cors && !ctx.embedStrictPending && !ctx.corsProxyWrapsVideo,
        embedX266Note: embed && ctx.embedService === "x266",
        embedScopeNote: embed,
        embedPreventNote: embed && Boolean(store.autoFormat) && !store.displayOriginalFilename,
        embedUseCustomProxy: embed && cors && ctx.proxyAllowedHere && customActive && isPublicProxyUrl(active),
        embedPrivateHosts: embed && privateInUse,
        embedSkipNative: embed,
        embedHealth: embed && ctx.embedHasTarget,

        respectLimit: respectShown,
        manualLimit: respectShown && respect,
        uploadWholeBatch: respectShown && respect,
        skipDiscordGenerated: respectShown && !respect,
        allowedTypesSummary: parseFileTypeFilter(store.uploadAllowedFileTypes) != null,

        nativeHelperWarning: !ctx.isWeb && !ctx.hasNativeHelper,
        proxyDeclinedHere: declinedHere && ctx.proxySyncedOn,
        proxyInvalidNote: ctx.proxyInvalid,
        proxyOffCaption: !ctx.proxyAllowedHere,
        proxyCredentialWarning: [selected, ...fallbacksOn ? ctx.fallbacks : []].some(s => known(s) && credentialViaProxy(s)),
        proxyRetryChoices: !ctx.isWeb && ctx.alwaysCount + ctx.lanCount > 0,
        insecureHttpChoices: !ctx.isWeb && ctx.insecureHttpCount > 0,

        pickerField: own,
        pickerBlankNote: own && draft === "",
        pickerProblemNote: own && draft !== "" && !draftUsable,
        pickerPrefixNote: own && isProxyTemplate(draft),
        pickerRedirectTick: draftUsable,
        pickerVideoNote: pickerVideo && !optedIn,
        pickerAddressLine: pickerVideo && optedIn,

        fallbackOrder: fallbacksOn,
        fallbackEmptyHint: fallbacksOn && others.length === 0,
        fallbackHosts: fallbackSections.length > 0,
        uploadHistory: entries > 0,
        historyRemove: entries > 0,
        clearHistory: entries > 0,

        fallbackSections,
        hostRows,
        rowNote,
        unusedCredentials,
        elsewhereCredentials,
        historyRows
    };
}

export interface HttpRule {
    native: boolean;
    offered: boolean;
    allowed(origin: string): boolean;
}

const HTTPS_RULE = "https:// (http:// only for a server on your own network)";

const trimmed = (raw: unknown) => typeof raw === "string" ? raw.trim() : "";

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

function parseHttpUrl(value: string, rule: string): URL | string {
    if (!SCHEME.test(value)) return `Start the address with ${rule}`;
    if (!URL.canParse(value)) return "Not a valid address";
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return `${url.protocol.slice(0, -1)} addresses aren't supported. Use ${rule}`;
    if (!url.hostname) return "Not a valid address";
    return url;
}

export function endpointUrlProblem(raw: string, http?: HttpRule, { userInfo = true } = {}): string | null {
    const value = trimmed(raw);
    if (!value) return null;
    const url = parseHttpUrl(value, HTTPS_RULE);
    if (typeof url === "string") return url;
    if (!userInfo && (url.username || url.password)) return "Remove the user name and password from the address";
    if (url.protocol !== "http:" || !http?.native || http.allowed(url.origin)) return null;
    const kind = httpHostKind(url.hostname);
    if (kind === "private" || (kind === "lan-name" && !http.offered)) return null;
    const text = kind === "public" ? httpLanOnlyText(url.host, false, false) : httpLanOnlyText(url.hostname, true, false);
    return http.offered ? `${text}. Turn on "Allow Insecure HTTP" below to use it on this device` : text;
}

export function linkBaseProblem(raw: string): string | null {
    const value = trimmed(raw);
    if (!value) return null;
    const url = parseHttpUrl(value, "https://");
    if (typeof url === "string") return url;
    if (url.username || url.password || /[?#]/.test(value)) return "Remove the user name, password, ?query and #fragment: they would end up in every link";
    return null;
}

export const DOMAIN_CATEGORIES: readonly string[] = ["normal", "offensive", "sad", "weeb"];

const CATEGORIES_TEXT = "normal, offensive, sad and weeb are categories of Encrypting.host's domains. Any other entry must be one of its domain names";

export function domainsProblem(raw: string): string | null {
    const value = trimmed(raw);
    if (!value) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
        const words = value.replace(/["'[\]]/g, " ").split(/[\s,]+/).filter(Boolean);
        return `Write it as a JSON array with double quotes, such as ${JSON.stringify(words.length ? words : ["normal"])}. ${CATEGORIES_TEXT}`;
    }
    try {
        parseEncryptingHostDomains(value);
    } catch (error) {
        return `${(error as Error).message}. ${CATEGORIES_TEXT}`;
    }
    const unknown = (parsed as string[]).map(d => d.trim()).find(d => d !== "" && !d.includes(".") && !DOMAIN_CATEGORIES.includes(d.toLowerCase()));
    return unknown ? `"${unknown}" isn't a category or a domain name. ${CATEGORIES_TEXT}` : null;
}

export function hexColorProblem(raw: string): string | null {
    const value = trimmed(raw);
    return !value || /^#?[\da-f]{6}$/i.test(value) ? null : "Use a 6-digit hex color, such as #5865F2";
}

export function shareXRequestUrlProblem(raw: string, http?: HttpRule, config?: RequestValueOptions["config"]): string | null {
    let url: string;
    try {
        url = previewShareXRequestValue(trimmed(raw), "file", { config, urlEncode: true, field: "RequestURL" });
    } catch (error) {
        return (error as Error).message;
    }
    return endpointUrlProblem(url, http);
}

export function shareXConfigProblem(raw: string, http?: HttpRule): string | null {
    if (!trimmed(raw)) return null;
    try {
        JSON.parse(raw);
    } catch (error) {
        return `Invalid JSON: ${(error as Error).message}`;
    }
    try {
        const config = parseShareXConfig(raw);
        validateShareXConfig(config);
        const problem = shareXRequestUrlProblem(String(config.RequestURL), http, config);
        return problem && `RequestURL: ${problem}`;
    } catch (error) {
        return error instanceof Error ? error.message : "Invalid ShareX config";
    }
}

export function megabytesProblem(raw: string): string | null {
    const value = trimmed(raw);
    if (!value) return null;
    const mb = Number(value);
    return Number.isFinite(mb) && mb >= 0 ? null : "Enter a number of megabytes, such as 25 (empty for Discord's limit)";
}
