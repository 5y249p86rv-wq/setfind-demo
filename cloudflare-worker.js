// Cloudflare Worker: 转发 iPad PWA 录音到百度短语音识别 (pro_api 极速版)
// 解决 iOS Safari/PWA 跨域 fetch 限制

let cachedToken = null;
let tokenExpireAt = 0;

async function getBaiduToken(apiKey, secretKey) {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) return cachedToken;
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;
  const resp = await fetch(url, { method: 'POST' });
  const data = await resp.json();
  if (data.access_token) {
    cachedToken = data.access_token;
    tokenExpireAt = now + 29 * 24 * 60 * 60 * 1000;
  } else {
    throw new Error('获取百度 access_token 失败: ' + JSON.stringify(data));
  }
  return cachedToken;
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/recognize') {
      return new Response('Not Found. POST to /recognize with { speech, format, rate, channel, len }', { status: 404, headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const apiKey = env.BAIDU_API_KEY;
      const secretKey = env.BAIDU_SECRET_KEY;
      if (!apiKey || !secretKey) {
        return new Response(JSON.stringify({ error: '缺少 BAIDU_API_KEY 或 BAIDU_SECRET_KEY 环境变量' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const body = await request.json();
      const { speech, format = 'wav', rate = 16000, channel = 1, len = 0 } = body;
      if (!speech) {
        return new Response(JSON.stringify({ error: '缺少 speech 字段' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const token = await getBaiduToken(apiKey, secretKey);
      const baiduResp = await fetch('https://vop.baidu.com/pro_api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format, rate, channel, len, speech,
          cuid: 'setfind-demo-ipad',
          dev_pid: 80001,
          token: token,
        }),
      });
      const data = await baiduResp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || 'Unknown error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};