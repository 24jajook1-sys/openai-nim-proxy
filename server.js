const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔎 Request logger — logs EVERY incoming connection, including preflights
// and malformed requests. This is your source of truth for "did the request
// even arrive" debugging (e.g. the Janitor AI investigation).
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} from ${req.ip}`);
  next();
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔐 Optional proxy auth. Set PROXY_SECRET in Railway's env vars and put the
// same string in Janitor AI's API key field instead of a dummy value. If
// PROXY_SECRET is unset, auth is skipped (useful while testing).
const PROXY_SECRET = process.env.PROXY_SECRET;

const MODEL_MAPPING = {
  'gpt-3.5-turbo':   { model: 'meta/llama-3.1-8b-instruct' },
  'gpt-4':           { model: 'meta/llama-3.1-70b-instruct' },
  'gpt-4-turbo':     { model: 'meta/llama-3.1-70b-instruct' },
  'gpt-4o':          { model: 'meta/llama-3.1-405b-instruct' },
  'claude-3-opus':   { model: 'meta/llama-3.1-405b-instruct' },
  'claude-3-sonnet': { model: 'meta/llama-3.1-70b-instruct' },
  'gemini-pro':      { model: 'meta/llama-3.1-70b-instruct' },
  'deepseek-v4-pro': { model: 'deepseek-ai/deepseek-v4-pro' },
  'glm-5': {
    model: 'z-ai/glm-5.2',
    extra_body: { chat_template_kwargs: { enable_thinking: true, clear_thinking: false } }
  },
  'minimax-m2.7':    { model: 'minimaxai/minimax-m2.7' },
  'minimax-m3':      { model: 'minimaxai/minimax-m3' },
  'mistral-large':   { model: 'mistralai/mistral-large-3-675b-instruct-2512' },
  'llama4-maverick': { model: 'meta/llama-4-maverick-17b-128e-instruct' },
  'kimi-k2':         { model: 'moonshotai/kimi-k2.6' }
};

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    key_loaded: !!NIM_API_KEY,
    auth_required: !!PROXY_SECRET
    // Note: no key preview here anymore — don't leak key material on an
    // open endpoint, even partially.
  });
});

// ⚠️ /debug is gated behind PROXY_SECRET now. It makes a real, billed NIM
// call and previously leaked part of your API key to anyone with the URL.
// If PROXY_SECRET isn't set, this route is disabled entirely.
app.get('/debug', async (req, res) => {
  if (!PROXY_SECRET || req.headers.authorization !== `Bearer ${PROXY_SECRET}`) {
    return res.status(404).json({ error: { message: 'Not found' } });
  }
  try {
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: 'meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 5
    }, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    res.json({ success: true, response: response.data });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: err.response?.status,
      error: err.response?.data || err.message
    });
  }
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// 🔐 Auth check for the actual proxy endpoint. Skipped if PROXY_SECRET unset.
function checkProxyAuth(req, res, next) {
  if (PROXY_SECRET && req.headers.authorization !== `Bearer ${PROXY_SECRET}`) {
    return res.status(401).json({ error: { message: 'Unauthorized', type: 'invalid_request_error' } });
  }
  next();
}

// Shared handler, registered on multiple paths below — some OpenAI-compatible
// clients POST to {baseURL}/v1/chat/completions, others POST to
// {baseURL}/chat/completions, and some (like what you just hit) POST
// directly to {baseURL} with nothing appended. Handling all three removes
// the guesswork.
async function callNimWithRetry(nimRequest, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: nimRequest.stream ? 'stream' : 'json',
        timeout: 300000
      });
    } catch (err) {
      if (err.response?.status !== 429 || attempt === retries) throw err;
      const retryAfter = err.response.headers?.['retry-after'];
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : (attempt + 1) * 2000;
      console.log(`429 from NIM (attempt ${attempt + 1}/${retries}), retrying in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function handleChatCompletions(req, res) {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    const mapped = MODEL_MAPPING[model] || { model: 'meta/llama-3.1-8b-instruct' };

    const nimRequest = {
      model: mapped.model,
      messages: messages,
      temperature: temperature || 1,
      top_p: req.body.top_p || 1,
      max_tokens: max_tokens || 16384,
      stream: stream || false,
      ...(mapped.extra_body && { extra_body: mapped.extra_body })
    };

    const response = await callNimWithRetry(nimRequest);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.on('data', chunk => res.write(chunk));
      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(c => ({
          index: c.index,
          message: { role: c.message.role, content: c.message.content },
          finish_reason: c.finish_reason
        })),
        usage: response.data.usage || {}
      });
    }
  } catch (err) {
    console.error('NIM request failed:', err.response?.status, err.response?.data || err.message);
    const retryAfter = err.response?.headers?.['retry-after'];
    res.status(err.response?.status || 500).json({
      error: {
        message: err.response?.data?.error?.message || err.response?.data?.message || err.message,
        type: 'invalid_request_error',
        code: err.response?.status || 500,
        ...(retryAfter && { retry_after_seconds: retryAfter })
      }
    });
  }
}

app.post('/v1/chat/completions', checkProxyAuth, handleChatCompletions);
app.post('/chat/completions', checkProxyAuth, handleChatCompletions);
app.post('/', checkProxyAuth, handleChatCompletions);

// 404 fallback for anything unmatched — logs and returns JSON, not HTML.
app.use((req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

// Catches synchronous errors (e.g. malformed JSON bodies from express.json())
// so clients always get a JSON error instead of Express's default HTML page.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: { message: err.message, type: 'invalid_request_error' } });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Key loaded: ${!!NIM_API_KEY}`);
  console.log(`Auth required: ${!!PROXY_SECRET}`);
});

module.exports = app;
