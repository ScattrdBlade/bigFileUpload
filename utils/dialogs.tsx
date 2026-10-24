/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { plugins } from "@api/PluginManager";
import { PlainSettings, Settings, SettingsStore } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings/tabs";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { type ConfirmModal as ConfirmModalType } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { closeModal, Modal, openModal, React, showToast } from "@webpack/common";

import { ProxyChoice, rememberCustomProxy, settings, takeVersionNotices } from "../settings";
import { CORS_PROXY, describeProxy, directWebHostNames, isPresetProxy, isPublicProxyUrl, logger, normalizeCorsProxyUrl, PROXY_QUESTION_URL, proxyAddressText, proxyBodyLimit, proxyKey, serviceLabel, ServiceType } from "../types";
import { deleteAction, isDeleting, useUploadHistory } from "./privacy";
import { answerProxyHere, consentPending, initDeviceState, noticeProxyChange, openDeviceChannel, peekDeviceProxyAnswer, peekDeviceState, primeDeviceState, recordDismissal, redirectTickFor, sameAnswer, setDue, setPromptBusy, setProxyChangeNotifier, setRedirectTick, subscribeDeviceState } from "./proxy";
import { formatSize, getEmbedProxyService, hasNativeHelper, hostRetention, noticeRoutingChange, webDeclineOutlook } from "./upload";

export const ConfirmModal: ConfirmModalType = findByCodeLazy("confirmText:", "onCloseCallback:", "actionBarInput:");

export interface HostQuestion {
    title: string;
    question: string;
    confirmText: string;
    cancelText?: string;
}

let nextKey = 1;

export function askToUseHost({ title, question, confirmText, cancelText = "Cancel upload" }: HostQuestion): { answer: Promise<boolean>; close(): void; readonly failed: boolean; } {
    let settle: (ok: boolean) => void = () => { };
    const answer = new Promise<boolean>(resolve => {
        let done = false;
        settle = ok => {
            if (done) return;
            done = true;
            resolve(ok);
        };
    });
    const modalKey = `bfu-ask-host-${nextKey++}`;
    let broken = false;
    const failed = (error: unknown) => {
        broken = true;
        logger.error(`Couldn't show the question "${title}"`, error);
        settle(false);
    };
    try {
        openModal(props => (
            <ErrorBoundary noop onError={({ error }) => { failed(error); setTimeout(() => closeModal(modalKey)); }}>
                <ConfirmModal
                    {...props}
                    title={title}
                    subtitle={question}
                    confirmText={confirmText}
                    cancelText={cancelText}
                    variant="primary"
                    onConfirm={() => settle(true)}
                    onCancel={() => settle(false)}
                />
            </ErrorBoundary>
        ), { modalKey, onCloseCallback: () => settle(false) });
    } catch (error) {
        failed(error);
    }
    return {
        answer,
        close: () => {
            settle(false);
            closeModal(modalKey);
        },
        get failed() {
            return broken;
        }
    };
}

export function openPluginSettings(): void {
    try {
        openPluginModal(plugins.BigFileUpload);
    } catch (error) {
        logger.error("Couldn't open BigFileUpload's settings", error);
    }
}

export type TakeoverAnswer = "upload" | "choose" | "dismissed" | "failed";

let nextNoticeKey = 1;

export function askTakeover(text: string): Promise<TakeoverAnswer> {
    return new Promise(resolve => {
        let done = false;
        const settle = (answer: TakeoverAnswer) => {
            if (done) return;
            done = true;
            resolve(answer);
        };
        const modalKey = `bfu-takeover-${nextNoticeKey++}`;
        const failed = (error: unknown) => {
            logger.error("Couldn't show the first-use notice", error);
            settle("failed");
        };
        try {
            openModal(props => (
                <ErrorBoundary noop onError={({ error }) => { failed(error); setTimeout(() => closeModal(modalKey)); }}>
                    <ConfirmModal
                        {...props}
                        title="BigFileUpload"
                        subtitle={text}
                        confirmText="Upload"
                        cancelText="Choose host"
                        variant="primary"
                        onConfirm={() => settle("upload")}
                        onCancel={() => settle("choose")}
                    />
                </ErrorBoundary>
            ), { modalKey, onCloseCallback: () => setTimeout(() => settle("dismissed")) });
        } catch (error) {
            failed(error);
        }
    });
}

export function notifyBlockedHost(title: string, body: string, onClick: () => void): void {
    try {
        void Promise.resolve(showNotification({ title, body, permanent: true, noPersist: true, onClick })).catch(error => logger.error("Couldn't show the blocked-host notification", error));
    } catch (error) {
        logger.error("Couldn't show the blocked-host notification", error);
    }
}

export interface OriginRetryAnswer {
    retry: boolean;
    always: boolean;
}

let nextRetryKey = 1;

function OriginRetryDialog({ modalProps, host, question, settle }: { modalProps: object; host: string; question: string; settle(answer: OriginRetryAnswer): void; }) {
    const [always, setAlways] = React.useState(false);
    return (
        <ConfirmModal
            {...modalProps as React.ComponentProps<typeof ConfirmModal>}
            title="Retry through the CORS proxy?"
            subtitle={question}
            confirmText="Retry once through the proxy"
            cancelText="Not now"
            variant="primary"
            checkboxProps={{ label: `Always for ${host} on this device`, checked: always, onChange: setAlways }}
            onConfirm={() => settle({ retry: true, always })}
            onCancel={() => settle({ retry: false, always: false })}
        />
    );
}

export function askOriginRetry(host: string, question: string): Promise<OriginRetryAnswer> {
    return new Promise(resolve => {
        let done = false;
        const settle = (answer: OriginRetryAnswer) => {
            if (done) return;
            done = true;
            resolve(answer);
        };
        const modalKey = `bfu-origin-retry-${nextRetryKey++}`;
        const failed = (error: unknown) => {
            logger.error("Couldn't show the blocked-host question", error);
            settle({ retry: false, always: false });
        };
        try {
            openModal(props => (
                <ErrorBoundary noop onError={({ error }) => { failed(error); setTimeout(() => closeModal(modalKey)); }}>
                    <OriginRetryDialog modalProps={props} host={host} question={question} settle={settle} />
                </ErrorBoundary>
            ), { modalKey, onCloseCallback: () => setTimeout(() => settle({ retry: false, always: false })) });
        } catch (error) {
            failed(error);
        }
    });
}

export function notifyTakeover(text: string): void {
    showNotification({ title: "BigFileUpload", body: `${text} Click to choose another host.`, onClick: openPluginSettings });
}

const cl = classNameFactory("vc-file-upload-");

export interface LateCancelEntry {
    url: string;
    fileName: string;
    hostLabel: string;
    retention?: string;
    private?: boolean;
    shareInterrupted?: boolean;
    id: string;
}

export class UploadCancelledError extends Error {
    constructor(readonly reason?: string) {
        super(reason ?? "Upload cancelled by user");
    }
}

export class LateCancelError extends UploadCancelledError {
    constructor(readonly entry: LateCancelEntry) {
        super();
    }
}

function describeHost(e: LateCancelEntry): string {
    return e.retention ? `${e.hostLabel} (${e.retention})` : e.hostLabel;
}

export function copyKeptLink(e: LateCancelEntry): void {
    try { window.focus(); } catch { }
    Promise.resolve().then(() => copyToClipboard(e.url)).then(
        () => {
            const action = deleteAction(e.id);
            const where = action && !action.problem ? "; delete it under Upload History in BigFileUpload's settings" : "";
            showToast({ text: `Link for ${e.fileName} copied${where}`, variant: "success" });
        },
        () => openLateCancelDialog(e)
    );
}

async function copyFromDialog(url: string) {
    try {
        await copyToClipboard(url);
        showToast({ text: "Link copied", variant: "success" });
    } catch {
        showToast({ text: "Couldn't copy the link. Select it in the dialog and copy it", variant: "critical" });
    }
}

function LateCancelDialog({ e, props }: { e: LateCancelEntry; props: { transitionState: number; onClose(): void; }; }) {
    useUploadHistory();
    const action = deleteAction(e.id);
    const hostNote = e.shareInterrupted
        ? "The share request was interrupted. Check the Shares list on your server, since a public link may have been created. This link opens only with your WebDAV login."
        : e.private
            ? "It isn't shared: the link opens only with your WebDAV login."
            : null;
    const deleteNote = action ? action.problem : hostNote ? null : `BigFileUpload can't delete it. It stays on ${describeHost(e)}.`;
    const busy = isDeleting(e.id);
    return (
        <Modal
            {...props}
            title="Upload cancelled too late"
            subtitle={`${e.fileName} is on ${describeHost(e)}`}
            actions={[
                ...action && !action.problem ? [{
                    text: action.label,
                    variant: "critical-primary",
                    loading: busy,
                    disabled: busy,
                    onClick: () => void action.run().then(done => { if (done) props.onClose(); })
                }] : [],
                { text: "Copy link", variant: "primary", onClick: () => void copyFromDialog(e.url) },
                { text: "Close", variant: "secondary", onClick: props.onClose }
            ]}
        >
            <input
                className={cl("late-link")}
                readOnly
                value={e.url}
                onFocus={ev => ev.currentTarget.select()}
            />
            {hostNote && <div className={cl("late-note")}>{hostNote}</div>}
            {deleteNote && <div className={cl("late-note")}>{deleteNote}</div>}
        </Modal>
    );
}

export function openLateCancelDialog(e: LateCancelEntry): void {
    openModal(props => <LateCancelDialog e={e} props={props} />, { modalKey: `bfu-late-cancel-${e.id}` });
}

export function announceLateCancel(e: LateCancelEntry): void {
    logger.info(`Upload to ${e.hostLabel} was cancelled after the file was sent. Its link was kept (${e.id})`);
    showToast({
        text: `Cancelled, but ${e.fileName} was already uploaded to ${describeHost(e)}. Click the notification to copy its link`,
        duration: 10000
    });
    void showNotification({
        title: "Upload cancelled too late",
        body: `A cancelled upload had already reached ${e.hostLabel}. Click to copy its link.`,
        noPersist: true,
        onClick: () => copyKeptLink(e)
    });
}

const clCorsProxyPrompt = classNameFactory("vc-file-upload-");

const MODAL_KEY = "bigfileupload-cors-proxy";

export function initCorsProxyPrompt(): void {
    if (IS_REPORTER) return;
    if (!PlainSettings.plugins?.BigFileUpload?.enabled) void setDue(true);
    SettingsStore.addChangeListener("plugins.BigFileUpload.enabled", () => void setDue(true));
    setProxyChangeNotifier(host => showToast({ text: `The CORS proxy changed to ${host}. BigFileUpload will ask before sending credentials through it`, duration: 10000 }));
    SettingsStore.addGlobalChangeListener(() => {
        noticeProxyChange();
        noticeRoutingChange();
    });
}

export function startCorsProxyPrompt(fresh: boolean | null): void {
    if (IS_REPORTER) return;
    openDeviceChannel();
    deciding = true;
    syncBusy();
    const read = primeDeviceState().then(() => {
        initDeviceState(fresh);
        noticeProxyChange();
    });
    void withinDeadline(read).then(() => {
        if (peekDeviceState().unreadable || consentPending()) queuePrompt();
    }).finally(() => {
        deciding = false;
        syncBusy();
    });
}

const PRIME_DEADLINE_MS = 10000;

const withinDeadline = (read: Promise<void>) => Promise.race([read, new Promise<void>(resolve => setTimeout(resolve, PRIME_DEADLINE_MS))]);

let deciding = false;

let promptQueued = false;

const syncBusy = () => setPromptBusy(deciding || promptQueued || promptOpen);

function queuePrompt(): void {
    if (promptQueued) return;
    promptQueued = true;
    syncBusy();
    setTimeout(() => void showCorsProxyPrompt(), 2000);
}

export async function showCorsProxyPrompt(fromButton = false): Promise<void> {
    if (IS_REPORTER) return;
    if (!fromButton) {
        try {
            if (!Settings.plugins.BigFileUpload?.enabled) return;
            await withinDeadline(primeDeviceState());
            if (!peekDeviceState().unreadable && !consentPending()) return;
            openPrompt();
        } finally {
            promptQueued = false;
            syncBusy();
        }
        return;
    }
    openPrompt();
}

let promptOpen = false;

function openPrompt(notices = takeVersionNotices()): void {
    if (promptOpen) return;
    promptOpen = true;
    syncBusy();
    let answered = false;
    let renderFailed = false;
    let reopen = false;
    const openedWith = peekDeviceProxyAnswer();
    const unsubscribe = subscribeDeviceState(() => {
        const answer = peekDeviceProxyAnswer();
        if (answered || renderFailed || answer == null || answer.answer === "dismissed" || sameAnswer(answer, openedWith)) return;
        answered = true;
        closeModal(MODAL_KEY);
    });
    const closed = () => {
        promptOpen = false;
        unsubscribe();
        syncBusy();
    };
    const onAnswer = (accept: boolean, choice?: ProxyChoice, openedDraft?: string) => {
        answered = true;
        try {
            if (accept && openedDraft !== undefined && proxyKey(initialDraft()) !== proxyKey(openedDraft)) {
                reopen = true;
                showToast({ text: `BigFileUpload: the CORS proxy changed to ${describeProxy(initialDraft()).host} while the question was open, so nothing was saved. Please answer again`, duration: 10000 });
                return;
            }
            const previous = settings.store.corsProxyUrl;
            answerProxyHere(accept, accept && choice && choice.url !== openedDraft ? choice.url : undefined);
            if (accept && choice) {
                rememberCustomProxy(previous, choice.url);
                if (!isPresetProxy(choice.url) && choice.noRedirects !== redirectTickFor(choice.url)) setRedirectTick(choice.url, choice.noRedirects);
            }
        } catch (error) {
            logger.error("Couldn't record the CORS-proxy answer", error);
        }
    };
    try {
        openModal(props => (
            <ErrorBoundary noop onError={() => { renderFailed = true; setTimeout(() => closeModal(MODAL_KEY)); }}>
                <PromptModal modalProps={props} notices={notices} onAnswer={onAnswer} />
            </ErrorBoundary>
        ), {
            modalKey: MODAL_KEY,
            onCloseCallback: () => {
                if (reopen) promptQueued = true;
                closed();
                if (reopen) {
                    setTimeout(() => {
                        promptQueued = false;
                        openPrompt(notices);
                    });
                    return;
                }
                if (answered || renderFailed) return;
                recordDismissal();
            }
        });
    } catch (error) {
        closed();
        logger.error("Couldn't open the CORS-proxy question", error);
    }
}

const initialDraft = () => proxyKey(settings.store.corsProxyUrl) != null ? normalizeCorsProxyUrl(settings.store.corsProxyUrl) : CORS_PROXY;

function PromptModal({ modalProps, notices, onAnswer }: {
    modalProps: { transitionState: number; onClose(): void; };
    notices: string[];
    onAnswer(accept: boolean, choice?: ProxyChoice, openedDraft?: string): void;
}) {
    const [openedDraft] = React.useState(initialDraft);
    const [choice] = React.useState<ProxyChoice>(() => ({ url: openedDraft, noRedirects: redirectTickFor(openedDraft) }));
    return (
        <ConfirmModal
            {...modalProps}
            size="md"
            variant="primary"
            title={IS_WEB ? "BigFileUpload: use a proxy for file hosts?" : "BigFileUpload: retry blocked uploads through a proxy?"}
            confirmText="Use the proxy"
            cancelText="Don't use it"
            onConfirm={() => onAnswer(true, choice, openedDraft)}
            onCancel={() => onAnswer(false)}
        >
            <ErrorBoundary>
                <PromptBody draft={choice.url} notices={notices} />
            </ErrorBoundary>
        </ConfirmModal>
    );
}

const triedDirectly = (s: ServiceType) => `${serviceLabel(s)} is tried directly and works only if its server allows discord.com`;

const NBSP = " ";

function webPrimaryLine(): string | null {
    const o = webDeclineOutlook();
    if (!o.primaryNeedsProxy) return null;
    const needs = `Your upload host, ${serviceLabel(o.primary)}, needs the proxy on Vencord Web`;
    const suggest = o.suggestPublic ? ` You can turn on ${directWebHostNames("or")} under Fallback Order.` : "";
    switch (o.variant) {
        case "disabled":
            return `${needs}, and fallback hosts are disabled, so if you decline, files over Discord's limit are left to Discord. Accept the proxy, or turn off Disable Fallback Hosts.`;
        case "confidential":
            return `${needs}. Its links carry the decryption key, so BigFileUpload never moves its files to an unencrypted public host by itself. If you decline, files over Discord's limit are left to Discord unless an active private host can take them. Accept the proxy, or choose another upload host.`;
        case "none": {
            const leftToDiscord = o.userHost ? `${triedDirectly(o.userHost)}; otherwise, files over Discord's limit` : "so files over Discord's limit";
            return `${needs}. If you decline, none of your active fallback hosts is known to work without it, ${leftToDiscord} are left to Discord.${suggest}`;
        }
        default: {
            const host = o.host!;
            const retention = hostRetention(host);
            const user = o.userHost ? ` ${serviceLabel(o.userHost)} is tried first, directly, and works only if its server allows discord.com.` : "";
            return `${needs}. If you decline, uploads go to ${serviceLabel(host)}${retention ? ` (${retention})` : ""} instead.${user}`;
        }
    }
}

function PromptBody({ draft, notices }: { draft: string; notices: string[]; }) {
    const { embedProxyEnabled, embedSkipNative, embedUseCustomProxy, embedCustomProxyFor } = settings.use(["corsProxyUrl", "embedProxyEnabled", "embedProxyService", "embedUseCustomProxy", "embedCustomProxyFor", "embedSkipNative", "serviceType", "disableFallbacks", "fallbackActive"]);
    const desktop = !IS_WEB;
    const staleDesktop = desktop && !hasNativeHelper;
    const preset = isPresetProxy(draft);
    const proxy = describeProxy(draft);
    const limit = proxyBodyLimit(draft);
    const limitText = limit != null ? `about ${formatSize(limit, true).replace(" ", NBSP)}` : null;

    const skipNative = embedSkipNative !== false;
    const customOptIn = Boolean(embedUseCustomProxy) && embedCustomProxyFor === proxyKey(draft);
    const corsService = getEmbedProxyService() === "cors";
    const wrapsVideo = Boolean(embedProxyEnabled) && corsService && (preset || (customOptIn && isPublicProxyUrl(draft)));
    const substitutesVideo = Boolean(embedProxyEnabled) && corsService;
    const customOptedIn = wrapsVideo && !preset;
    const primaryLine = IS_WEB ? webPrimaryLine() : null;
    const customVideo = substitutesVideo && !preset && !wrapsVideo
        ? isPublicProxyUrl(draft)
            ? "Video links use autocompressor.net (checked from your device) unless 'Use My Proxy for Video Links' is on."
            : "Your proxy isn't reachable from the internet, so video links use autocompressor.net (checked from your device)."
        : null;

    return (
        <div className={clCorsProxyPrompt("cors-prompt")}>
            {notices.length > 0 && (
                <>
                    <p><strong>What changed in this update</strong></p>
                    <ul>{notices.map(n => <li key={n}>{n}</li>)}</ul>
                </>
            )}
            {staleDesktop && (
                <p><strong>BigFileUpload's native helper is not loaded</strong> (fully restart the app after building). Until then uploads run inside Discord's page, where Discord's security policy blocks the file hosts and the CORS proxy alike, so uploads fail whatever you answer. After a full restart, the following applies.</p>
            )}
            <p>{desktop
                ? "If your network blocks a file host, BigFileUpload can retry that upload once through a CORS proxy. If you don't use it, uploads to a blocked host fail, and BigFileUpload moves on to your next host if you have one."
                : "On Vencord Web, your browser blocks uploads to most file hosts. A CORS proxy sends them for you."}</p>
            <ul>
                <li>{desktop
                    ? "The proxy can see the files that pass through it. It never gets your logins unless you allow that for a host."
                    : "The proxy can see the files that pass through it, and the logins of the hosts that use it."}</li>
                <li>{proxy.preset ? "It doesn't hide your IP address from file hosts." : "It may not hide your IP address from file hosts."}</li>
                {proxy.preset ? (
                    <li>
                        Run by {proxy.operator} ({proxy.host},{" "}
                        <a href={proxy.source} target="_blank" rel="noreferrer">source code</a>). No privacy policy.{limitText ? ` Files up to ${limitText}.` : ""}
                    </li>
                ) : (
                    <li>It uses your proxy, <code>{proxy.host}</code>.</li>
                )}
                {wrapsVideo && <li>{skipNative ? "It also wraps video links Discord can't embed by itself, so Discord can preview them." : "It also wraps video links so Discord can preview them."} It sees the IP address of anyone who opens them.</li>}
                {customOptedIn && <li>Your proxy's address ({proxyAddressText(draft)}) will appear in every video link you post, so anyone who sees it can use your proxy.</li>}
            </ul>
            {primaryLine && <p>{primaryLine}</p>}
            {substitutesVideo && <p>If you don't use it, video links go through autocompressor.net instead (another third party, with Google ads) while it's up.</p>}
            <p>You can change this, or use your own proxy, anytime in BigFileUpload → Network.</p>
            <details>
                <summary>Details</summary>
                <ul>
                    {desktop ? (
                        <>
                            <li>{wrapsVideo ? "Besides video links, the proxy only retries blocked uploads and downloads." : "The proxy only retries blocked uploads and downloads."} After a retry past a block works, that host's login-free uploads use it for 10{NBSP}minutes.</li>
                            <li>Optional logins (Catbox userhash, GoFile token) are left out, so those uploads can't be deleted from your account.</li>
                            <li>Hosts on your own network never use it.</li>
                        </>
                    ) : (
                        <>
                            <li>Without it, only {directWebHostNames("and")} work, plus Zipline, S3, WebDAV and custom uploaders whose server allows discord.com.</li>
                            <li>The proxy also sees logins (tokens, passwords, your WebDAV login, the Catbox userhash, S3 signatures) and files it downloads when a direct download fails.</li>
                        </>
                    )}
                    <li>{proxy.preset
                        ? `${proxy.operator} publishes the code, but the running proxy can't be checked against it.`
                        : "Whoever runs your proxy sees all of this."}</li>
                    {limitText && !desktop && <li>{`Uploads over ${limitText} can't go through it (S3 sends parts).`}</li>}
                    {customVideo
                        ? <li>{customVideo}</li>
                        : substitutesVideo && <li>If you decline, BigFileUpload checks autocompressor.net from your device before using it.</li>}
                    <li>'Don't use it' also turns it off on your other devices (Cloud Sync). 'Use the proxy' never re-enables it on a device that declined.</li>
                    <li>Closing this without choosing asks again at the next start.</li>
                </ul>
                <p><a href={PROXY_QUESTION_URL} target="_blank" rel="noreferrer">Learn more</a></p>
            </details>
        </div>
    );
}
