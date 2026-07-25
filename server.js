const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: '100mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

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
  'kimi-k2':         { model: 'moonshotai/kimi-k2.6' },
  'deepseek-v4-prof':         { model: 'deepseek-ai/deepseek-v4-flash' }
};

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    key_loaded: !!NIM_API_KEY,
    key_preview: NIM_API_KEY ? NIM_API_KEY.slice(0, 10) + '...' : 'NOT SET'
  });
});

app.get('/debug', async (req, res) => {
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
      error: err.response?.data || err.message,
      key_preview: NIM_API_KEY ? NIM_API_KEY.slice(0, 10) + '...' : 'NOT SET'
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

app.post('/v1/chat/completions', async (req, res) => {
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

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 300000
    });

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
    res.status(err.response?.status || 500).json({
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: err.response?.status || 500
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Key loaded: ${!!NIM_API_KEY}`);
});

module.exports = app;
