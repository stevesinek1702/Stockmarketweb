/**
 * cache.js — Lightweight client-side cache (memory + localStorage) with a
 * stale-while-revalidate (SWR) helper, to make tab switches and page reloads
 * feel instant instead of waiting on the network every time.
 *
 * Strategy:
 *   - Data is kept both in an in-memory Map (instant within a session) and in
 *     localStorage (survives a page reload), each stamped with a timestamp.
 *   - swr(key, fetcher, ttlMs, onData):
 *       * If a cached value exists, it is served IMMEDIATELY via onData so the
 *         UI paints with no network wait.
 *       * If that cached value is still "fresh" (younger than ttlMs) the network
 *         call is skipped entirely.
 *       * If it is stale (older than ttlMs), the fetcher runs in the background
 *         and onData is called a second time with the fresh data.
 *       * On a fetch error, the stale cached value is kept (graceful fallback).
 *
 * Exposed as window.StockCache. Pure-ish browser module (no dependencies).
 */
(function () {
    'use strict';

    var PREFIX = 'vnstock_cache_';
    var memory = new Map();

    function lsKey(key) { return PREFIX + key; }

    /** Read an entry { data, ts } from memory, falling back to localStorage. */
    function read(key) {
        if (memory.has(key)) return memory.get(key);
        try {
            var raw = localStorage.getItem(lsKey(key));
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed.ts === 'number') {
                memory.set(key, parsed);       // promote to memory
                return parsed;
            }
        } catch (e) {
            // corrupt/oversized entry — ignore
        }
        return null;
    }

    /** Write { data, ts } to memory and (best-effort) localStorage. */
    function write(key, data) {
        var entry = { data: data, ts: Date.now() };
        memory.set(key, entry);
        try {
            localStorage.setItem(lsKey(key), JSON.stringify(entry));
        } catch (e) {
            // Quota exceeded or non-serialisable — memory cache still works.
        }
    }

    /** Return cached data if it exists and is younger than ttlMs, else null. */
    function getFresh(key, ttlMs) {
        var entry = read(key);
        if (entry && (Date.now() - entry.ts) < ttlMs) return entry.data;
        return null;
    }

    /** Return cached data regardless of age (or null). */
    function getStale(key) {
        var entry = read(key);
        return entry ? entry.data : null;
    }

    /** Age of the cached entry in ms, or Infinity if none. */
    function age(key) {
        var entry = read(key);
        return entry ? (Date.now() - entry.ts) : Infinity;
    }

    function set(key, data) { write(key, data); }

    function remove(key) {
        memory.delete(key);
        try { localStorage.removeItem(lsKey(key)); } catch (e) { /* ignore */ }
    }

    /**
     * Stale-while-revalidate fetch.
     * @param {string} key
     * @param {() => Promise<any>} fetcher  resolves with the data to cache
     * @param {number} ttlMs                freshness window
     * @param {(data:any, meta:{fromCache:boolean, fresh:boolean}) => void} [onData]
     * @returns {Promise<any>} resolves with the freshest data obtained
     */
    function swr(key, fetcher, ttlMs, onData) {
        var entry = read(key);
        var now = Date.now();

        if (entry) {
            var fresh = (now - entry.ts) < ttlMs;
            if (typeof onData === 'function') {
                try { onData(entry.data, { fromCache: true, fresh: fresh }); } catch (e) { /* ignore */ }
            }
            if (fresh) {
                // Fresh enough — no network at all.
                return Promise.resolve(entry.data);
            }
        }

        // No cache, or stale: refresh from the network.
        return Promise.resolve()
            .then(fetcher)
            .then(function (data) {
                write(key, data);
                if (typeof onData === 'function') {
                    try { onData(data, { fromCache: false, fresh: true }); } catch (e) { /* ignore */ }
                }
                return data;
            })
            .catch(function (err) {
                // Keep serving stale data on failure if we have any.
                if (entry) return entry.data;
                throw err;
            });
    }

    window.StockCache = {
        swr: swr,
        get: getStale,
        getFresh: getFresh,
        getStale: getStale,
        set: set,
        remove: remove,
        age: age,
        PREFIX: PREFIX
    };
})();
