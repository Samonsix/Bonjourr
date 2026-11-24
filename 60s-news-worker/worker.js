// 60s API -> Bonjourr 名言格式 [{ author, content }]
// 用法: https://<worker域名>/quotes?source=60s|weibo|zhihu|all&limit=20
//       &random=1 表示每次访问从新闻池随机取 1 条（池本身仍缓存 15 分钟）
// 本文件为 worker.ts 的纯 JS 版本，可直接粘贴到 Cloudflare Dashboard 的在线编辑器

// 上游公共实例列表，按顺序尝试，首个成功的会被优先复用
// （主域名 60s.viki.moe 近期在部分地区不稳定，故保留多个备用）
const BASES = [
    'https://60s.viki.moe',
    'https://60s.crystelf.top',
    'https://60s.mizhoubaobei.top',
    'https://api.elysiayanyu.top',
    'https://60s.zellon.top',
    'https://60s.superjeason.qzz.io',
    'https://60s.okbaike.com',
    'https://api.cczo.cc/60s',
]

let preferredBase = BASES[0]

// 上游数据缓存时长（秒），缓存分桶到期后自动重新拉取
const CACHE_TTL = 900

const SOURCES = {
    '60s': { label: '60s读世界', path: '/v2/60s' },
    weibo: { label: '微博热搜', path: '/v2/weibo' },
    zhihu: { label: '知乎热榜', path: '/v2/zhihu' },
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
    }
}

// 拉取单个数据源并转换成 Bonjourr 格式，实例失败自动换下一个
// errors 数组可选，用于收集失败原因（调试用）
async function fetchSource(config, errors) {
    const bases = [preferredBase, ...BASES.filter((base) => base !== preferredBase)]

    for (const base of bases) {
        try {
            const response = await fetch(base + config.path, {
                headers: { 'User-Agent': 'news-quotes-worker/1.0' },
                signal: AbortSignal.timeout(8000),
            })

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }

            const json = await response.json()

            // /v2/60s 的数据在 data.news 字符串数组里
            let quotes = []

            if (config.path === '/v2/60s') {
                quotes = (json.data?.news ?? []).map((news) => ({ author: config.label, content: news }))
            } else {
                // 热榜类接口是 data: [{ title, ... }] 数组
                const list = Array.isArray(json.data) ? json.data : []
                quotes = list
                    .map((item) => ({ author: config.label, content: item.title ?? '' }))
                    .filter((quote) => quote.content.length > 0)
            }

            if (quotes.length === 0) {
                throw new Error('empty data')
            }

            preferredBase = base
            return quotes
        } catch (error) {
            errors?.push(`${config.label} @ ${base}: ${error.message ?? error}`)
        }
    }

    return []
}

async function buildQuotes(source, limit, errors) {
    if (source === 'all') {
        const results = await Promise.all(
            Object.values(SOURCES).map((config) => fetchSource(config, errors)),
        )

        const seen = new Set()
        const merged = []

        for (const quotes of results) {
            for (const quote of quotes) {
                if (seen.has(quote.content)) {
                    continue
                }

                seen.add(quote.content)
                merged.push(quote)
            }
        }

        return merged.slice(0, limit)
    }

    const config = SOURCES[source]

    if (!config) {
        throw new Error(`unknown source: ${source}`)
    }

    return (await fetchSource(config, errors)).slice(0, limit)
}

// 从新闻池随机取 1 条，响应本身不缓存
function randomQuoteResponse(quotes) {
    const index = Math.floor(Math.random() * quotes.length)

    return new Response(JSON.stringify([quotes[index]]), {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...corsHeaders(),
        },
    })
}

export default {
    async fetch(request, _env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders() })
        }

        const url = new URL(request.url)

        if (url.pathname !== '/quotes') {
            return new Response(JSON.stringify({ usage: '/quotes?source=60s|weibo|zhihu|all&limit=20&random=1' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
            })
        }

        const source = url.searchParams.get('source') ?? '60s'
        const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50)
        const random = url.searchParams.get('random') === '1'

        // 按 TTL 分桶生成缓存键，桶变化后缓存未命中即重新拉取上游
        const bucket = Math.floor(Date.now() / (CACHE_TTL * 1000))
        const cacheKey = new URL(`${url.origin}/quotes?source=${source}&limit=${limit}&bucket=${bucket}`)

        const cached = await caches.default.match(cacheKey)

        if (cached) {
            return random ? randomQuoteResponse(await cached.json()) : cached
        }

        try {
            const errors = []
            const quotes = await buildQuotes(source, limit, errors)

            if (quotes.length === 0) {
                throw new Error(errors.length > 0 ? errors.join(' | ') : 'upstream returned no data')
            }

            const poolResponse = new Response(JSON.stringify(quotes), {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': `public, max-age=${CACHE_TTL}`,
                    ...corsHeaders(),
                },
            })

            ctx.waitUntil(caches.default.put(cacheKey, poolResponse.clone()))

            return random ? randomQuoteResponse(quotes) : poolResponse
        } catch (error) {
            return new Response(JSON.stringify({ error: String(error) }), {
                status: 502,
                headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
            })
        }
    },
}
