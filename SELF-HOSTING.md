# Self-hosting the CORS proxy for BigFileUpload

BigFileUpload's default CORS proxy, `cors.keiran0.workers.dev`, is run by keircn ([source](https://codeberg.org/key/corsproxy)). BigFileUpload can't check that the running copy uses that source, and there is no privacy or logging policy. Whoever runs a proxy sees every file and credential that passes through it. To keep that to yourself, run your own and choose **Your own proxy (self-hosted)…** under BigFileUpload → Network.

"Your own proxy" accepts two forms:

- **`?url=` form:** the proxy's address, for example `https://bfu-cors.example.workers.dev`. BigFileUpload adds `?url=<target>` itself, so don't include a query.
- **Prefix-style template:** an address ending in `/{url}`, for example `https://cors.example.net/{url}` (cors-anywhere and similar). BigFileUpload puts the target right after the prefix: `https://cors.example.net/https://catbox.moe/user/api.php`.

> [!IMPORTANT]
> Update BigFileUpload on every device that shares settings through Cloud Sync **before** switching to a prefix-style template. Older versions can't upload through it, and they post broken video links.

Leave **My Proxy Passes Redirects Back Unchanged** unticked unless your proxy really returns 3xx answers to the app untouched (the worker below does, cors-anywhere never does). Unticked, BigFileUpload sends no credential through your proxy on Desktop and Vesktop, and on Vencord Web it warns that the proxy may forward credentials on a redirect.

### Option 1: a Cloudflare Worker (recommended)

1. Create a free Cloudflare account.
2. Go to **Workers & Pages → Create → Worker**, replace the code with the `worker.js` below, put your own servers in `ALLOWED_TARGET_HOSTS`, and click **Deploy**. Or, with Node installed: save the two files below and run `npx wrangler deploy` (the `wrangler.toml` sets the name `bfu-cors`, the compatibility date and turns logging off).
3. Under BigFileUpload → **Network** → **CORS Proxy**, choose **Your own proxy (self-hosted)…**, paste `https://bfu-cors.<your-account-subdomain>.workers.dev` into **Your proxy's address** and press Enter.
4. Optional: add a custom domain to the worker (Cloudflare recommends one for production, and it also hides your account subdomain). BigFileUpload only knows the 100 MB cap for `*.workers.dev` addresses. Through a custom domain it also sends bigger files, which Cloudflare refuses, so those uploads fail on that host.

**Free-plan limits:** 100,000 requests a day (then error 1027), 10 ms of CPU per request (waiting on the network doesn't count), 128 MB of memory, and request bodies up to 100 MB on Free and Pro (200 MB on Business, and responses aren't limited). That is plenty for one person. BigFileUpload sends at most about 99 MB through any `*.workers.dev` proxy.

**Caveats:**

- Cloudflare always adds `CF-Worker: <your zone>` to the worker's requests, so file hosts learn the zone name.
- Your proxy wraps video links only if you turn on **Use My Proxy for Video Links** for that proxy address, and only when it is https on a public name. Its address then appears in every video link you post, which publishes your account subdomain and any secret path, and anyone in the channel can spend your quota. It also turns your worker into a public relay under your Cloudflare account (abuse reports and suspension are possible), and its logs would record every viewer's IP address. A custom domain hides the subdomain, not the path. With the switch off, video links use autocompressor.net while it is up, or stay plain.
- It doesn't help where Cloudflare itself is throttled (for example Russia since 9 June 2025). Use option 2 there.
- Avoid Vercel and Netlify for this: their request bodies are capped at 4.5 MB.

**What the worker below already does** (keep these if you write your own):

- Drops `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`, `CF-Connecting-IP`, `Cookie` and `Referer` before forwarding
- Streams the upload with `FixedLengthStream` when the size is known, which keeps the `Content-Length` header hosts such as Catbox need and avoids holding up to 100 MB in a 128 MB worker
- Answers only `https://discord.com`, `https://ptb.discord.com` and `https://canary.discord.com` among browser origins (403 for others), and still accepts requests with no `Origin`, which the desktop retry sends
- Relays only to the hosts in `ALLOWED_TARGET_HOSTS`, so a posted video link can't turn it into an open relay for anything else. Keep `interactive-examples.mdn.mozilla.net` in the list: BigFileUpload's video check asks the proxy for a public sample video there (MDN's `flower.mp4`), and a proxy that refuses it counts as down, so video links stay plain. On Vencord Web, after your proxy passes that check, the autocompressor.net and x266.mov checks can also go through it. Add `autocompressor.net` and `x266.mov` if you use them there
- Reflects the allowed Origin in its CORS answer, answers `HEAD` (BigFileUpload's video check uses it), forwards the request's `Origin` upstream and passes the upstream's `Access-Control-Expose-Headers` through, so an S3 bucket's exposed `ETag` reaches the plugin for multipart uploads
- Never follows redirects itself (`redirect: "manual"`): a host's 3xx goes back to the app unchanged, so you may tick **My Proxy Passes Redirects Back Unchanged**
- Has Workers logs and observability turned off in `wrangler.toml`. Don't enable Logpush or Tail either: they would record viewers' IP addresses and `?url=` targets.

`worker.js`:

```js
// BigFileUpload CORS relay: https://<this worker>/?url=<encoded target>
// Your own servers (Zipline, S3, WebDAV, a custom uploader) go into ALLOWED_TARGET_HOSTS too. A host matches itself and
// its subdomains. Right-click uploads of images from other sites need their hosts here as well.
const ALLOWED_TARGET_HOSTS = [
    "catbox.moe",
    "0x0.st",
    "tmpfiles.org",
    "gofile.io",
    "buzzheavier.com",
    "temp.sh",
    "filebin.net",
    "pixeldrain.com",
    "e-z.host",
    "nest.rip",
    "encrypting.host",
    "pixelvault.co",
    // BigFileUpload's video check probes this public sample (MDN's flower.mp4) through the proxy. The relay must serve it
    "interactive-examples.mdn.mozilla.net",
    // "zipline.example.com", "s3.example.com", "my-bucket.s3.eu-central-1.amazonaws.com"
];
const ALLOWED_ORIGINS = [
    "https://discord.com",
    "https://ptb.discord.com",
    "https://canary.discord.com",
];
const DROPPED_HEADERS = [
    "host",
    "origin",
    "referer",
    "cookie",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
    "true-client-ip",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
];

const allowedTarget = (hostname) => {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return ALLOWED_TARGET_HOSTS.some(
        (h) => host === h || host.endsWith("." + h),
    );
};

function corsHeaders(origin) {
    const headers = new Headers({ Vary: "Origin" });
    if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Expose-Headers", "*");
    }
    return headers;
}

function reply(status, text, origin) {
    const headers = corsHeaders(origin);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(text, { status, headers });
}

export default {
    async fetch(request) {
        const origin = request.headers.get("Origin");
        // No Origin (the desktop retry) is fine, another website is not
        if (origin && !ALLOWED_ORIGINS.includes(origin))
            return reply(403, "Origin not allowed", null);

        if (request.method === "OPTIONS") {
            const headers = corsHeaders(origin);
            headers.set(
                "Access-Control-Allow-Methods",
                "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
            );
            headers.set(
                "Access-Control-Allow-Headers",
                request.headers.get("Access-Control-Request-Headers") || "*",
            );
            headers.set("Access-Control-Max-Age", "600");
            return new Response(null, { status: 204, headers });
        }

        let target;
        try {
            target = new URL(
                new URL(request.url).searchParams.get("url") || "",
            );
        } catch {
            return reply(400, "Usage: ?url=<encoded target URL>", origin);
        }
        if (
            (target.protocol !== "https:" && target.protocol !== "http:") ||
            target.username ||
            target.password
        )
            return reply(400, "Only plain http(s) targets", origin);
        if (!allowedTarget(target.hostname))
            return reply(403, "Target host not allowed", origin);

        const headers = new Headers();
        for (const [name, value] of request.headers) {
            if (!DROPPED_HEADERS.includes(name.toLowerCase()))
                headers.set(name, value);
        }
        // S3 answers with Access-Control-Expose-Headers (ETag) only to a request that carries an Origin
        if (origin) headers.set("Origin", origin);

        let body = null;
        if (
            request.method !== "GET" &&
            request.method !== "HEAD" &&
            request.body
        ) {
            const length = Number(request.headers.get("Content-Length"));
            if (
                Number.isFinite(length) &&
                length > 0 &&
                typeof FixedLengthStream === "function"
            ) {
                const { readable, writable } = new FixedLengthStream(length);
                request.body.pipeTo(writable).catch(() => {});
                body = readable;
            } else {
                body = await request.arrayBuffer();
            }
        }

        let upstream;
        try {
            upstream = await fetch(target.href, {
                method: request.method,
                headers,
                body,
                redirect: "manual",
            });
        } catch (error) {
            return reply(502, `Upstream request failed: ${error}`, origin);
        }

        const out = new Headers(upstream.headers);
        out.delete("Set-Cookie");
        out.delete("Access-Control-Allow-Origin");
        out.delete("Access-Control-Allow-Credentials");
        for (const [name, value] of corsHeaders(origin)) out.set(name, value);
        const exposed = upstream.headers.get("Access-Control-Expose-Headers");
        if (origin && exposed)
            out.set("Access-Control-Expose-Headers", exposed);
        return new Response(request.method === "HEAD" ? null : upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: out,
        });
    },
};
```

`wrangler.toml`:

```toml
name = "bfu-cors"
main = "worker.js"
compatibility_date = "2026-10-01"
workers_dev = true

[observability]
enabled = false
```

### Option 2: cors-anywhere on your own server

For power users: [Rob--W/cors-anywhere](https://github.com/Rob--W/cors-anywhere) (MIT, Node) on a VPS. It has no body cap and works where Cloudflare is throttled.

Enter it in **Your proxy's address** as a prefix-style template, `https://cors.example.net/{url}`. No `?url=` adapter is needed. Leave **My Proxy Passes Redirects Back Unchanged** unticked: a stock cors-anywhere never qualifies.

Configure it so every BigFileUpload path works (option names as of cors-anywhere 0.4.4, so check them against the version you deploy):

- **Requests with no `Origin`** (the desktop retry and the desktop video check send none) must pass. The library's default is `requireHeader: null`, but the example `server.js` most deployments start from sets `requireHeader: ['origin', 'x-requested-with']`. Set `requireHeader: []`.
- **Browser origins:** `CORSANYWHERE_WHITELIST="https://discord.com,https://ptb.discord.com,https://canary.discord.com,"`. The trailing comma adds an empty entry, which admits requests without an Origin: cors-anywhere compares a missing Origin as `""`, and a whitelist without `""` answers them 403.
- **Headers:** `server.js` sets `xfwd: false` (the library default `true` adds X-Forwarded-For). Keep it. `server.js` already drops `Cookie`. Add `Referer` to `removeHeaders`.
- **Redirects:** set `maxRedirects: 0`, so cors-anywhere never follows a redirect itself. Otherwise it follows 301/302/303 as a GET and re-sends every request header, `Authorization` included, to the new site, and the target allowlist below never sees that hop. It still rewrites every redirect's `Location` onto its own address, which is why the tick stays off.
- **Targets:** allow only the file hosts you use plus your own servers, and `interactive-examples.mdn.mozilla.net`, where BigFileUpload's video check fetches its sample (the worker's `ALLOWED_TARGET_HOSTS` list is a starting point), checked in `handleInitialRequest`, and refuse loopback, 10/8, 172.16/12, 192.168/16, 100.64.0.0/10, 169.254.0.0/16, fc00::/7 and fe80::/10 **after DNS resolution** (a custom `http.Agent` with its own `lookup`, or an egress firewall). A proxy on a VPS can reach that server's private network and its cloud-metadata endpoint, and once a video link carries the proxy's address, anyone can try. With `maxRedirects: 0`, every hop comes back through `handleInitialRequest`.
- Answer `HEAD` with CORS headers (BigFileUpload's video check uses it), and let the page read the upstream's `ETag` (S3 multipart uploads on Vencord Web).
- Its access logs record every proxied URL, including a posted video link's target. Turn them off or keep them private.

**A front end in front of it** (nginx, Caddy, a load balancer) must keep the target's `//` and its encoding:

- nginx merges slashes by default, which turns `/https://catbox.moe/…` into `/https:/catbox.moe/…`. cors-anywhere then answers with its usage page instead of proxying. Set `merge_slashes off;`.
- **A secret path** such as `https://cors.example.net/s3cret/{url}` needs the front end to strip it: stock cors-anywhere reads the first path segment as the target host and answers 404 "Invalid host". For example:

    ```nginx
    merge_slashes off;
    location /s3cret/ {
        rewrite ^/s3cret(/.*)$ $1 break;
        proxy_pass http://127.0.0.1:8080;
    }
    ```

    Give `proxy_pass` no URI part: with one, nginx passes the decoded path, which turns `%2F`, `%3F` and `%23` inside the target into `/`, `?` and `#`.

- Check that a target whose path contains `%2F` and which has a query string arrives unchanged, and that `https://cors.example.net/s3cret/http://169.254.169.254/` answers 403.
