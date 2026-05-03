const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'gpt-4': 'meta/llama-3.1-70b-instruct',
  'gpt-4-turbo': 'meta/llama-3.1-70b-instruct',
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct',
  'gemini-pro': 'meta/llama-3.1-70b-instruct'
};

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
    const nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-8b-instruct';

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
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
