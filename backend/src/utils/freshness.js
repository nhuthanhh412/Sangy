const LEGACY_STATUS_MAP = {
    fresh: 'fresh',
    cached: 'cached',
    stale: 'stale',
    fresh_empty: 'fresh',
    fetch_failed_fallback_cache: 'stale'
};

export function buildFreshnessContract({
    freshness_status = 'cached',
    data_source = 'local_cache',
    synced_at = null,
    stale_reason = null
} = {}) {
    const status = LEGACY_STATUS_MAP[freshness_status] || 'cached';

    return {
        status, // backward-compatible status for old UI
        freshness_status,
        source: data_source,
        data_source,
        stale_reason,
        synced_at
    };
}
