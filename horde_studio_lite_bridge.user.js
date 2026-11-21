// ==UserScript==
// @name         Horde Studio Lite — Browser Bridge
// @namespace    horde-studio-lite
// @version      2.1.0
// @description  Routes every AI Horde request of Horde Studio Lite through this browser tab, so the VPN / proxy extension active in Firefox applies to all traffic. Runs on aihorde.net / stablehorde.net — NO local page, nothing to open. Tokenless, auto-connecting.
// @author       Horde Studio Lite
// @match        https://aihorde.net/*
// @match        https://www.aihorde.net/*
// @match        https://stablehorde.net/*
// @match        https://www.stablehorde.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      aihorde.net
// @connect      stablehorde.net
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* =============================================================================
 * Horde Studio Lite — Browser Bridge v2.1.0 (companion to horde_studio_lite.py v11+)
 *
 * How it works
 * ------------
 *  • The Python app binds a PRIVATE app-internal JSON channel on 127.0.0.1
 *    (default 8491; configurable in the app's HORDE tab). It is NOT a web
 *    site: no page is served, there is nothing to open, no local address
 *    ever appears in a URL bar.
 *  • THIS script runs on https://aihorde.net/ (or https://stablehorde.net/)
 *    — the page you actually keep open in Firefox — and discovers the app's
 *    channel automatically (it probes the known channel ports once and
 *    remembers the winner). No token, no address entry, no CONNECT click.
 *  • The app hands every AI Horde request (submissions, checks, status
 *    polls, cancellations, image downloads, Civitai lookups) to this page;
 *    the page executes them with GM_xmlhttpRequest — INSIDE the browser's
 *    network stack, so your Firefox VPN / proxy extension applies to all
 *    of them. While the bridge is connected the app itself sends nothing
 *    directly.
 *
 * v2.1.0 — panel restyle (with the v11 app)
 * -----------------------------------------
 *  • In-browser UI reverted to the SARIF GOLD design language (the app's
 *    gold theme: amber-on-black neo-baroque, 1px bevels) — matching the
 *    desktop app's own chrome instead of the red lacquer skin.
 *  • Every button now has explicit :hover, :active (pressed) and
 *    :focus-visible states with quick 120ms transitions — press feedback
 *    is inset-shadowed + nudged exactly like Horde Studio's own buttons.
 *  • Protocol unchanged from v2.0.0: instant claim acknowledgement
 *    (X-HSL-Job-Id header), gzip channel payloads via DecompressionStream,
 *    duplicate-execution guard, 4 parallel worker slots, automatic
 *    reconnect, pause, tokenless auto-discovery.
 *
 * Setup
 * -----
 *  1. Install THIS file in Tampermonkey (Firefox) — new script → paste → save.
 *  2. Start Horde Studio Lite (the bridge checkbox is ON by default).
 *  3. Open https://aihorde.net/ in Firefox and KEEP THAT TAB OPEN.
 *     Done — the panel turns gold "connected" and every AI Horde request
 *     rides this browser, so the VPN extension applies.
 * ==========================================================================*/

(function () {
    'use strict';

    // ------------------------------ configuration ---------------------------
    const POLL_TIMEOUT_S = 25;      // must match BRIDGE_POLL_SECS on the Python side
    const WORKER_COUNT = 4;         // parallel request slots
    const RECONNECT_MS = 3000;      // retry gap when the app is unreachable
    const CHANNEL_CANDIDATES = [
        'http://127.0.0.1:8491',
        'http://127.0.0.1:8492',
        'http://127.0.0.1:8493',
    ];
    const DISCOVER_TIMEOUT_MS = 1500;

    const HAS_DECOMPRESS = typeof DecompressionStream === 'function';

    let serverUrl = GM_getValue('hsl_channel', '') || '';

    const stats = { done: 0, failed: 0, lastUrl: '', lastMs: 0, lastError: '' };
    let connected = false;
    let channelUp = false;          // can we reach the app's channel at all?
    let started = false;
    let paused = false;
    let minimized = false;
    const executedIds = new Set();  // duplicate-execution guard (one page session)

    // ------------------------------ small helpers ---------------------------
    const $ = (sel) => document.querySelector(sel);

    function ab2b64(buf) {
        const bytes = new Uint8Array(buf);
        const CH = 0x8000;
        let bin = '';
        for (let i = 0; i < bytes.length; i += CH) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(bin);
    }

    function b642ab(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    // Normalise the two response shapes execJob() can end up holding:
    //   • a native fetch() Response         -> .arrayBuffer() gives a promise
    //   • a GM_xmlhttpRequest onload result -> .response already IS the
    //     payload as an ArrayBuffer (responseType 'arraybuffer' was set in
    //     gmFetch).
    function respToArrayBuffer(res) {
        if (res && typeof res.arrayBuffer === 'function') {
            return Promise.resolve(res.arrayBuffer());
        }
        const r = res ? res.response : null;
        if (r instanceof ArrayBuffer) {
            return Promise.resolve(r);
        }
        if (r && r.buffer instanceof ArrayBuffer) {   // TypedArray / DataView view
            return Promise.resolve(r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength));
        }
        if (typeof r === 'string') {                  // rare: decoded as text anyway
            const bytes = new Uint8Array(r.length);
            for (let i = 0; i < r.length; i++) bytes[i] = r.charCodeAt(i) & 0xff;
            return Promise.resolve(bytes.buffer);
        }
        return Promise.resolve(new ArrayBuffer(0));
    }

    function ab2txt(buf) {
        const bytes = new Uint8Array(buf);
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return s;
    }

    function gmFetch(opts) {
        // GM_xmlhttpRequest documents Blob bodies; raw typed arrays have been
        // flaky across managers, so wrap them (plain string bodies pass through).
        let data = opts.body;
        if (data && data.buffer instanceof ArrayBuffer) {
            data = new Blob([data]);
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: data,
                timeout: opts.timeout || 120000,
                responseType: 'arraybuffer',
                onload: (res) => resolve(res),
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    function pageFetch(opts) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), opts.timeout || 120000);
        const init = { method: opts.method, signal: ctl.signal, credentials: 'omit' };
        if (opts.headers) init.headers = opts.headers;
        if (opts.body) init.body = opts.body;
        return fetch(opts.url, init).finally(() => clearTimeout(timer));
    }

    // Parse a GM responseHeaders string ("Name: value\r\n...") case-insensitively.
    function parseHeaders(raw) {
        const map = {};
        if (typeof raw !== 'string') return map;
        raw.split(/\r?\n/).forEach((line) => {
            const i = line.indexOf(':');
            if (i > 0) {
                map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
        });
        return map;
    }

    // Decompress a gzip payload via the native DecompressionStream (Firefox 113+).
    async function maybeDecompress(hdrs, buf) {
        const enc = (hdrs['x-hsl-content-encoding'] || '').toLowerCase();
        if (enc !== 'gzip' || !HAS_DECOMPRESS) return buf;
        try {
            const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
            const out = await new Response(stream).arrayBuffer();
            return out;
        } catch (e) {
            return buf; // fall back to raw — the JSON parse below will surface it
        }
    }

    const POLL_ENC = HAS_DECOMPRESS ? 'gzip' : 'plain';

    // ------------------------------ channel discovery -----------------------
    // Probe the known channel ports ONCE (parallel, 1.5 s budget) and keep the
    // winner. Nothing else is ever typed or opened by the user.
    async function discoverChannel() {
        const stored = GM_getValue('hsl_channel', '');
        const candidates = [];
        if (stored) candidates.push(stored);
        for (const c of CHANNEL_CANDIDATES) {
            if (!candidates.includes(c)) candidates.push(c);
        }
        const probes = candidates.map(async (base) => {
            try {
                const res = await gmFetch({
                    method: 'GET',
                    url: `${base}/ping`,
                    timeout: DISCOVER_TIMEOUT_MS,
                });
                if (res.status === 200) {
                    const hdrs = parseHeaders(res.responseHeaders);
                    const body = JSON.parse(ab2txt(await respToArrayBuffer(res)));
                    if (body && body.ok && body.proto === 2) return base;
                }
            } catch (e) { /* unreachable port */ }
            return null;
        });
        const results = await Promise.all(probes);
        const winner = results.find((r) => r !== null);
        if (winner) {
            serverUrl = winner;
            GM_setValue('hsl_channel', winner);
        }
        return winner !== null && winner !== undefined;
    }

    // ------------------------------ bridge transport ------------------------
    // Tokenless — the connection itself is the credential.
    function pollOnce() {
        return gmFetch({
            method: 'GET',
            url: `${serverUrl}/poll?timeout=${POLL_TIMEOUT_S}&enc=${POLL_ENC}`,
            timeout: (POLL_TIMEOUT_S + 10) * 1000,
        });
    }

    function sendAck(id) {
        return gmFetch({
            method: 'POST',
            url: `${serverUrl}/ack`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id }),
            timeout: 5000,
        });
    }

    function sendReply(doc) {
        return gmFetch({
            method: 'POST',
            url: `${serverUrl}/reply`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(doc),
            timeout: 30000,
        });
    }

    // ------------------------------ remote execution ------------------------
    async function execJob(job) {
        const t0 = performance.now();
        const body = job.body_b64 ? b642ab(job.body_b64) : null;
        const headers = Object.assign({}, job.headers || {});
        const tmo = Math.max(5000, job.timeout_ms || 120000);
        try {
            // 1) extension-level request: no CORS, rides the browser's
            //    network stack so the Firefox VPN/proxy extension applies.
            let res;
            try {
                res = await gmFetch({ method: job.method, url: job.url, headers, body, timeout: tmo });
            } catch (e1) {
                if (String(e1 && e1.message) === 'timeout') throw e1;   // do not double the wait
                // 2) last resort: the page's own fetch (same network stack)
                try {
                    res = await pageFetch({ method: job.method, url: job.url, headers, body, timeout: tmo });
                } catch (e2) {
                    if (e2 && e2.name === 'AbortError') throw new Error('request timed out');
                    throw e1;
                }
            }
            // res is a GM_xmlhttpRequest result here (or a native fetch()
            // Response from the fallback) — respToArrayBuffer() reads both.
            const buf = await respToArrayBuffer(res);
            stats.done++;
            stats.lastUrl = job.url;
            stats.lastMs = Math.round(performance.now() - t0);
            return { id: job.id, status: res.status, data_b64: ab2b64(buf) };
        } catch (err) {
            stats.failed++;
            stats.lastError = String(err && err.message || err);
            return { id: job.id, error: stats.lastError };
        }
    }

    // ------------------------------ worker loop -----------------------------
    async function workerLoop() {
        while (started) {
            if (paused) {
                connected = false;
                updatePanel();
                await sleep(700);
                continue;
            }
            let res;
            try {
                res = await pollOnce();
            } catch (e) {
                channelUp = false;
                connected = false;
                updatePanel();
                // the app may have been restarted on another port — rediscover
                if (started) await discoverChannel();
                if (!serverUrl || !channelUp) await sleep(RECONNECT_MS);
                continue;
            }
            channelUp = true;
            if (res.status !== 200) {
                connected = false;
                updatePanel();
                await sleep(1500);
                continue;
            }
            const hdrs = parseHeaders(res.responseHeaders);
            let rawBuf = await respToArrayBuffer(res);
            rawBuf = await maybeDecompress(hdrs, rawBuf);
            // instant claim ack from the response header — before any
            // multi-MB parse. The app's claim lease protects this hand-off.
            const claimId = hdrs['x-hsl-job-id'] || '';
            if (claimId) {
                try { sendAck(claimId); } catch (e) { /* ack is best-effort */ }
            }
            let doc;
            try {
                doc = JSON.parse(ab2txt(rawBuf));
            } catch (e) {
                await sleep(1000);
                continue;
            }
            const job = doc && doc.job;
            if (!job || !job.id) {
                connected = true;             // long-poll answered empty
                updatePanel();
                continue;                     // server holds the poll anyway
            }
            connected = true;
            updatePanel();
            let reply;
            if (executedIds.has(job.id)) {
                // duplicate hand-off refused — the app re-queued a job this
                // page already executed; never submit the same request twice.
                reply = { id: job.id, error: 'duplicate hand-off refused (already executed in this tab)' };
            } else {
                executedIds.add(job.id);
                reply = await execJob(job);
            }
            try {
                await sendReply(reply);
            } catch (e) {
                // the app may have restarted; drop back into polling
                await sleep(500);
            }
            updatePanel();
        }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ------------------------------ UI panel --------------------------------
    // SARIF GOLD: amber-on-black neo-baroque — the same design language as
    // the app's Sarif Gold theme (gold buttons with dark text, 1px bevels,
    // explicit hover / press / focus states like the desktop UI).
    const CSS = `
    #hsl-bridge-panel {
        position: fixed; right: 14px; bottom: 14px; z-index: 2147483646;
        width: 252px; font: 11px/1.45 "Segoe UI", Meiryo, sans-serif;
        color: #f5edd9; border: 1px solid #4e3f1f; border-radius: 1px;
        background: linear-gradient(180deg, #1c160c 0%, #100d06 100%);
        box-shadow: 0 4px 18px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,220,120,.08);
        user-select: none;
    }
    #hsl-bridge-panel .hsl-head {
        display: flex; align-items: center; gap: 7px; padding: 7px 9px;
        border-bottom: 1px solid #050401; cursor: default;
        background: linear-gradient(180deg, #3a2f19 0%, #241c0f 55%, #14100a 100%);
        border-top: 2px solid #ffc93c; border-radius: 0;
    }
    #hsl-bridge-panel .hsl-title {
        font-weight: 700; letter-spacing: .8px; font-size: 10.5px; color: #f8c94b;
        text-shadow: 0 1px 0 rgba(0,0,0,.8); flex: 1;
    }
    .hsl-dot {
        width: 9px; height: 9px; border-radius: 50%; flex: none;
        background: #4a3d20; box-shadow: 0 0 0 2px rgba(0,0,0,.35);
    }
    .hsl-dot.ok  { background: #ffc93c; box-shadow: 0 0 7px 1px rgba(255,201,60,.75); animation: hslPulse 1.6s infinite; }
    .hsl-dot.wait{ background: #877654; }
    .hsl-dot.err { background: #6e3a2b; }
    @keyframes hslPulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
    #hsl-bridge-panel button, #hsl-bridge-panel input {
        font: inherit; border-radius: 1px; border: 1px solid #050401;
    }
    #hsl-bridge-panel button {
        cursor: pointer; color: #120a01; font-weight: 700; padding: 3px 10px;
        background: linear-gradient(180deg, #ffd04d 0%, #de9614 48%, #c07e0b 52%, #8f5a07 100%);
        border: 1px solid #402402;
        box-shadow: inset 0 1px 0 rgba(255,240,190,.55), 0 1px 2px rgba(0,0,0,.5);
        transition: background .12s ease, color .12s ease, border-color .12s ease,
                    box-shadow .12s ease, transform .06s ease;
    }
    #hsl-bridge-panel button:hover {
        background: linear-gradient(180deg, #ffe685 0%, #f2aa20 48%, #d68f0d 52%, #b06f0b 100%);
        border-color: #8a703a;
        box-shadow: inset 0 1px 0 rgba(255,246,210,.7), 0 0 8px rgba(255,201,60,.35);
    }
    #hsl-bridge-panel button:active {
        background: linear-gradient(180deg, #de9614 0%, #c07e0b 48%, #9c6409 52%, #6f4305 100%);
        border-color: #2a1a02;
        box-shadow: inset 0 2px 4px rgba(0,0,0,.55), 0 0 0 1px rgba(255,201,60,.25);
        transform: translateY(1px);
    }
    #hsl-bridge-panel button:focus-visible {
        outline: none; border-color: #ffc93c;
        box-shadow: 0 0 0 1px #ffc93c, inset 0 1px 0 rgba(255,240,190,.55);
    }
    #hsl-bridge-panel button.ghost {
        color: #f5edd9; background: linear-gradient(180deg, #3b311e 0%, #241c0f 100%);
        border-color: #4e3f1f; font-weight: 600; padding: 2px 7px;
        box-shadow: inset 0 1px 0 rgba(255,220,120,.12), 0 1px 2px rgba(0,0,0,.4);
    }
    #hsl-bridge-panel button.ghost:hover {
        background: linear-gradient(180deg, #524223 0%, #382d17 100%);
        border-color: #f2b832; color: #fffcf2;
        box-shadow: inset 0 1px 0 rgba(255,232,150,.25), 0 0 6px rgba(242,184,50,.25);
    }
    #hsl-bridge-panel button.ghost:active {
        background: linear-gradient(180deg, #241c0f 0%, #16110a 100%);
        border-color: #8a703a; color: #f5edd9;
        box-shadow: inset 0 2px 4px rgba(0,0,0,.6);
        transform: translateY(1px);
    }
    #hsl-bridge-panel button.ghost:focus-visible {
        outline: none; box-shadow: 0 0 0 1px #ffc93c;
    }
    #hsl-bridge-panel .hsl-body { padding: 8px 9px 9px; }
    #hsl-bridge-panel .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    #hsl-bridge-panel input {
        flex: 1; min-width: 0; background: #0a0703; color: #f5edd9; padding: 3px 7px;
        border: 1px solid #4e3f1f; box-shadow: inset 0 1px 2px rgba(0,0,0,.6);
    }
    #hsl-bridge-panel input:focus {
        outline: none; border-color: #ffc93c;
        box-shadow: inset 0 1px 2px rgba(0,0,0,.6), 0 0 0 1px rgba(255,201,60,.35);
    }
    #hsl-bridge-panel .stat { color: #c9b587; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #hsl-bridge-panel .stat b { color: #ffd04d; font-weight: 700; }
    #hsl-bridge-panel .st { font-weight: 700; }
    #hsl-bridge-panel .st.ok   { color: #ffdf66; }
    #hsl-bridge-panel .st.wait { color: #c9b587; }
    #hsl-bridge-panel .st.err  { color: #f2a03d; }
    #hsl-bridge-panel .min {
        cursor: pointer; border: none; background: none; color: #c9b587;
        font-size: 12px; padding: 0 2px; box-shadow: none;
    }
    #hsl-bridge-panel .min:hover  { color: #ffd04d; background: none; box-shadow: none; }
    #hsl-bridge-panel .min:active { color: #f2b832; transform: translateY(1px); }
    `;

    function buildPanel() {
        if ($('#hsl-bridge-panel')) return;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const p = document.createElement('div');
        p.id = 'hsl-bridge-panel';
        p.innerHTML = `
            <div class="hsl-head">
                <span class="hsl-dot"></span>
                <span class="hsl-title">HORDE STUDIO BRIDGE</span>
                <button class="min" title="Minimise / restore" tabindex="-1">\u2013</button>
            </div>
            <div class="hsl-body">
                <div class="stat st">initialising\u2026</div>
                <div class="stat lines">
                    <span class="l-done">\u2713 <b>0</b> served</span> \u2022
                    <span class="l-fail">\u2717 <b>0</b> failed</span>
                </div>
                <div class="stat l-last" title="last request">\u2014</div>
                <div class="row cfg">
                    <input class="in-server" type="text" spellcheck="false" value="${(serverUrl || '').replace(/"/g, '&quot;')}" title="App channel port — auto-discovered (app: HORDE tab → Browser Bridge). Leave as-is.">
                    <button class="btn-apply ghost">APPLY</button>
                    <button class="btn-pause">PAUSE</button>
                </div>
                <div class="row">
                    <span class="stat l-hint" style="flex:1">Keep this aihorde.net tab open — traffic rides this browser (VPN extension applies).</span>
                </div>
            </div>`;
        document.body.appendChild(p);

        const body = p.querySelector('.hsl-body');
        p.querySelector('.min').addEventListener('click', () => {
            minimized = !minimized;
            body.style.display = minimized ? 'none' : '';
            p.querySelector('.min').textContent = minimized ? '+' : '\u2013';
        });
        p.querySelector('.btn-apply').addEventListener('click', () => {
            const v = p.querySelector('.in-server').value.trim();
            if (v) {
                serverUrl = v;
                GM_setValue('hsl_channel', serverUrl);
            }
            restart();
        });
        p.querySelector('.in-server').addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') p.querySelector('.btn-apply').click();
        });
        const pauseBtn = p.querySelector('.btn-pause');
        pauseBtn.addEventListener('click', () => {
            paused = !paused;
            pauseBtn.textContent = paused ? 'RESUME' : 'PAUSE';
            if (paused) {
                connected = false;
                updatePanel();
            }
        });
        GM_registerMenuCommand('Show / hide bridge panel', () => {
            p.style.display = p.style.display === 'none' ? '' : 'none';
        });
        updatePanel();
    }

    function updatePanel() {
        const p = $('#hsl-bridge-panel');
        if (!p) return;
        const dot = p.querySelector('.hsl-dot');
        const st = p.querySelector('.st');
        dot.className = 'hsl-dot ' + (connected ? 'ok' : (channelUp ? 'wait' : 'err'));
        if (paused) {
            st.className = 'stat st wait';
            st.textContent = 'paused \u2014 press RESUME';
        } else if (!channelUp) {
            st.className = 'stat st err';
            st.textContent = 'app not reachable \u2022 retrying';
        } else if (connected) {
            st.className = 'stat st ok';
            st.textContent = 'connected \u2014 traffic rides this browser';
        } else {
            st.className = 'stat st wait';
            st.textContent = 'channel reachable \u2022 waiting for requests';
        }
        p.querySelector('.l-done b').textContent = stats.done;
        p.querySelector('.l-fail b').textContent = stats.failed;
        const last = stats.lastUrl
            ? `${stats.lastUrl.replace(/^https?:\/\//, '').slice(0, 34)} (${stats.lastMs} ms)`
            : (stats.lastError ? `last error: ${stats.lastError.slice(0, 40)}` : '\u2014');
        p.querySelector('.l-last').textContent = last;
        p.querySelector('.l-last').title = stats.lastUrl || stats.lastError || '';
    }

    function restart() {
        started = false;
        setTimeout(() => start(), 60);
    }

    function start() {
        if (started) return;
        started = true;
        for (let i = 0; i < WORKER_COUNT; i++) {
            workerLoop().catch(() => {});
        }
    }

    async function boot() {
        buildPanel();
        const found = await discoverChannel();
        if (!found) {
            // keep retrying quietly — the app may not be running yet
            updatePanel();
            const retry = setInterval(async () => {
                if (await discoverChannel()) {
                    clearInterval(retry);
                    start();
                }
            }, RECONNECT_MS);
            return;
        }
        start();
    }

    boot();
})();
