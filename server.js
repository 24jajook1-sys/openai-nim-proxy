const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: '100mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Validate API key on startup
if (!NIM_API_KEY) {
  console.warn('WARNING: NIM_API_KEY is not set. API calls will fail.');
}

const MODEL_MAPPING = {
  'gpt-3.5-turbo': { model: 'meta/llama-3.1-8b-instruct' },
  'gpt-4':         { model: 'meta/llama-3.1-70b-instruct' },
  'gpt-4-turbo':   { model: 'meta/llama-3.1-70b-instruct' },
  'gpt-4o':        { model: 'meta/llama-3.1-405b-instruct' },
  'claude-3-opus':   { model: 'meta/llama-3.1-405b-instruct' },
  'claude-3-sonnet': { model: 'meta/llama-3.1-70b-instruct' },
  'gemini-pro':      { model: 'meta/llama-3.1-70b-instruct' },
  'deepseek-v4-pro': {
    model: 'deepseek-ai/deepseek-v4-pro',
  },
  'glm-5': {
    model: 'z-ai/glm-5.2',
  },
  'minimax-m2.7': { model: 'minimaxai/minimax-m3' }
};

// Root endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'OpenAI NIM Proxy running' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    key_loaded: !!NIM_API_KEY,
    key_preview: NIM_API_KEY ? NIM_API_KEY.slice(0, 10) + '...' : 'NOT SET'
  });
});

// Debug endpoint
app.post('/debug', async (req, res) => {
  try {
    console.log('Debug endpoint called');
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
    console.error('Debug error:', err.message);
    res.status(500).json({
      success: false,
      status: err.response?.status,
      error: err.response?.data || err.message,
      key_preview: NIM_API_KEY ? NIM_API_KEY.slice(0, 10) + '...' : 'NOT SET'
    });
  }
});

// List available models
app.get('/v1/models', (req, res) => {
  try {
    const models = Object.keys(MODEL_MAPPING).map(model => ({
      id: model,
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }));
    res.json({ object: 'list', data: models });
  } catch (err) {
    console.error('Models error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('Chat completion request received');
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'messages field is required and must be a non-empty array',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    if (!NIM_API_KEY) {
      return res.status(500).json({
        error: {
          message: 'NIM_API_KEY not configured on server',
          type: 'server_error',
          code: 500
        }
      });
    }

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

    console.log(`Forwarding to NIM API: ${mapped.model}`);

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
      response.data.on('error', (err) => {
        console.error('Stream error:', err.message);
        res.end();
      });
    } else {
      const choices = response.data.choices || [];
      const responseBody = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: choices.map(c => ({
          index: c.index,
          message: { 
            role: c.message?.role || 'assistant', 
            content: c.message?.content || '' 
          },
          finish_reason: c.finish_reason
        })),
        usage: response.data.usage || {}
      };
      res.json(responseBody);
    }
  } catch (err) {
    console.error('Chat completion error:', err.message);
    const statusCode = err.response?.status || 500;
    res.status(statusCode).json({
      error: {
        message: err.message || 'Internal server error',
        type: 'invalid_request_error',
        code: statusCode
      }
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      message: err.message || 'Internal server error',
      type: 'server_error',
      code: 500
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n✅ Proxy running on port ${PORT}`);
  console.log(`🔑 API Key loaded: ${!!NIM_API_KEY}`);
  console.log(`📡 NIM API Base: ${NIM_API_BASE}`);
  console.log(`\n📝 Available endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
