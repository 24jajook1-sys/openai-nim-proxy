const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'User-Agent', 'Accept'],
  credentials: false,
  maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Origin:', req.get('origin') || 'none');
  console.log('User-Agent:', req.get('user-agent') || 'none');
  console.log('Content-Type:', req.get('content-type') || 'none');
  next();
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Validate API key on startup
if (!NIM_API_KEY) {
  console.warn('WARNING: NIM_API_KEY is not set. API calls will fail.');
} else {
  console.log('✓ NIM_API_KEY is set');
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
    key_preview: NIM_API_KEY ? NIM_API_KEY.slice(0, 10) + '...' : 'NOT SET',
    port: PORT,
    cors_enabled: true
  });
});

// Test NIM API connection
app.get('/test-nim', async (req, res) => {
  try {
    console.log('\n🧪 Testing NIM API connection...');
    console.log(`Connecting to: ${NIM_API_BASE}/chat/completions`);
    
    if (!NIM_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'NIM_API_KEY not configured',
        details: 'Set NIM_API_KEY environment variable'
      });
    }

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: 'meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 10
    }, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    console.log('✅ NIM API connection successful!');
    res.json({
      success: true,
      message: 'NIM API is reachable and responding',
      response_status: response.status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ NIM API connection failed:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      error_code: err.code,
      status: err.response?.status,
      nim_error: err.response?.data
    });
  }
});

// Debug endpoint - logs incoming request
app.post('/v1/debug/request', (req, res) => {
  console.log('=== INCOMING REQUEST DEBUG ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('========================');
  res.json({
    received: true,
    headers: req.headers,
    body: req.body,
    timestamp: new Date().toISOString()
  });
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
    console.log('\n=== CHAT COMPLETION REQUEST ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Method: POST');
    console.log('Path: /v1/chat/completions');
    console.log('Full Body:', JSON.stringify(req.body, null, 2));
    console.log('Authorization Header Present:', !!req.get('authorization'));
    
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      console.error('❌ Invalid messages field');
      return res.status(400).json({
        error: {
          message: 'messages field is required and must be a non-empty array',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    if (!NIM_API_KEY) {
      console.error('❌ NIM_API_KEY not set');
      return res.status(500).json({
        error: {
          message: 'NIM_API_KEY not configured on server',
          type: 'server_error',
          code: 500
        }
      });
    }

    const mapped = MODEL_MAPPING[model] || { model: 'meta/llama-3.1-8b-instruct' };
    console.log(`✓ Model: ${model} -> ${mapped.model}`);

    const nimRequest = {
      model: mapped.model,
      messages: messages,
      temperature: temperature || 1,
      top_p: req.body.top_p || 1,
      max_tokens: max_tokens || 16384,
      stream: stream || false,
      ...(mapped.extra_body && { extra_body: mapped.extra_body })
    };

    console.log(`📡 Forwarding to NIM API: ${NIM_API_BASE}/chat/completions`);

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
      console.log('✅ Successfully sent response');
      res.json(responseBody);
    }
  } catch (err) {
    console.error('❌ Chat completion error:', err.message);
    console.error('Error code:', err.code);
    console.error('NIM API response:', err.response?.data);
    const statusCode = err.response?.status || 500;
    res.status(statusCode).json({
      error: {
        message: err.message || 'Internal server error',
        type: 'invalid_request_error',
        code: statusCode,
        details: err.response?.data
      }
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
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
  console.log(`🌐 Public URL: https://openai-nim-proxy-production-c734.up.railway.app`);
  console.log(`\n📝 Available endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /test-nim (test NIM API connection)`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  POST /v1/debug/request (logs incoming requests)`);
  console.log(`\n✓ CORS enabled for all origins`);
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
