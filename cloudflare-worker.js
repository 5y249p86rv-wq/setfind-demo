// Cloudflare Worker: 转发 iPad PWA 录音到百度短语音识别 (pro_api 极速版)
// 解决 iOS Safari/PWA 跨域 fetch 限制
// 使用 RAW 方式上传音频 (Content-Type: audio/pcm;rate=16000), 省掉前端 base64 编码

let cachedToken = null;
let tokenExpireAt = 0;
// 预热 token: 在 token 即将过期前提前异步续期, 不阻塞请求
let refreshingPromise = null;

async function getBaiduToken(apiKey, secretKey) {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) return cachedToken;
  if (refreshingPromise) return refreshingPromise;
  refreshingPromise = (async () => {
    const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;
    const resp = await fetch(url, { method: 'POST' });
    const data = await resp.json();
    if (data.access_token) {
      cachedToken = data.access_token;
      // 提前 5 分钟续期, 避免临界过期
      tokenExpireAt = now + 29 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
      console.log('[worker] token refreshed, expires at', new Date(tokenExpireAt).toISOString());
    } else {
      throw new Error('获取百度 token 失败: ' + JSON.stringify(data));
    }
    refreshingPromise = null;
    return cachedToken;
  })();
  return refreshingPromise;
}

// 预热: Worker 启动后立即异步获取 token, 不占用首次请求
async function warmup(env) {
  try {
    if (env.BAIDU_API_KEY && env.BAIDU_SECRET_KEY && !cachedToken) {
      await getBaiduToken(env.BAIDU_API_KEY, env.BAIDU_SECRET_KEY);
    }
  } catch (_) {}
}

export default {
  async fetch(request, env, ctx) {
    // 首次调用时预热 token
    ctx.waitUntil(warmup(env));

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/recognize') {
      return new Response('Not Found. POST raw PCM audio with Content-Type: audio/pcm;rate=16000', {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    const t0 = Date.now();
    try {
      const apiKey = env.BAIDU_API_KEY;
      const secretKey = env.BAIDU_SECRET_KEY;
      if (!apiKey || !secretKey) {
        return new Response(JSON.stringify({ error: '缺少环境变量' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const contentType = request.headers.get('Content-Type') || '';
      const rateMatch = contentType.match(/rate=(\d+)/);
      const rate = rateMatch ? parseInt(rateMatch[1]) : 16000;

      // RAW 方式: 音频在 request body 中 (binary)
      // 走 Content-Length 拿 len
      const lenHeader = request.headers.get('Content-Length');
      const len = lenHeader ? parseInt(lenHeader) : 0;
      if (len <= 0) {
        return new Response(JSON.stringify({ error: '音频为空', err_no: 3314 }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const token = await getBaiduToken(apiKey, secretKey);
      const t1 = Date.now();
      // 直接转发原始音频 (binary) 到百度, 走 RAW 方式
      const body = await request.arrayBuffer();
      const t2 = Date.now();
      const baiduResp = await fetch(
        `https://vop.baidu.com/pro_api?cuid=setfind-demo-ipad&dev_pid=80001&token=${token}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': `audio/pcm;rate=${rate}`,
          },
          body: body,
        }
      );
      const t3 = Date.now();
      const data = await baiduResp.json();
      const t4 = Date.now();
      console.log(`[worker] token=${t1 - t0}ms readBody=${t2 - t1}ms baidu=${t3 - t2}ms parse=${t4 - t3}ms total=${t4 - t0}ms`);
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('[worker] error:', e);
      return new Response(JSON.stringify({ error: e.message || 'Unknown error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};