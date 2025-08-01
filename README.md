# SF Tennis Court Booking via Cloudflare MCP Server
<img width="1079" height="960" alt="image" src="https://github.com/user-attachments/assets/bbec40bb-2ac0-475b-ba31-03a6529fba03" />


Automate tennis court bookings on San Francisco Recreation websites using a Cloudflare MCP (Model Context Protocol) server with browser automation. Never miss your favorite court and court time again! 

It uses [Stytch](https://stytch.com) to authenticate the server so only certain emails (like mine) can book a court (in my name.)

## What This Does

This MCP server has **3 tennis booking tools**:

- **Check Court Availability** - See available time slots for any court/date
- **Book Court & Request SMS** - Automate booking flow up to SMS verification  
- **Complete Booking with SMS** - Finish booking by entering your SMS code

## Quick Deploy

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your tennis booking MCP server to: `tennis-booking.<your-account>.workers.dev/sse`

Alternatively, clone and deploy locally:
```bash
npm create cloudflare@latest -- tennis-booking-mcp --template=cloudflare/ai/demos/remote-mcp-authless
```

## How the tennis booking works

1. Check what's available:

```javascript
check_tennis_courts({
  court: "Alice Marble", 
  date: "2025-07-29", 
  time: "12:00 PM"
})
```

2. Start booking process (stops at SMS step)

```javascript
book_and_request_sms({
  court: "Alice Marble",
  time: "12:00 PM", 
  date: "2025-07-29"
})
```

3. Manual SMS + Automated Completion (User gets verification code from rec.us, types it in to MCP server message, this tool then runs)
```javascript
enter_sms_code_and_complete({code: "123456"})
```

## Setup Requirements
You need secrets for your Cloudflare Worker/MCP server:
```bash
REC_EMAIL=your-sf-rec-email@example.com
REC_PASSWORD=your-sf-rec-password
```
Your wrangler.jsonc should have: 
```jsonc
"ai": {
		"binding": "AI"
	},
	"browser": {
		"binding": "MYBROWSER"
	},
```

## Connect to MCP Clients
1. Cloudflare LLM Playground

Go to https://playground.ai.cloudflare.com/
Enter your MCP server URL: `tennis-booking.<your-account>.workers.dev/sse`
Start booking courts with natural language!

2. Claude Desktop
Install the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote) and update Claude Desktop's config:
```json
{
  "mcpServers": {
    "tennis-booking": {
      "command": "npx",
      "args": [
        "mcp-remote", 
        "https://tennis-booking.<your-account>.workers.dev/sse"
      ]
    }
  }
}
```
Now you can chat with Claude: "Book Alice Marble court for tomorrow at 2 PM" and it will handle the entire process!
