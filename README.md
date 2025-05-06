# Voice Agents System

An integrated voice agent system for both inbound support and outbound sales calls, powered by ElevenLabs conversational AI.

## Technology Stack

- **Inbound Agent**: OpenPhone for handling incoming support calls
- **Outbound Agent**: Twilio for making outbound sales calls
- **Deployment**: Render for cloud hosting
- **Workflow Automation**: n8n CLI for building and maintaining workflows
- **Voice/AI**: ElevenLabs for text-to-speech and conversational AI
- **Knowledge Base**: Vector database (Pinecone) for storing and retrieving information

## System Architecture

The system consists of several interconnected components:

1. **Core Backend Service**: Node.js API server handling both inbound and outbound calls
2. **n8n Workflows**: For orchestrating interactions and scheduling outbound calls
3. **Knowledge Base**: Vector database with embeddings for agent responses
4. **ElevenLabs Integration**: For voice synthesis and conversational AI

## Features

- **Inbound Support Agent**:
  - Handles incoming calls via OpenPhone
  - Engages customers with AI-powered conversation
  - Accesses knowledge base to provide accurate information

- **Outbound Sales Agent**:
  - Initiates calls to leads via Twilio
  - Conducts sales conversations using ElevenLabs AI
  - Follows scripts from the knowledge base with dynamic responses

- **Knowledge Management**:
  - Vector database for semantic search
  - Automated updates via n8n workflows
  - Supports multiple data formats (JSON, CSV, TXT)

## Setup & Installation

### Prerequisites

- Node.js 18 or later
- Accounts with OpenPhone, Twilio, ElevenLabs, and Pinecone
- n8n CLI (for workflow development)
- Render account (for deployment)

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/voice-agents-system.git
   cd voice-agents-system
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys and configuration
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

### n8n Workflow Setup

1. Install n8n CLI:
   ```bash
   npm install -g n8n
   ```

2. Start n8n server:
   ```bash
   n8n start
   ```

3. Import the workflow files from the `n8n-workflows` directory

### Deployment

The project is configured for deployment on Render using the included `render.yaml` file:

1. Push the code to a Git repository
2. Link the repository to Render
3. Use the Blueprint to deploy both the API and n8n services

## Environment Variables

Important environment variables required for the application:

```
# Server Configuration
PORT=3000
NODE_ENV=development

# Twilio (Outbound Agent)
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number

# OpenPhone (Inbound Agent)
OPENPHONE_API_KEY=your_openphone_api_key
OPENPHONE_WEBHOOK_SECRET=your_openphone_webhook_secret

# ElevenLabs
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_elevenlabs_voice_id
ELEVENLABS_AGENT_ID=your_elevenlabs_agent_id

# Knowledge Base (Pinecone)
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_ENVIRONMENT=your_pinecone_environment
PINECONE_INDEX_NAME=your_pinecone_index_name

# OpenAI (for embeddings)
OPENAI_API_KEY=your_openai_api_key
```

## API Endpoints

### Inbound Agent

- `POST /api/inbound/call` - Handle incoming call webhook
- `POST /api/inbound/voice` - Process voice input from call
- `POST /api/inbound/hangup` - Handle call termination

### Outbound Agent

- `POST /api/outbound/call` - Initiate outbound call
- `GET /api/outbound/twiml/:sessionId` - Generate TwiML for call
- `POST /api/outbound/status/:sessionId` - Process call status updates
- `POST /api/outbound/speech/:sessionId` - Process speech input

### Knowledge Base

- `POST /api/knowledge` - Add item to knowledge base
- `GET /api/knowledge/query` - Query knowledge base
- `DELETE /api/knowledge/:id` - Delete item from knowledge base
- `POST /api/knowledge/batch` - Batch import to knowledge base

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. 