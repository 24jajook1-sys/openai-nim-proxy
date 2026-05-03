# Complete OpenAI to NVIDIA NIM Proxy Deployment Guide

## What This Does
Creates a free API proxy that translates OpenAI-style requests to NVIDIA NIM API, allowing you to use NVIDIA's AI models in apps like Janitor AI.

**Features:**
- ✅ OpenAI-compatible API format
- ✅ Automatic model mapping and smart fallback
- ✅ Optional thinking/reasoning display for advanced models
- ✅ Support for streaming and non-streaming responses
- ✅ Free to deploy and use

---

## Step 1: Get Your NVIDIA API Key

### 1.1 Create NVIDIA Developer Account
1. Go to **https://developer.nvidia.com/**
2. Click **"Sign Up"** in the top right
3. Fill out the registration form
4. Verify your email

### 1.2 Get API Key
1. After logging in, visit **https://build.nvidia.com/explore/discover**
2. Click on any model (like "Llama 3.1")
3. Click **"Get API Key"** button
4. **Copy and save** your API key somewhere safe

---

## Step 2: Set Up GitHub Repository

### 2.1 Create GitHub Account
1. Go to **https://github.com/**
2. Click **"Sign up"**
3. Create username, enter email, create password
4. Verify your account

### 2.2 Create New Repository
1. After logging in, click the green **"New"** button
2. Repository name: `openai-nim-proxy`
3. Description: `OpenAI compatible proxy for NVIDIA NIM API`
4. Select **"Public"**
5. Check **"Add a README file"**
6. Click **"Create repository"**

---

## Step 3: Add Your Code Files

### 3.1 Create server.js
1. In your repository, click **"Add file"** → **"Create new file"**
2. Name: `server.js`
3. Copy and paste this entire code:

```javascript
// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = false; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
    key_loaded: !!NIM_API_KEY,
    key_preview: NIM_API_KEY ? NIM_API_KEY.slice(0, 10) + '...' : 'NOT SET'
  });
});

// Debug endpoint - tests NVIDIA API directly
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

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
          validateStatus: (status) => status < 500
        }).then(res => {
          if (res.status >= 200 && res.status < 300) {
            nimModel = model;
          }
        });
      } catch (e) {}
      
      if (!nimModel) {
        const modelLower = model.toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }
    
    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform NIM response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
```

4. Click **"Commit new file"**

### 3.2 Create package.json
1. Click **"Add file"** → **"Create new file"**
2. Name: `package.json`
3. Copy and paste:

```json
{
  "name": "openai-nim-proxy",
  "version": "1.0.0",
  "description": "OpenAI compatible proxy for NVIDIA NIM API",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "axios": "^1.6.0"
  },
  "engines": {
    "node": "18.x"
  }
}
```

4. Click **"Commit new file"**

---

## Step 4: Deploy to Railway

### 4.1 Sign Up for Railway
1. Go to **https://railway.app/**
2. Click **"Start a New Project"**
3. Click **"Login with GitHub"**
4. Authorize Railway to access your GitHub

### 4.2 Create New Project
1. Click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. Choose your `openai-nim-proxy` repository
4. Click **"Deploy Now"**

### 4.3 Add Environment Variable
1. Once deployed, click on your project
2. Go to **"Variables"** tab
3. Click **"New Variable"**
4. Variable name: `NIM_API_KEY`
5. Variable value: Paste your NVIDIA API key from Step 1
6. Click **"Add"**

### 4.4 Wait for Deployment
1. Go to **"Deployments"** tab
2. Wait for status to show **"SUCCESS"** (2-3 minutes)

---

## Step 5: Get Your API URL

### 5.1 Generate Domain
1. In Railway, go to **"Settings"** tab
2. Scroll to **"Networking"** or **"Domains"**
3. Click **"Generate Domain"**
4. Copy the URL (looks like: `https://openai-nim-proxy-production-xxxx.up.railway.app`)

### 5.2 Test Your Proxy
1. Open browser, go to: `https://your-domain.up.railway.app/health`
2. You should see:
```json
{
  "status": "ok",
  "service": "OpenAI to NVIDIA NIM Proxy",
  "reasoning_display": false,
  "thinking_mode": false
}
```

---

## Step 6: Configure Janitor AI

### 6.1 Open Janitor AI App
1. Open Janitor AI on your Android device
2. Go to **Settings** → **API Configuration**

### 6.2 Enter Your Proxy Details
- **API Type**: Select "OpenAI" or "Custom OpenAI"
- **Base URL**: `https://your-domain.up.railway.app`
- **API Key**: Enter anything (e.g., `dummy-key`)
- **Model**: Choose `gpt-4o`, `gpt-4`, or `claude-3-opus`

### 6.3 Test
1. Start a conversation in Janitor AI
2. If it responds, you're all set! 🎉

---

## Configuration Options

### Reasoning Display (Line 17 in server.js)
```javascript
const SHOW_REASONING = false; // Change to true to see thinking process
```

**When true:**
- Shows model's reasoning in `<think>` tags
- Format:
  ```
  <think>
  [reasoning process]
  </think>

  [final answer]
  ```

**When false (default):**
- Only shows final answer
- Cleaner output

### Thinking Mode (Line 20 in server.js)
```javascript
const ENABLE_THINKING_MODE = false; // Change to true for models with thinking toggle
```

**When true:**
- Sends `extra_body: { chat_template_kwargs: { thinking: true } }` parameter
- Required for some models like QwQ or specific thinking-enabled models
- Most models work fine without this

**When false (default):**
- Normal operation
- Works for 99% of models

### Model Mapping (Lines 23-31)
You can customize which NVIDIA models are used:

```javascript
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  // Add more mappings here
};
```

---

## Available Models in Your Proxy

| Janitor AI Model | Maps to NVIDIA Model |
|------------------|----------------------|
| gpt-3.5-turbo | Llama Nemotron 253B |
| gpt-4 | Qwen3 Coder 480B |
| gpt-4-turbo | Kimi K2 |
| gpt-4o | DeepSeek V3.1 |
| claude-3-opus | GPT-OSS 120B |
| claude-3-sonnet | GPT-OSS 20B |
| gemini-pro | Qwen3 Next 80B Thinking |

---

## Troubleshooting

### Issue: 404 Error on Root URL
**Solution**: This is normal! Test `/health` endpoint instead.

### Issue: Proxy Error 500
**Solutions:**
1. Check Railway logs for errors
2. Verify `NIM_API_KEY` is set correctly
3. Check if NVIDIA API key has credits

### Issue: No Response in Janitor AI
**Solutions:**
1. Verify URL is correct (no trailing slash)
2. Test health endpoint first
3. Check Railway deployment is running
4. Try a different model name

### Issue: Railway Credits Running Out
**Solutions:**
1. Deploy to Vercel: https://vercel.com/
2. Deploy to Render: https://render.com/
3. Deploy to Fly.io: https://fly.io/

### Issue: Can't Find Domain in Railway
**Solution:**
1. Go to Settings → Networking
2. Click "Generate Domain"
3. If not visible, check Deployments tab for URL

---

## Alternative Free Hosting Platforms

### Vercel
1. Go to https://vercel.com/
2. Import your GitHub repo
3. Add `NIM_API_KEY` environment variable
4. Deploy

### Render
1. Go to https://render.com/
2. Create new Web Service
3. Connect GitHub repo
4. Add `NIM_API_KEY` environment variable
5. Deploy

### Fly.io
1. Go to https://fly.io/
2. Install Fly CLI
3. Run `fly launch`
4. Add secret: `fly secrets set NIM_API_KEY=your_key`

---

## Usage Limits

### Railway Free Tier
- $5 credit per month
- Usually enough for personal use
- ~750 hours of runtime

### NVIDIA NIM Free Tier
- Varies by model
- Check https://build.nvidia.com/ for limits
- Some models have daily request limits

---

## Need Help?

- **Railway Issues**: https://discord.gg/railway
- **GitHub Issues**: https://docs.github.com/
- **NVIDIA NIM**: https://build.nvidia.com/

---

## Quick Reference

### Your URLs
- **Health Check**: `https://your-domain.up.railway.app/health`
- **Models List**: `https://your-domain.up.railway.app/v1/models`
- **Chat Endpoint**: `https://your-domain.up.railway.app/v1/chat/completions`

### For Janitor AI
- **Base URL**: Your Railway domain (no /v1 at end)
- **API Key**: Any string
- **Model**: Choose from mapped models

Your proxy is now live and ready to use! 🚀
